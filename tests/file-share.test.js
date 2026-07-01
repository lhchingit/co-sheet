process.env.NODE_ENV = 'test';

/**
 * @file file-share.test.js
 * @description Integration tests for file sharing with roles: a file's owner
 * searches the user database, shares the file (default role = editor), and those
 * users then see the file in their drive. Editors can modify; viewers are read-only.
 * Covers the search endpoint, the share/patch/delete endpoints and their permission
 * gating, role-driven edit rights, and the resulting visibility changes. AAA pattern.
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

test('File sharing - search users, share, and shared visibility without edit rights', async () => {
  // --- Arrange ---
  const db = await createTestDb('share');
  const PORT = '31500';
  const child = spawn('node', ['server.js'], {
    env: { ...process.env, PORT, NODE_ENV: 'test', DATABASE_URL: db.url }
  });
  child.stderr.on('data', (d) => console.error(`[Server ${PORT} STDERR] ${d.toString().trim()}`));
  await new Promise((r) => setTimeout(r, 1500));

  try {
    const alice = await loginAndRegister(PORT, 'Alice');
    const bob = await loginAndRegister(PORT, 'Bob');
    const carol = await loginAndRegister(PORT, 'Carol');
    const dave = await loginAndRegister(PORT, 'Dave'); // never shared the file

    // Alice creates a file.
    const created = await makeRequest(`http://localhost:${PORT}/api/files`, 'POST', { name: 'Plan' }, { Cookie: alice });
    const fileId = created.data.id;

    // --- Search: the owner can find other users; the owner is excluded ---
    const search = await makeRequest(`http://localhost:${PORT}/api/users/search?file=${fileId}&q=b`, 'GET', null, { Cookie: alice });
    assert.strictEqual(search.statusCode, 200);
    assert.ok(search.data.some((u) => u.id === 'bob'), 'search finds Bob');
    assert.ok(!search.data.some((u) => u.id === 'alice'), 'search excludes the owner');

    // A non-owner cannot search to share this file.
    const bobSearch = await makeRequest(`http://localhost:${PORT}/api/users/search?file=${fileId}&q=a`, 'GET', null, { Cookie: bob });
    assert.strictEqual(bobSearch.statusCode, 403, 'non-owner cannot search to share');

    // Before sharing, Bob and Carol do not see the file.
    let bobList = await makeRequest(`http://localhost:${PORT}/api/files`, 'GET', null, { Cookie: bob });
    assert.ok(!bobList.data.some((f) => f.id === fileId), 'Bob does not see the file before sharing');

    // --- Share with Bob and Carol (default role = editor) ---
    const nonOwnerShare = await makeRequest(`http://localhost:${PORT}/api/files/${fileId}/shares`, 'POST', { userIds: ['carol'] }, { Cookie: bob });
    assert.strictEqual(nonOwnerShare.statusCode, 403, 'non-owner cannot share');

    const share = await makeRequest(`http://localhost:${PORT}/api/files/${fileId}/shares`, 'POST', { userIds: ['bob', 'carol'] }, { Cookie: alice });
    assert.strictEqual(share.statusCode, 200);
    assert.strictEqual(share.data.added, 2, 'two users shared');
    assert.strictEqual(share.data.role, 'editor', 'new shares default to editor');

    // --- Shared editors see the file AND can modify it ---
    bobList = await makeRequest(`http://localhost:${PORT}/api/files`, 'GET', null, { Cookie: bob });
    const bobRow = bobList.data.find((f) => f.id === fileId);
    assert.ok(bobRow, 'Bob sees the shared file');
    assert.ok(bobRow.shared && !bobRow.owner && bobRow.canModify, 'editor share is modifiable for Bob');
    assert.strictEqual(bobRow.role, 'editor', 'Bob is an editor');

    const carolList = await makeRequest(`http://localhost:${PORT}/api/files`, 'GET', null, { Cookie: carol });
    assert.ok(carolList.data.some((f) => f.id === fileId), 'Carol sees the shared file');

    // An editor can edit cells.
    const bobEdit = await makeRequest(`http://localhost:${PORT}/api/cells?file=${fileId}`, 'POST', { cellId: 'A1', formula: '', value: 'x', style: {} }, { Cookie: bob });
    assert.strictEqual(bobEdit.statusCode, 200, 'editor share can edit');

    // --- Demote Carol to viewer: read-only, edits rejected ---
    const demote = await makeRequest(`http://localhost:${PORT}/api/files/${fileId}/shares/carol`, 'PATCH', { role: 'viewer' }, { Cookie: alice });
    assert.strictEqual(demote.statusCode, 200, 'owner can change a role');
    const carolList2 = await makeRequest(`http://localhost:${PORT}/api/files`, 'GET', null, { Cookie: carol });
    const carolRow = carolList2.data.find((f) => f.id === fileId);
    assert.ok(carolRow && !carolRow.canModify && carolRow.role === 'viewer', 'Carol is now a read-only viewer');
    const carolEdit = await makeRequest(`http://localhost:${PORT}/api/cells?file=${fileId}`, 'POST', { cellId: 'A1', formula: '', value: 'y', style: {} }, { Cookie: carol });
    assert.strictEqual(carolEdit.statusCode, 403, 'viewer share cannot edit');

    // A viewer has no modify rights, so cannot manage shares either.
    const viewerPatch = await makeRequest(`http://localhost:${PORT}/api/files/${fileId}/shares/bob`, 'PATCH', { role: 'viewer' }, { Cookie: carol });
    assert.strictEqual(viewerPatch.statusCode, 403, 'a viewer cannot change roles');

    // --- Promote Carol back to editor: edits allowed again ---
    const promote = await makeRequest(`http://localhost:${PORT}/api/files/${fileId}/shares/carol`, 'PATCH', { role: 'editor' }, { Cookie: alice });
    assert.strictEqual(promote.statusCode, 200);
    const carolEdit2 = await makeRequest(`http://localhost:${PORT}/api/cells?file=${fileId}`, 'POST', { cellId: 'B2', formula: '', value: 'z', style: {} }, { Cookie: carol });
    assert.strictEqual(carolEdit2.statusCode, 200, 'promoted editor can edit');

    // --- The owner's shares list reflects users and roles; search excludes them ---
    const shares = await makeRequest(`http://localhost:${PORT}/api/files/${fileId}/shares`, 'GET', null, { Cookie: alice });
    const sharedIds = shares.data.map((u) => u.id);
    assert.ok(sharedIds.includes('bob') && sharedIds.includes('carol'), 'shares list includes both users');
    assert.ok(shares.data.every((u) => u.role === 'editor'), 'shares list reports each role');

    const search2 = await makeRequest(`http://localhost:${PORT}/api/users/search?file=${fileId}&q=b`, 'GET', null, { Cookie: alice });
    assert.ok(!search2.data.some((u) => u.id === 'bob'), 'already-shared users are excluded from search');

    // --- Transfer ownership: Bob becomes a co-owner (a file may have many owners) ---
    const grantOwner = await makeRequest(`http://localhost:${PORT}/api/files/${fileId}/shares/bob`, 'PATCH', { role: 'owner' }, { Cookie: alice });
    assert.strictEqual(grantOwner.statusCode, 200, 'an owner can grant co-ownership');
    const bobList3 = await makeRequest(`http://localhost:${PORT}/api/files`, 'GET', null, { Cookie: bob });
    const bobOwnerRow = bobList3.data.find((f) => f.id === fileId);
    assert.ok(bobOwnerRow && bobOwnerRow.owner && bobOwnerRow.canModify && bobOwnerRow.role === 'owner', 'Bob is now a co-owner');

    // A co-owner can manage everyone's permissions.
    const coOwnerManage = await makeRequest(`http://localhost:${PORT}/api/files/${fileId}/shares/carol`, 'PATCH', { role: 'viewer' }, { Cookie: bob });
    assert.strictEqual(coOwnerManage.statusCode, 200, 'a co-owner can change roles');

    // --- General access (link_access): restricted by default, then anyone ---
    // Dave was never shared this file; by default it is restricted.
    const daveViewRestricted = await makeRequest(`http://localhost:${PORT}/api/cells?file=${fileId}`, 'GET', null, { Cookie: dave });
    assert.strictEqual(daveViewRestricted.statusCode, 403, 'a restricted file is not viewable by a non-shared user');
    const daveSheetRestricted = await makeRequest(`http://localhost:${PORT}/sheet?file=${fileId}`, 'GET', null, { Cookie: dave });
    assert.strictEqual(daveSheetRestricted.statusCode, 302, 'opening a restricted file redirects a non-shared user');

    // A non-owner cannot change general access.
    const daveSetAccess = await makeRequest(`http://localhost:${PORT}/api/files/${fileId}/access`, 'PATCH', { linkAccess: 'anyone' }, { Cookie: dave });
    assert.strictEqual(daveSetAccess.statusCode, 403, 'a non-owner cannot change general access');

    // The owner opens the file to anyone with the link.
    const openUp = await makeRequest(`http://localhost:${PORT}/api/files/${fileId}/access`, 'PATCH', { linkAccess: 'anyone' }, { Cookie: alice });
    assert.strictEqual(openUp.statusCode, 200, 'owner can set general access to anyone');
    assert.strictEqual(openUp.data.linkAccess, 'anyone');

    // Now Dave can view (read-only) but still cannot edit.
    const daveViewAnyone = await makeRequest(`http://localhost:${PORT}/api/cells?file=${fileId}`, 'GET', null, { Cookie: dave });
    assert.strictEqual(daveViewAnyone.statusCode, 200, 'anyone-with-link can view the file');
    const daveEdit = await makeRequest(`http://localhost:${PORT}/api/cells?file=${fileId}`, 'POST', { cellId: 'A1', formula: '', value: 'x', style: {} }, { Cookie: dave });
    assert.strictEqual(daveEdit.statusCode, 403, 'anyone-with-link is view-only and cannot edit');

    // The drive listing reports the current general-access mode for the owner.
    const aliceFilesAfter = await makeRequest(`http://localhost:${PORT}/api/files`, 'GET', null, { Cookie: alice });
    const alicePlanRow = aliceFilesAfter.data.find((f) => f.id === fileId);
    assert.strictEqual(alicePlanRow.linkAccess, 'anyone', 'listing reflects the linkAccess mode');

    // --- Revoke Bob's access: the file disappears from his drive ---
    const remove = await makeRequest(`http://localhost:${PORT}/api/files/${fileId}/shares/bob`, 'DELETE', null, { Cookie: alice });
    assert.strictEqual(remove.statusCode, 200, 'owner can revoke access');
    const bobList2 = await makeRequest(`http://localhost:${PORT}/api/files`, 'GET', null, { Cookie: bob });
    assert.ok(!bobList2.data.some((f) => f.id === fileId), 'Bob no longer sees the file after removal');
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 400));
    await db.cleanup();
  }
});
