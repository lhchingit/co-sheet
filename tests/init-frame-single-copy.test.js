process.env.NODE_ENV = 'test';

/**
 * @file init-frame-single-copy.test.js
 * @description The `init` frame carries the workbook ONCE. It used to send both
 * `sheets` and a `cells` alias of the first visible sheet, so a single-sheet
 * workbook went out twice — 3.16 MB instead of 1.58 MB on a 25,000-cell file, with
 * the serialize and parse costs doubled to match (#246). Covers both frames the
 * server sends: the one a connecting socket gets, and the one a version restore
 * broadcasts. Follows the AAA pattern.
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

/**
 * Opens a socket on one file and waits for its `init`. Keeps the RAW frame text as
 * well as the parsed message: the duplication this guards against is a property of
 * what goes over the wire, and a parsed object cannot show that the payload was
 * sent twice.
 *
 * Waiting for `init` rather than just `open` is what a real client does, and it is
 * required: the server finishes its access checks before it attaches a message
 * listener, so anything sent between `open` and `init` is dropped.
 */
async function connect(port, fileId, cookie) {
  const ws = new WebSocket(`ws://localhost:${port}/?file=${fileId}`, { headers: { Cookie: cookie } });
  const messages = [];
  const raw = [];
  ws.on('message', (d) => { raw.push(d.toString()); messages.push(JSON.parse(d)); });
  await new Promise((resolve, reject) => {
    const done = (fn, arg) => { clearInterval(poll); clearTimeout(timer); fn(arg); };
    const poll = setInterval(() => {
      if (messages.some((m) => m.type === 'init')) done(resolve, undefined);
    }, 25);
    const timer = setTimeout(() => done(reject, new Error('ws init timeout')), 5000);
    ws.on('error', (err) => done(reject, err));
  });
  return { ws, messages, raw };
}

/** Waits until `predicate` finds a message, or fails after `timeout` ms. */
async function waitFor(messages, predicate, timeout = 5000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const found = messages.find(predicate);
    if (found) return found;
    if (Date.now() > deadline) throw new Error('timed out waiting for a message');
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** How many times `needle` occurs in `haystack`. */
const occurrences = (haystack, needle) => haystack.split(needle).length - 1;

test('the init frame carries the workbook once, on connect and on restore', async () => {
  // --- Arrange ---
  const PORT = '31441';
  const db = await createTestDb('init-single-copy');
  const child = spawn('node', ['server.js'], {
    env: {
      ...process.env,
      PORT,
      NODE_ENV: 'test',
      DATABASE_URL: db.url,
      // Short enough that the snapshot the restore half needs is taken promptly.
      AUTOSAVE_CHECK_INTERVAL: '50',
      AUTOSAVE_INACTIVITY_LIMIT: '50',
      AUTOSAVE_ACTIVE_LIMIT: '300000'
    }
  });
  child.stderr.on('data', (d) => console.error(`[srv] ${d.toString().trim()}`));
  await waitForServer(PORT);

  let writer, peer, reader;
  try {
    // A file of this test's own: the suite shares one realtime bus, so ops on the
    // common 'default' workbook arrive here from other test files.
    const login = await makeRequest(`http://localhost:${PORT}/auth/test-login`, 'POST', { username: 'Ivy' });
    const setCookie = login.headers['set-cookie'];
    const cookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    const created = await makeRequest(`http://localhost:${PORT}/api/files`, 'POST', { name: 'Init' }, { Cookie: cookie });
    assert.strictEqual(created.statusCode, 200);
    const fileId = created.data.id;

    // A value distinctive enough that counting it in the frame is meaningful.
    const marker = 'zzmarkerzz';
    writer = await connect(PORT, fileId, cookie);
    // A peer already on the file, purely to observe. `cell-edit` fans out to
    // everyone EXCEPT the sender, so the writer never sees its own update; the
    // peer's copy is what tells us the edit has been applied. Polling for it beats
    // sleeping a fixed amount for work another process does.
    peer = await connect(PORT, fileId, cookie);
    writer.ws.send(JSON.stringify({
      type: 'cell-edit',
      payload: { cellId: 'A1', formula: '', value: marker, style: {}, sheetName: 'Sheet1' }
    }));
    await waitFor(peer.messages, (m) => m.type === 'cell-update' && m.payload.cellId === 'A1');

    // --- Act ---
    reader = await connect(PORT, fileId, cookie);
    const init = await waitFor(reader.messages, (m) => m.type === 'init');
    const initRaw = reader.raw[reader.messages.indexOf(init)];

    // --- Assert ---
    assert.strictEqual(init.payload.sheets.Sheet1.A1.value, marker, 'the workbook arrives under sheets');
    assert.strictEqual(init.payload.cells, undefined, 'and not a second time under cells');
    assert.strictEqual(
      occurrences(initRaw, marker), 1,
      'the cell appears exactly once in the frame that goes over the wire'
    );

    // --- Act: the other init frame, the one a restore broadcasts ---
    const versions = await waitForVersion(PORT, fileId, cookie);
    reader.messages.length = 0;
    reader.raw.length = 0;
    const restore = await makeRequest(
      `http://localhost:${PORT}/api/versions/${versions[0].id}/restore?file=${fileId}`,
      'POST', {}, { Cookie: cookie }
    );
    assert.strictEqual(restore.statusCode, 200, 'restore should succeed');

    // --- Assert ---
    const restoredInit = await waitFor(reader.messages, (m) => m.type === 'init');
    const restoredRaw = reader.raw[reader.messages.indexOf(restoredInit)];
    assert.strictEqual(restoredInit.payload.sheets.Sheet1.A1.value, marker, 'the restored workbook arrives under sheets');
    assert.strictEqual(restoredInit.payload.cells, undefined, 'and not a second time under cells');
    assert.strictEqual(
      occurrences(restoredRaw, marker), 1,
      'the restored cell appears exactly once in the broadcast frame'
    );
  } finally {
    for (const c of [writer, peer, reader]) {
      if (c && c.ws.readyState === WebSocket.OPEN) c.ws.close();
    }
    child.kill();
    await db.cleanup();
  }
});

/** Polls the version listing until the autosave engine has taken a snapshot. */
async function waitForVersion(port, fileId, cookie, timeout = 5000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const res = await makeRequest(`http://localhost:${port}/api/versions?file=${fileId}`, 'GET', null, { Cookie: cookie });
    if (Array.isArray(res.data) && res.data.length > 0) return res.data;
    if (Date.now() > deadline) throw new Error('timed out waiting for an autosave snapshot');
    await new Promise((r) => setTimeout(r, 100));
  }
}
