process.env.NODE_ENV = 'test';

/**
 * @file file_access.test.js
 * @description Integration tests for file-level access control: the one-file
 * creation quota for regular users (admins/super admins unlimited), file
 * ownership (creator becomes owner), and the rule that only the owner, admins,
 * and super admins may edit / rename / delete a file — over both the REST API
 * and the collaborative WebSocket channel. The shared legacy 'default' workbook
 * stays editable by any authenticated user. Follows the AAA pattern.
 */

import test from 'node:test';
import assert from 'node:assert';
import { spawn } from 'child_process';
import http from 'http';
import WebSocket from 'ws';
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

/** Open a WS, send one message, wait briefly, then close. */
async function wsSendOnce(port, fileId, message, cookie) {
  const suffix = fileId === 'default' ? '/' : `/?file=${fileId}`;
  const ws = new WebSocket(`ws://localhost:${port}${suffix}`, cookie ? { headers: { Cookie: cookie } } : undefined);
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
    setTimeout(() => reject(new Error('ws open timeout')), 2000);
  });
  await new Promise((r) => setTimeout(r, 150));
  ws.send(JSON.stringify(message));
  await new Promise((r) => setTimeout(r, 350));
  ws.close();
  await new Promise((r) => { ws.on('close', r); setTimeout(r, 300); });
}

test('File access control - ownership, one-file quota, and edit/rename/delete gating', async (t) => {
  // --- Arrange ---
  const db = await createTestDb('access');
  const PORT = '31480';
  const child = spawn('node', ['server.js'], {
    env: { ...process.env, PORT, NODE_ENV: 'test', DATABASE_URL: db.url, SUPER_ADMIN_EMAILS: 'boss' }
  });
  child.stderr.on('data', (d) => console.error(`[Server ${PORT} STDERR] ${d.toString().trim()}`));
  await new Promise((r) => setTimeout(r, 1500));

  try {
    const alice = await loginAndRegister(PORT, 'Alice');
    const bob = await loginAndRegister(PORT, 'Bob');
    const boss = await loginAndRegister(PORT, 'Boss');

    // --- Quota: a regular user may create exactly one file ---
    const f1 = await makeRequest(`http://localhost:${PORT}/api/files`, 'POST', { name: "Alice's file" }, { Cookie: alice });
    assert.strictEqual(f1.statusCode, 200, 'first file allowed');
    const aliceFile = f1.data.id;

    const f2 = await makeRequest(`http://localhost:${PORT}/api/files`, 'POST', { name: 'Second' }, { Cookie: alice });
    assert.strictEqual(f2.statusCode, 403, 'second file blocked by quota');
    assert.strictEqual(f2.data.error, 'file_limit');

    // Bob can still create his own (his quota is independent).
    const bobF = await makeRequest(`http://localhost:${PORT}/api/files`, 'POST', { name: "Bob's file" }, { Cookie: bob });
    assert.strictEqual(bobF.statusCode, 200, 'Bob owns 0 files, may create one');

    // Super admin is unlimited.
    const bossA = await makeRequest(`http://localhost:${PORT}/api/files`, 'POST', { name: 'B1' }, { Cookie: boss });
    const bossB = await makeRequest(`http://localhost:${PORT}/api/files`, 'POST', { name: 'B2' }, { Cookie: boss });
    assert.strictEqual(bossA.statusCode, 200);
    assert.strictEqual(bossB.statusCode, 200, 'super admin has no file limit');

    // --- Ownership flags in the listing ---
    const aliceList = await makeRequest(`http://localhost:${PORT}/api/files`, 'GET', null, { Cookie: alice });
    const aliceRow = aliceList.data.find((f) => f.id === aliceFile);
    assert.ok(aliceRow.owner && aliceRow.canModify, 'Alice owns and can modify her file');

    // Bob does not own and has not been shared Alice's file, so it is not listed for him.
    const bobList = await makeRequest(`http://localhost:${PORT}/api/files`, 'GET', null, { Cookie: bob });
    assert.ok(!bobList.data.some((f) => f.id === aliceFile), "Bob should not see Alice's unshared file");

    // --- Non-owner is blocked over REST ---
    const bobRename = await makeRequest(`http://localhost:${PORT}/api/files/${aliceFile}`, 'PATCH', { name: 'Hijack' }, { Cookie: bob });
    assert.strictEqual(bobRename.statusCode, 403, 'non-owner rename blocked');
    const bobEdit = await makeRequest(`http://localhost:${PORT}/api/cells?file=${aliceFile}`, 'POST', { cellId: 'A1', formula: '', value: 'x', style: {} }, { Cookie: bob });
    assert.strictEqual(bobEdit.statusCode, 403, 'non-owner cell edit blocked');
    const bobDelete = await makeRequest(`http://localhost:${PORT}/api/files/${aliceFile}`, 'DELETE', null, { Cookie: bob });
    assert.strictEqual(bobDelete.statusCode, 403, 'non-owner delete blocked');

    // --- Owner and admins are allowed ---
    const aliceEdit = await makeRequest(`http://localhost:${PORT}/api/cells?file=${aliceFile}`, 'POST', { cellId: 'A1', formula: '', value: 'owned', style: {} }, { Cookie: alice });
    assert.strictEqual(aliceEdit.statusCode, 200, 'owner may edit');
    const bossRename = await makeRequest(`http://localhost:${PORT}/api/files/${aliceFile}`, 'PATCH', { name: 'Admin renamed' }, { Cookie: boss });
    assert.strictEqual(bossRename.statusCode, 200, 'super admin may rename any file');

    // --- The shared default workbook stays open to everyone ---
    const bobDefault = await makeRequest(`http://localhost:${PORT}/api/cells`, 'POST', { cellId: 'A1', formula: '', value: 'shared', style: {} }, { Cookie: bob });
    assert.strictEqual(bobDefault.statusCode, 200, 'default workbook is editable by any user');

    // --- WebSocket enforcement on a non-default file ---
    // A guest (non-owner) edit must be ignored; the owner's edit must persist.
    await wsSendOnce(PORT, aliceFile, { type: 'cell-edit', payload: { cellId: 'Z9', formula: '', value: 'guest-wrote', style: {}, sheetName: 'Sheet1' } }, null);
    let cells = await makeRequest(`http://localhost:${PORT}/api/cells?file=${aliceFile}`, 'GET', null, { Cookie: alice });
    assert.strictEqual(cells.data.Z9, undefined, 'guest WS edit must NOT persist');

    await wsSendOnce(PORT, aliceFile, { type: 'cell-edit', payload: { cellId: 'Z9', formula: '', value: 'owner-wrote', style: {}, sheetName: 'Sheet1' } }, alice);
    cells = await makeRequest(`http://localhost:${PORT}/api/cells?file=${aliceFile}`, 'GET', null, { Cookie: alice });
    assert.ok(cells.data.Z9 && cells.data.Z9.value === 'owner-wrote', 'owner WS edit persists');
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 400));
    await db.cleanup();
  }
});
