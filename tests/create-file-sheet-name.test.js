/**
 * @file create-file-sheet-name.test.js
 * @description Integration test for POST /api/files: the single starter sheet of a
 * newly created workbook is named in the creator's UI language — "工作表1" when the
 * creator explicitly sends lang: 'zh', otherwise the legacy "Sheet1".
 */

import test from 'node:test';
import assert from 'node:assert';
import { spawn } from 'child_process';
import http from 'http';
import { createTestDb } from './helpers/db.js';

/** Minimal JSON HTTP helper (mirrors store.test.js). */
function makeRequest(url, method, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname + parsedUrl.search,
      method,
      headers: { 'Content-Type': 'application/json', ...headers }
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
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

async function loginAndGetCookie(port, username = 'Test User') {
  const loginRes = await makeRequest(`http://localhost:${port}/auth/test-login`, 'POST', { username });
  assert.strictEqual(loginRes.statusCode, 200);
  const setCookie = loginRes.headers['set-cookie'];
  assert.ok(setCookie, 'Should receive set-cookie header on successful login');
  return Array.isArray(setCookie) ? setCookie[0] : setCookie;
}

/** Create a file with the given lang and return its workbook's sheetOrder. */
async function createFileAndReadSheets(port, cookie, lang) {
  const body = { name: 'My Sheet' };
  if (lang !== undefined) body.lang = lang;
  const createRes = await makeRequest(`http://localhost:${port}/api/files`, 'POST', body, { Cookie: cookie });
  assert.strictEqual(createRes.statusCode, 200, `create should succeed (lang=${lang})`);
  const id = createRes.data.id;
  assert.ok(id, 'create should return a file id');
  const wbRes = await makeRequest(`http://localhost:${port}/api/files/${id}/workbook`, 'GET', null, { Cookie: cookie });
  assert.strictEqual(wbRes.statusCode, 200, 'workbook fetch should succeed');
  return wbRes.data.sheetOrder;
}

test('POST /api/files names the starter sheet in the creator\'s language', async () => {
  const db = await createTestDb('create-file-sheet-name');
  const PORT = 31290;
  // Make the test user a super admin so the per-user file quota (1 file for a
  // regular user) doesn't block creating several files in one run.
  const child = spawn('node', ['server.js'], {
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'test', DATABASE_URL: db.url, SUPER_ADMIN_EMAILS: 'Test User' }
  });
  await new Promise((resolve) => setTimeout(resolve, 1500));

  try {
    const cookie = await loginAndGetCookie(PORT);

    // Chinese creator → "工作表1".
    const zhOrder = await createFileAndReadSheets(PORT, cookie, 'zh');
    assert.deepStrictEqual(zhOrder, ['工作表1'], 'Chinese first sheet should be 工作表1');

    // English creator → "Sheet1".
    const enOrder = await createFileAndReadSheets(PORT, cookie, 'en');
    assert.deepStrictEqual(enOrder, ['Sheet1'], 'English first sheet should be Sheet1');

    // Missing lang stays backward-compatible with the legacy "Sheet1"
    // (localization is opt-in via an explicit lang: 'zh').
    const defaultOrder = await createFileAndReadSheets(PORT, cookie, undefined);
    assert.deepStrictEqual(defaultOrder, ['Sheet1'], 'Default first sheet should be Sheet1');
  } finally {
    child.kill();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await db.cleanup();
  }
});
