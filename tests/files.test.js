process.env.NODE_ENV = 'test';

/**
 * @file files.test.js
 * @description Integration tests for the file-management ("drive") backend:
 * the files registry CRUD endpoints, unique shareable URL generation, and
 * per-file workbook isolation (data written to one file must not leak into
 * another or into the legacy 'default' workbook). Follows the AAA pattern.
 */

import test from 'node:test';
import assert from 'node:assert';
import { spawn } from 'child_process';
import http from 'http';
import fs from 'fs';
import path from 'path';

const STORE_PATH = 'store.files.test.json';

/** Make a JSON HTTP request, optionally with headers (e.g. Cookie). */
function makeRequest(url, method, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const req = http.request({
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname + parsedUrl.search,
      method,
      headers: { 'Content-Type': 'application/json', ...headers }
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve({ statusCode: res.statusCode, headers: res.headers, data: JSON.parse(data) }); }
        catch (e) { resolve({ statusCode: res.statusCode, headers: res.headers, data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function loginAndGetCookie(port, username = 'Drive User') {
  const res = await makeRequest(`http://localhost:${port}/auth/test-login`, 'POST', { username });
  assert.strictEqual(res.statusCode, 200);
  const setCookie = res.headers['set-cookie'];
  return Array.isArray(setCookie) ? setCookie[0] : setCookie;
}

/** Remove the store file and any per-file / registry sidecars it spawned. */
function cleanupStore() {
  const dir = process.cwd();
  for (const f of fs.readdirSync(dir)) {
    if (f === STORE_PATH || f.startsWith(STORE_PATH + '.')) {
      try { fs.unlinkSync(path.join(dir, f)); } catch (e) {}
    }
  }
}

test('Files API - CRUD, unique URL, and per-file workbook isolation', async (t) => {
  // --- Arrange ---
  cleanupStore();
  const PORT = '31420';
  const child = spawn('node', ['server.js'], {
    env: { ...process.env, PORT, NODE_ENV: 'test', STORE_PATH }
  });
  child.stderr.on('data', (d) => console.error(`[Server ${PORT} STDERR] ${d.toString().trim()}`));
  await new Promise((r) => setTimeout(r, 1500));

  try {
    // Unauthenticated access is rejected.
    const unauth = await makeRequest(`http://localhost:${PORT}/api/files`, 'GET');
    assert.strictEqual(unauth.statusCode, 401, 'GET /api/files without auth should be 401');

    const cookie = await loginAndGetCookie(PORT);

    // The drive is seeded with the default file.
    const initial = await makeRequest(`http://localhost:${PORT}/api/files`, 'GET', null, { Cookie: cookie });
    assert.strictEqual(initial.statusCode, 200);
    assert.ok(Array.isArray(initial.data), 'files list should be an array');
    assert.ok(initial.data.some((f) => f.id === 'default'), 'default file should be seeded');

    // --- Act: create a new file ---
    const created = await makeRequest(`http://localhost:${PORT}/api/files`, 'POST', { name: 'Trip Plan' }, { Cookie: cookie });
    assert.strictEqual(created.statusCode, 200);
    const newId = created.data.id;
    assert.match(newId, /^[a-f0-9]{24}$/, 'new file id should be a 24-char hex token');
    assert.strictEqual(created.data.name, 'Trip Plan');
    assert.ok(created.data.url.includes(`/sheet?file=${newId}`), 'response should include a shareable URL');

    // The new file appears in the listing.
    const afterCreate = await makeRequest(`http://localhost:${PORT}/api/files`, 'GET', null, { Cookie: cookie });
    assert.ok(afterCreate.data.some((f) => f.id === newId && f.name === 'Trip Plan'), 'new file should be listed');

    // --- Per-file isolation: write a cell to the new file only ---
    const cellWrite = await makeRequest(`http://localhost:${PORT}/api/cells?file=${newId}`, 'POST', {
      cellId: 'A1', formula: '', value: 'In new file', style: {}
    }, { Cookie: cookie });
    assert.strictEqual(cellWrite.statusCode, 200);

    const newFileCells = await makeRequest(`http://localhost:${PORT}/api/cells?file=${newId}`, 'GET', null, { Cookie: cookie });
    assert.strictEqual(newFileCells.data.A1.value, 'In new file', 'cell should be readable from the new file');

    const defaultCells = await makeRequest(`http://localhost:${PORT}/api/cells`, 'GET', null, { Cookie: cookie });
    assert.strictEqual(defaultCells.data.A1, undefined, 'cell must NOT leak into the default workbook');

    // --- Rename ---
    const renamed = await makeRequest(`http://localhost:${PORT}/api/files/${newId}`, 'PATCH', { name: 'Japan Trip' }, { Cookie: cookie });
    assert.strictEqual(renamed.statusCode, 200);
    const afterRename = await makeRequest(`http://localhost:${PORT}/api/files`, 'GET', null, { Cookie: cookie });
    assert.ok(afterRename.data.some((f) => f.id === newId && f.name === 'Japan Trip'), 'file should be renamed');

    // --- Delete: invalid ids are rejected; any real file (incl. default) is deletable ---
    const delBad = await makeRequest(`http://localhost:${PORT}/api/files/not-a-valid-id`, 'DELETE', null, { Cookie: cookie });
    assert.strictEqual(delBad.statusCode, 400, 'invalid file id should be rejected');

    const del = await makeRequest(`http://localhost:${PORT}/api/files/${newId}`, 'DELETE', null, { Cookie: cookie });
    assert.strictEqual(del.statusCode, 200, 'added file should be deletable');
    const afterDelete = await makeRequest(`http://localhost:${PORT}/api/files`, 'GET', null, { Cookie: cookie });
    assert.ok(!afterDelete.data.some((f) => f.id === newId), 'deleted file should be gone');

    const delDefault = await makeRequest(`http://localhost:${PORT}/api/files/default`, 'DELETE', null, { Cookie: cookie });
    assert.strictEqual(delDefault.statusCode, 200, 'default file should also be deletable');
    const afterDeleteDefault = await makeRequest(`http://localhost:${PORT}/api/files`, 'GET', null, { Cookie: cookie });
    assert.ok(!afterDeleteDefault.data.some((f) => f.id === 'default'), 'default file should be gone after delete');
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 400));
    cleanupStore();
  }
});
