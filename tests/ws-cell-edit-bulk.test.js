process.env.NODE_ENV = 'test';

/**
 * @file ws-cell-edit-bulk.test.js
 * @description Server side of the bulk cell-edit protocol: one `cell-edit-bulk`
 * applies every entry, persists once and fans out ONE `cell-update-bulk` to peers,
 * instead of doing all three per cell. Also covers the two things a message from
 * an untrusted client can do wrong — exceed the cap, or carry a bad entry.
 * Follows the AAA pattern.
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

/** Opens a socket on one file and waits for it to be ready. */
async function connect(port, fileId, cookie) {
  const ws = new WebSocket(`ws://localhost:${port}/?file=${fileId}`, { headers: { Cookie: cookie } });
  const messages = [];
  ws.on('message', (d) => messages.push(JSON.parse(d)));
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
    setTimeout(() => reject(new Error('ws open timeout')), 3000);
  });
  return { ws, messages };
}

/** Waits until `predicate` finds a message, or fails after `timeout` ms. */
async function waitFor(messages, predicate, timeout = 3000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const found = messages.find(predicate);
    if (found) return found;
    if (Date.now() > deadline) throw new Error('timed out waiting for a message');
    await new Promise((r) => setTimeout(r, 50));
  }
}

test('cell-edit-bulk applies every cell and fans out one cell-update-bulk', async () => {
  // --- Arrange ---
  const PORT = '31391';
  const db = await createTestDb('bulkedit');
  const child = spawn('node', ['server.js'], { env: { ...process.env, PORT, NODE_ENV: 'test', DATABASE_URL: db.url } });
  child.stderr.on('data', (d) => console.error(`[srv] ${d.toString().trim()}`));
  await waitForServer(PORT);

  let a, b;
  try {
    // A file of this test's own. The realtime bus is shared by every server the
    // suite spawns, so ops on the common 'default' workbook arrive here from other
    // test files; a dedicated file id keeps this socket's traffic this test's.
    const login = await makeRequest(`http://localhost:${PORT}/auth/test-login`, 'POST', { username: 'Alice' });
    const setCookie = login.headers['set-cookie'];
    const cookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    await makeRequest(`http://localhost:${PORT}/api/me`, 'GET', null, { Cookie: cookie });
    const created = await makeRequest(`http://localhost:${PORT}/api/files`, 'POST', { name: 'Bulk' }, { Cookie: cookie });
    assert.strictEqual(created.statusCode, 200);
    const fileId = created.data.id;

    a = await connect(PORT, fileId, cookie);
    b = await connect(PORT, fileId, cookie);
    await new Promise((r) => setTimeout(r, 200));
    b.messages.length = 0;

    // --- Act ---
    a.ws.send(JSON.stringify({
      type: 'cell-edit-bulk',
      payload: {
        sheetName: 'Sheet1',
        cells: [
          { cellId: 'A1', formula: '', value: 'one', style: { bold: true } },
          { cellId: 'A2', formula: '', value: 'two', style: {} },
          { cellId: 'B1', formula: '=1+1', value: '2', style: {} }
        ]
      }
    }));

    // --- Assert ---
    const update = await waitFor(b.messages, (m) => m.type === 'cell-update-bulk');
    assert.strictEqual(
      b.messages.filter((m) => m.type === 'cell-update' || m.type === 'cell-update-bulk').length, 1,
      'the peer gets ONE message for the whole batch, not one per cell'
    );
    assert.deepStrictEqual(
      update.payload.cells.map((c) => c.cellId).sort(), ['A1', 'A2', 'B1'],
      'carrying every applied cell'
    );
    assert.strictEqual(update.payload.cells[0].sheetName, 'Sheet1', 'each entry names its sheet');

    // And the whole batch is persisted.
    let cells = {};
    const deadline = Date.now() + 5000;
    do {
      await new Promise((r) => setTimeout(r, 100));
      cells = await db.getCells(fileId, 'Sheet1');
    } while (!cells.B1 && Date.now() < deadline);
    assert.strictEqual(cells.A1.value, 'one');
    assert.deepStrictEqual(cells.A1.style, { bold: true });
    assert.strictEqual(cells.B1.formula, '=1+1');

    // --- Act: a batch over the cap is rejected whole ---
    b.messages.length = 0;
    const oversized = Array.from({ length: 501 }, (_, i) => (
      { cellId: `C${i + 1}`, formula: '', value: 'x', style: {} }
    ));
    a.ws.send(JSON.stringify({ type: 'cell-edit-bulk', payload: { sheetName: 'Sheet1', cells: oversized } }));
    await new Promise((r) => setTimeout(r, 500));

    assert.strictEqual(b.messages.length, 0, 'an over-cap batch produces no broadcast');
    const afterOversize = await db.getCells(fileId, 'Sheet1');
    assert.ok(!afterOversize.C1, 'and writes nothing — rejected whole, not clamped');

    // --- Act: one bad entry must not discard the rest ---
    b.messages.length = 0;
    a.ws.send(JSON.stringify({
      type: 'cell-edit-bulk',
      payload: {
        sheetName: 'Sheet1',
        cells: [
          { cellId: 'not a cell', formula: '', value: 'bad', style: {} },
          { cellId: 'D9', formula: '', value: 'good', style: {} }
        ]
      }
    }));

    const partial = await waitFor(b.messages, (m) => m.type === 'cell-update-bulk');
    assert.deepStrictEqual(
      partial.payload.cells.map((c) => c.cellId), ['D9'],
      'the valid cell still lands; the invalid one is skipped, not fatal'
    );
  } finally {
    if (a) { a.ws.close(); }
    if (b) { b.ws.close(); }
    child.kill();
    await new Promise((r) => setTimeout(r, 500));
    await db.cleanup();
  }
});
