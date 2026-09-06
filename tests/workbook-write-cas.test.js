process.env.NODE_ENV = 'test';

/**
 * @file workbook-write-cas.test.js
 * @description Every workbook write rewrites the WHOLE document from one instance's
 * in-memory cache, so with more than one replica a write can carry a document that
 * predates an op another replica has already persisted — silently dropping it. There
 * is no op log to replay, so the write cannot be merged; what it CAN be is visible.
 *
 * These tests pin that visibility end to end against a real server process:
 *  - the ordinary path presents the version it read and advances it, so the
 *    compare-and-set is genuinely in use rather than quietly bypassed;
 *  - when another writer has moved the row first, the edit still lands (the
 *    last-writer-wins behaviour is deliberately unchanged) AND the server says so,
 *    which is the signal that a deployment is losing edits.
 *
 * The second case is simulated by bumping `version` out of band, which is exactly
 * what another replica's write looks like from this server's point of view.
 * Follows the AAA pattern.
 */
import test from 'node:test';
import assert from 'node:assert';
import { spawn } from 'child_process';
import http from 'http';
import WebSocket from 'ws';
import { createTestDb } from './helpers/db.js';
import { waitForServer } from './helpers/wait-for-server.js';

const PORT = '31510';

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

/** Open a socket on `fileId` and resolve once its `init` payload has arrived. */
function connectClient(fileId, cookie) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/?file=${fileId}`, { headers: { Cookie: cookie } });
    ws.on('error', reject);
    ws.on('message', function onMsg(data) {
      if (JSON.parse(data.toString()).type === 'init') {
        ws.off('message', onMsg);
        resolve(ws);
      }
    });
  });
}

/** Poll until `read()` satisfies `pred`, or fail after `timeoutMs`. */
async function waitUntil(read, pred, timeoutMs, what) {
  const started = Date.now();
  for (;;) {
    const value = await read();
    if (pred(value)) return value;
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Timeout waiting for ${what} (last saw ${JSON.stringify(value)})`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

test('a workbook write presents the version it read, and reports losing the race', async () => {
  // --- Arrange ---
  const db = await createTestDb('write-cas');
  const child = spawn('node', ['server.js'], {
    env: { ...process.env, PORT, NODE_ENV: 'test', DATABASE_URL: db.url }
  });
  // pino logs one JSON object per line to stdout; the conflict warning is the point
  // of the second half of this test, so keep the stream rather than discard it.
  let stdout = '';
  child.stdout.on('data', (d) => { stdout += d.toString(); });
  child.stderr.on('data', (d) => console.error(`[srv] ${d.toString().trim()}`));
  await waitForServer(PORT);

  // Filled in once the file is created; the readers below close over it.
  const fileIdRef = { value: '' };
  const version = () => db.query('SELECT version FROM workbook_state WHERE key = $1', [fileIdRef.value])
    .then((r) => (r.rows[0] ? Number(r.rows[0].version) : null));
  const cellValue = async (cellId) => {
    const cells = await db.getCells(fileIdRef.value, 'Sheet1');
    return cells && cells[cellId] ? cells[cellId].value : undefined;
  };

  let ws;
  try {
    const login = await makeRequest(`http://localhost:${PORT}/auth/test-login`, 'POST', { username: 'Alice' });
    const setCookie = login.headers['set-cookie'];
    const cookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;

    const created = await makeRequest(`http://localhost:${PORT}/api/files`, 'POST', { name: 'CAS' }, { Cookie: cookie });
    assert.strictEqual(created.statusCode, 200);
    fileIdRef.value = created.data.id;

    assert.strictEqual(await version(), 0, 'a newly created workbook row starts at version 0');
    ws = await connectClient(fileIdRef.value, cookie);

    // --- Act: an ordinary edit. ---
    ws.send(JSON.stringify({
      type: 'cell-edit',
      payload: { cellId: 'A1', formula: '', value: 'one', style: {}, sheetName: 'Sheet1' }
    }));

    // --- Assert: it persisted, and it went through the compare-and-set. ---
    await waitUntil(cellValue.bind(null, 'A1'), (v) => v === 'one', 4000, 'the first edit to persist');
    assert.strictEqual(await version(), 1, 'a winning write advances the stored version exactly once');
    assert.ok(
      !stdout.includes('Workbook write conflict'),
      'a single instance writing alone must never report a conflict'
    );

    // --- Act: another replica writes the row behind this server's back. ---
    // The server still believes the row is at version 1, which is precisely the
    // situation two replicas holding the same file produce.
    await db.query('UPDATE workbook_state SET version = version + 1 WHERE key = $1', [fileIdRef.value]);
    ws.send(JSON.stringify({
      type: 'cell-edit',
      payload: { cellId: 'B2', formula: '', value: 'two', style: {}, sheetName: 'Sheet1' }
    }));

    // --- Assert: the edit is not lost — the behaviour is still last writer wins... ---
    await waitUntil(cellValue.bind(null, 'B2'), (v) => v === 'two', 4000, 'the conflicting edit to persist');

    // --- ...but it is no longer silent. ---
    await waitUntil(async () => stdout, (s) => s.includes('Workbook write conflict'), 4000, 'the conflict warning');
    const warning = stdout.split('\n').filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .find((entry) => entry && typeof entry.msg === 'string' && entry.msg.includes('Workbook write conflict'));
    assert.ok(warning, 'the conflict is logged as structured JSON, not free text');
    assert.strictEqual(warning.level, 40, 'a possible lost update is a warning, not an info line');
    assert.strictEqual(warning.key, fileIdRef.value, 'the log names the workbook that collided');
    assert.strictEqual(warning.expected, 1, 'it records the version this instance thought it held');
    assert.strictEqual(warning.found, 2, 'and the version it actually found');

    // A further edit works from the version the retry settled on, so one collision
    // does not wedge the file into conflicting forever.
    ws.send(JSON.stringify({
      type: 'cell-edit',
      payload: { cellId: 'C3', formula: '', value: 'three', style: {}, sheetName: 'Sheet1' }
    }));
    await waitUntil(cellValue.bind(null, 'C3'), (v) => v === 'three', 4000, 'the edit after the conflict to persist');
    const conflicts = stdout.split('Workbook write conflict').length - 1;
    assert.strictEqual(conflicts, 1, 'the instance re-synced, so the next write does not collide again');
  } finally {
    if (ws) ws.close();
    child.kill();
    await new Promise((r) => setTimeout(r, 400));
    await db.cleanup();
  }
});
