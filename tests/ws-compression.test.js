process.env.NODE_ENV = 'test';

/**
 * @file ws-compression.test.js
 * @description The `init` frame carries the entire workbook and was going out
 * uncompressed on every connect. permessage-deflate is now negotiated (tuned for
 * per-connection memory, see the WebSocketServer options). Verifies the extension
 * is actually negotiated and that a workbook of real size survives the round trip
 * through it unchanged — compression that corrupted a payload would be worse than
 * none. Follows the AAA pattern.
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

/** Connects and resolves with the socket and its init payload. */
async function connectAndInit(port, fileId, cookie) {
  const ws = new WebSocket(`ws://localhost:${port}/?file=${fileId}`, { headers: { Cookie: cookie } });
  const init = await new Promise((resolve, reject) => {
    ws.on('message', (d) => {
      const msg = JSON.parse(d);
      if (msg.type === 'init') resolve(msg.payload);
    });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('timed out waiting for init')), 5000);
  });
  return { ws, init };
}

/**
 * Connect once the workbook actually holds `expected` cells on `sheet`.
 *
 * The edit that fills it is applied asynchronously by the server, and how long
 * that takes is not this test's to guess: a fixed sleep here raced a loaded runner
 * and failed on a workbook that was filled correctly a moment later (#204). So
 * connect, and if the payload is short, close and try again until it is not.
 */
async function connectWhenFilled(port, fileId, cookie, sheet, expected, timeout = 10000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const conn = await connectAndInit(port, fileId, cookie);
    const cells = (conn.init.sheets && conn.init.sheets[sheet]) || {};
    if (Object.keys(cells).length >= expected) return conn;
    conn.ws.close();
    if (Date.now() > deadline) {
      throw new Error(`workbook still had ${Object.keys(cells).length} of ${expected} cells`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

test('the workbook init frame is deflated, and survives the round trip intact', async () => {
  // --- Arrange ---
  const PORT = '31405';
  const db = await createTestDb('wsdeflate');
  const child = spawn('node', ['server.js'], { env: { ...process.env, PORT, NODE_ENV: 'test', DATABASE_URL: db.url } });
  child.stderr.on('data', (d) => console.error(`[srv] ${d.toString().trim()}`));
  await waitForServer(PORT);

  const CELLS = 400;
  let writer, reader;
  try {
    const login = await makeRequest(`http://localhost:${PORT}/auth/test-login`, 'POST', { username: 'Alice' });
    const setCookie = login.headers['set-cookie'];
    const cookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    await makeRequest(`http://localhost:${PORT}/api/me`, 'GET', null, { Cookie: cookie });
    const created = await makeRequest(`http://localhost:${PORT}/api/files`, 'POST', { name: 'Big' }, { Cookie: cookie });
    const fileId = created.data.id;

    // Fill the workbook so `init` is a payload worth compressing.
    writer = await connectAndInit(PORT, fileId, cookie);
    writer.ws.send(JSON.stringify({
      type: 'cell-edit-bulk',
      payload: {
        sheetName: 'Sheet1',
        cells: Array.from({ length: CELLS }, (_, i) => ({
          cellId: `A${i + 1}`, formula: '', value: `row ${i + 1} of the workbook`, style: { bold: true, fontSize: 11 }
        }))
      }
    }));

    // --- Act: a fresh connection receives the whole workbook in one frame ---
    reader = await connectWhenFilled(PORT, fileId, cookie, 'Sheet1', CELLS);

    // --- Assert ---
    assert.match(
      reader.ws.extensions, /permessage-deflate/,
      'the connection negotiated permessage-deflate'
    );
    const cells = reader.init.sheets.Sheet1;
    assert.strictEqual(Object.keys(cells).length, CELLS, 'every cell arrived');
    assert.strictEqual(cells.A1.value, 'row 1 of the workbook', 'first cell intact');
    assert.strictEqual(cells[`A${CELLS}`].value, `row ${CELLS} of the workbook`, 'last cell intact');
    assert.deepStrictEqual(cells.A7.style, { bold: true, fontSize: 11 }, 'styles intact');

    // Small frames still work alongside it (they fall under the compression
    // threshold, which is the point of setting one).
    const seen = [];
    reader.ws.on('message', (d) => seen.push(JSON.parse(d)));
    writer.ws.send(JSON.stringify({
      type: 'cell-edit',
      payload: { cellId: 'Z9', formula: '', value: 'small', style: {}, sheetName: 'Sheet1' }
    }));
    const deadline = Date.now() + 3000;
    while (!seen.some((m) => m.type === 'cell-update' && m.payload.cellId === 'Z9') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(
      seen.some((m) => m.type === 'cell-update' && m.payload.cellId === 'Z9'),
      'a small frame still round-trips on the same connection'
    );
  } finally {
    if (writer) writer.ws.close();
    if (reader) reader.ws.close();
    child.kill();
    await new Promise((r) => setTimeout(r, 500));
    await db.cleanup();
  }
});
