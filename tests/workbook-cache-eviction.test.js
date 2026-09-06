process.env.NODE_ENV = 'test';

/**
 * @file workbook-cache-eviction.test.js
 * @description The in-memory workbook cache follows the files being worked on. A
 * cached workbook is ~4 MB of heap for 25,000 cells and every route that touches a
 * file caches it (download included), so without eviction an instance accumulates
 * every file it has ever served for the life of the process (#247).
 *
 * Observed through the `cached_workbooks` gauge on the metrics port, which is the
 * production-visible form of the same fact. Follows the AAA pattern.
 */
import test from 'node:test';
import assert from 'node:assert';
import { spawn } from 'child_process';
import http from 'http';
import WebSocket from 'ws';
import { createTestDb } from './helpers/db.js';
import { waitForServer } from './helpers/wait-for-server.js';

function makeRequest(url, method, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: { 'Content-Type': 'application/json', ...headers }
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve({ statusCode: res.statusCode, data: JSON.parse(data), headers: res.headers }); }
        catch (e) { resolve({ statusCode: res.statusCode, data, headers: res.headers }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/** Scrapes the metrics port and returns the value of the `cached_workbooks` gauge. */
async function cachedWorkbooks(metricsPort) {
  const body = await new Promise((resolve, reject) => {
    const req = http.get(`http://localhost:${metricsPort}/metrics`, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
  });
  const line = body.split('\n').find((l) => l.startsWith('cached_workbooks{') || l.startsWith('cached_workbooks '));
  assert.ok(line, 'the metrics output should carry a cached_workbooks gauge');
  return Number(line.slice(line.lastIndexOf(' ') + 1));
}

/** Opens a socket on one file and waits for its `init` (see init-frame-single-copy). */
async function connect(port, fileId, cookie) {
  const ws = new WebSocket(`ws://localhost:${port}/?file=${fileId}`, { headers: { Cookie: cookie } });
  const messages = [];
  ws.on('message', (d) => messages.push(JSON.parse(d)));
  await new Promise((resolve, reject) => {
    const done = (fn, arg) => { clearInterval(poll); clearTimeout(timer); fn(arg); };
    const poll = setInterval(() => {
      if (messages.some((m) => m.type === 'init')) done(resolve, undefined);
    }, 25);
    const timer = setTimeout(() => done(reject, new Error('ws init timeout')), 5000);
    ws.on('error', (err) => done(reject, err));
  });
  return { ws, messages };
}

/** Polls `read` until it satisfies `predicate`, or fails after `timeout` ms. */
async function pollUntil(read, predicate, what, timeout = 5000) {
  const deadline = Date.now() + timeout;
  let last;
  for (;;) {
    last = await read();
    if (predicate(last)) return last;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what} (last: ${last})`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

test('an idle workbook leaves the cache, and its edits survive the eviction', async () => {
  // --- Arrange ---
  const PORT = '31445';
  const METRICS_PORT = '31446';
  const db = await createTestDb('wb-evict');
  const child = spawn('node', ['server.js'], {
    env: {
      ...process.env,
      PORT,
      METRICS_PORT,
      NODE_ENV: 'test',
      DATABASE_URL: db.url,
      // The sweep rides the autosave tick, so both have to be short for the test to
      // observe an eviction without sleeping for the production window.
      AUTOSAVE_CHECK_INTERVAL: '100',
      AUTOSAVE_INACTIVITY_LIMIT: '50',
      AUTOSAVE_ACTIVE_LIMIT: '300000',
      WORKBOOK_IDLE_EVICT_MS: '200'
    }
  });
  child.stderr.on('data', (d) => console.error(`[srv] ${d.toString().trim()}`));
  await waitForServer(PORT);

  let writer, peer, reader;
  try {
    // A file of this test's own. The legacy 'default' workbook never enters this
    // cache (it lives in `sheetState`), so the gauge counts only real files — and
    // this is the only one this server has been asked for.
    const login = await makeRequest(`http://localhost:${PORT}/auth/test-login`, 'POST', { username: 'Otto' });
    const setCookie = login.headers['set-cookie'];
    const cookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    const created = await makeRequest(`http://localhost:${PORT}/api/files`, 'POST', { name: 'Evict' }, { Cookie: cookie });
    assert.strictEqual(created.statusCode, 200);
    const fileId = created.data.id;

    writer = await connect(PORT, fileId, cookie);
    // `cell-edit` fans out to everyone except the sender, so a peer is what tells
    // us the edit has been applied.
    peer = await connect(PORT, fileId, cookie);
    writer.ws.send(JSON.stringify({
      type: 'cell-edit',
      payload: { cellId: 'A1', formula: '', value: 'survives', style: {}, sheetName: 'Sheet1' }
    }));
    await pollUntil(
      async () => peer.messages.some((m) => m.type === 'cell-update' && m.payload.cellId === 'A1'),
      (found) => found, 'the edit to be applied'
    );

    // --- Assert: an attached file is never swept, however long it sits idle ---
    // Several sweep ticks and several idle windows, with sockets still open.
    await new Promise((r) => setTimeout(r, 600));
    assert.strictEqual(
      await cachedWorkbooks(METRICS_PORT), 1,
      'a file someone is connected to stays cached no matter how idle it is'
    );

    // --- Act: everyone leaves ---
    for (const c of [writer, peer]) {
      c.ws.close();
      await new Promise((r) => c.ws.on('close', r));
    }

    // --- Assert ---
    await pollUntil(() => cachedWorkbooks(METRICS_PORT), (n) => n === 0, 'the cache to drain');

    // The point of the cache is speed, not durability: the edit must still be there
    // when the file is next opened, re-loaded from Postgres.
    reader = await connect(PORT, fileId, cookie);
    const init = reader.messages.find((m) => m.type === 'init');
    assert.strictEqual(
      init.payload.sheets.Sheet1.A1.value, 'survives',
      'the evicted workbook comes back from the database intact'
    );
    assert.strictEqual(
      await cachedWorkbooks(METRICS_PORT), 1,
      'and re-opening it caches it again'
    );
  } finally {
    for (const c of [writer, peer, reader]) {
      if (c && c.ws.readyState === WebSocket.OPEN) c.ws.close();
    }
    child.kill();
    await db.cleanup();
  }
});
