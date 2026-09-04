process.env.NODE_ENV = 'test';

/**
 * @file workbook-write-coalescing.test.js
 * @description Every state-changing message persists the whole workbook, and bulk
 * edits arrive as one message per cell, so those writes are coalesced per file
 * (see services/workbook-writer.js). This pins the guarantee that makes the
 * coalescing safe end-to-end: after a burst, the row on disk holds the FINAL
 * state — the trailing write is never dropped. Exercised on a real user file,
 * the path that previously had no coalescing at all. Follows the AAA pattern.
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

test('a burst of cell edits is fully persisted, on a user file and on default', async () => {
  // --- Arrange ---
  const PORT = '31381';
  const db = await createTestDb('coalesce');
  const child = spawn('node', ['server.js'], { env: { ...process.env, PORT, NODE_ENV: 'test', DATABASE_URL: db.url } });
  child.stderr.on('data', (d) => console.error(`[srv] ${d.toString().trim()}`));
  await waitForServer(PORT);

  const BURST = 200; // one message per cell, the shape a paste / bulk format sends

  try {
    const login = await makeRequest(`http://localhost:${PORT}/auth/test-login`, 'POST', { username: 'Alice' });
    const setCookie = login.headers['set-cookie'];
    const cookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    await makeRequest(`http://localhost:${PORT}/api/me`, 'GET', null, { Cookie: cookie });

    const created = await makeRequest(`http://localhost:${PORT}/api/files`, 'POST', { name: 'Burst' }, { Cookie: cookie });
    assert.strictEqual(created.statusCode, 200);
    const fileId = created.data.id;

    for (const target of [{ id: fileId, suffix: `/?file=${fileId}` }, { id: 'default', suffix: '/' }]) {
      const ws = new WebSocket(`ws://localhost:${PORT}${target.suffix}`, { headers: { Cookie: cookie } });
      await new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
        setTimeout(() => reject(new Error('ws open timeout')), 3000);
      });
      await new Promise((r) => setTimeout(r, 150));

      // --- Act ---
      // Fire the whole burst without pausing, so every message after the first
      // lands while a write is already in flight — the coalescing window.
      for (let r = 1; r <= BURST; r++) {
        ws.send(JSON.stringify({
          type: 'cell-edit',
          payload: { cellId: `A${r}`, formula: '', value: `v${r}`, style: { bold: true } }
        }));
      }

      // --- Assert ---
      // Poll rather than sleep a fixed amount: the trailing write lands once the
      // in-flight one finishes, and how long that takes is the DB's business.
      let cells = {};
      const deadline = Date.now() + 10000;
      do {
        await new Promise((r) => setTimeout(r, 100));
        cells = await db.getCells(target.id, 'Sheet1');
      } while (Object.keys(cells).length < BURST && Date.now() < deadline);

      assert.strictEqual(
        Object.keys(cells).length, BURST,
        `every cell of the burst reached the database for ${target.id} (the trailing write is not dropped)`
      );
      // Not just the count — the last edit specifically, since a dropped trailing
      // write would lose precisely the newest values.
      assert.strictEqual(cells[`A${BURST}`].value, `v${BURST}`, 'the final edit is the one on disk');
      assert.deepStrictEqual(cells.A1.style, { bold: true }, 'and the first is intact too');

      ws.close();
      await new Promise((resolve) => ws.on('close', resolve));
    }
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 500));
    await db.cleanup();
  }
});
