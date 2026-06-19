process.env.NODE_ENV = 'test';

/**
 * @file file_star.test.js
 * @description Integration tests for per-user file starring (PUT /api/files/:id/star).
 * Starring is a personal favourite: it requires only view access, is tracked
 * separately per user (Alice starring a file does not star it for Bob), and is
 * surfaced as a `starred` flag on each /api/files row (driving the drive's
 * "Starred" view). The shared 'default' workbook can be starred by anyone.
 * Follows the AAA pattern.
 */

import test from 'node:test';
import assert from 'node:assert';
import { spawn } from 'child_process';
import http from 'http';
import { createTestDb } from './helpers/db.js';

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
        try { resolve({ statusCode: res.statusCode, headers: res.headers, data: JSON.parse(data) }); }
        catch (e) { resolve({ statusCode: res.statusCode, headers: res.headers, data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function loginAndRegister(port, username) {
  const res = await makeRequest(`http://localhost:${port}/auth/test-login`, 'POST', { username });
  assert.strictEqual(res.statusCode, 200);
  const setCookie = res.headers['set-cookie'];
  const cookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  await makeRequest(`http://localhost:${port}/api/me`, 'GET', null, { Cookie: cookie });
  return cookie;
}

const rowFor = (list, id) => (Array.isArray(list) ? list.find((f) => f.id === id) : null);

test('File starring - per-user favourites, view-access gating, and starred flag', async (t) => {
  // --- Arrange ---
  const db = await createTestDb('star');
  const PORT = '31490';
  const child = spawn('node', ['server.js'], {
    env: { ...process.env, PORT, NODE_ENV: 'test', DATABASE_URL: db.url, SUPER_ADMIN_EMAILS: 'boss' }
  });
  child.stderr.on('data', (d) => console.error(`[Server ${PORT} STDERR] ${d.toString().trim()}`));
  await new Promise((r) => setTimeout(r, 1500));

  try {
    const alice = await loginAndRegister(PORT, 'Alice');
    const bob = await loginAndRegister(PORT, 'Bob');

    const created = await makeRequest(`http://localhost:${PORT}/api/files`, 'POST', { name: "Alice's file" }, { Cookie: alice });
    assert.strictEqual(created.statusCode, 200);
    const fileId = created.data.id;

    // --- Default is unstarred ---
    let aliceList = await makeRequest(`http://localhost:${PORT}/api/files`, 'GET', null, { Cookie: alice });
    assert.strictEqual(rowFor(aliceList.data, fileId).starred, false, 'new file starts unstarred');

    // --- Owner stars the file ---
    const star = await makeRequest(`http://localhost:${PORT}/api/files/${fileId}/star`, 'PUT', { starred: true }, { Cookie: alice });
    assert.strictEqual(star.statusCode, 200);
    assert.strictEqual(star.data.starred, true);
    aliceList = await makeRequest(`http://localhost:${PORT}/api/files`, 'GET', null, { Cookie: alice });
    assert.strictEqual(rowFor(aliceList.data, fileId).starred, true, 'file is now starred for Alice');

    // --- Starring without access is forbidden ---
    const bobNoAccess = await makeRequest(`http://localhost:${PORT}/api/files/${fileId}/star`, 'PUT', { starred: true }, { Cookie: bob });
    assert.strictEqual(bobNoAccess.statusCode, 403, 'Bob cannot star a file he cannot view');

    // --- Starring is per-user: share with Bob, his view shows it unstarred ---
    const share = await makeRequest(`http://localhost:${PORT}/api/files/${fileId}/shares`, 'POST', { userIds: ['bob'] }, { Cookie: alice });
    assert.strictEqual(share.statusCode, 200);
    let bobList = await makeRequest(`http://localhost:${PORT}/api/files`, 'GET', null, { Cookie: bob });
    assert.strictEqual(rowFor(bobList.data, fileId).starred, false, "Alice's star does not carry over to Bob");

    // Bob stars it independently; Alice's state is unaffected.
    const bobStar = await makeRequest(`http://localhost:${PORT}/api/files/${fileId}/star`, 'PUT', { starred: true }, { Cookie: bob });
    assert.strictEqual(bobStar.statusCode, 200, 'a shared viewer may star (view access is enough)');
    bobList = await makeRequest(`http://localhost:${PORT}/api/files`, 'GET', null, { Cookie: bob });
    assert.strictEqual(rowFor(bobList.data, fileId).starred, true, 'file starred for Bob');

    // --- Unstar reverts the flag ---
    const unstar = await makeRequest(`http://localhost:${PORT}/api/files/${fileId}/star`, 'PUT', { starred: false }, { Cookie: alice });
    assert.strictEqual(unstar.statusCode, 200);
    assert.strictEqual(unstar.data.starred, false);
    aliceList = await makeRequest(`http://localhost:${PORT}/api/files`, 'GET', null, { Cookie: alice });
    assert.strictEqual(rowFor(aliceList.data, fileId).starred, false, 'Alice unstarred');
    bobList = await makeRequest(`http://localhost:${PORT}/api/files`, 'GET', null, { Cookie: bob });
    assert.strictEqual(rowFor(bobList.data, fileId).starred, true, "Bob's star is unaffected by Alice unstarring");

    // --- The shared 'default' workbook can be starred by anyone ---
    const starDefault = await makeRequest(`http://localhost:${PORT}/api/files/default/star`, 'PUT', { starred: true }, { Cookie: bob });
    assert.strictEqual(starDefault.statusCode, 200, 'default workbook is viewable, so starrable');
    bobList = await makeRequest(`http://localhost:${PORT}/api/files`, 'GET', null, { Cookie: bob });
    assert.strictEqual(rowFor(bobList.data, 'default').starred, true, 'default starred for Bob');
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 400));
    await db.cleanup();
  }
});
