process.env.NODE_ENV = 'test';

/**
 * @file permissions.test.js
 * @description Integration tests for the role-based permissions feature backing
 * the file-management permissions page: super admins are bootstrapped from the
 * SUPER_ADMIN_EMAILS environment variable, /api/me reports the caller's role and
 * records the login, and /api/users + PATCH /api/users/:id are gated to admins
 * with guardrails (no self-edit, super admins immutable, role limited to
 * user/admin). Follows the AAA pattern and the spawn-real-server style used by
 * the other integration suites.
 */

import test from 'node:test';
import assert from 'node:assert';
import { spawn } from 'child_process';
import http from 'http';
import fs from 'fs';
import path from 'path';

const STORE_PATH = 'store.perms.test.json';

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

async function loginCookie(port, username) {
  const res = await makeRequest(`http://localhost:${port}/auth/test-login`, 'POST', { username });
  assert.strictEqual(res.statusCode, 200);
  const setCookie = res.headers['set-cookie'];
  return Array.isArray(setCookie) ? setCookie[0] : setCookie;
}

/** Log in and hit /api/me (which records the login) — returns { cookie, me }. */
async function loginAndRegister(port, username) {
  const cookie = await loginCookie(port, username);
  const me = await makeRequest(`http://localhost:${port}/api/me`, 'GET', null, { Cookie: cookie });
  assert.strictEqual(me.statusCode, 200);
  return { cookie, me: me.data };
}

function cleanupStore() {
  const dir = process.cwd();
  for (const f of fs.readdirSync(dir)) {
    if (f === STORE_PATH || f.startsWith(STORE_PATH + '.')) {
      try { fs.unlinkSync(path.join(dir, f)); } catch (e) {}
    }
  }
}

test('Permissions - RBAC roles, env super admin bootstrap, and role-change guardrails', async (t) => {
  // --- Arrange ---
  cleanupStore();
  const PORT = '31460';
  const child = spawn('node', ['server.js'], {
    env: { ...process.env, PORT, NODE_ENV: 'test', STORE_PATH, SUPER_ADMIN_EMAILS: 'boss,root' }
  });
  child.stderr.on('data', (d) => console.error(`[Server ${PORT} STDERR] ${d.toString().trim()}`));
  await new Promise((r) => setTimeout(r, 1500));

  try {
    // Super admins are bootstrapped from the environment.
    const boss = await loginAndRegister(PORT, 'Boss');
    assert.strictEqual(boss.me.role, 'superadmin', 'env-listed user should be superadmin');

    const root = await loginAndRegister(PORT, 'Root');
    assert.strictEqual(root.me.role, 'superadmin', 'second env-listed user should be superadmin');

    // Everyone else defaults to 'user'.
    const carol = await loginAndRegister(PORT, 'Carol');
    assert.strictEqual(carol.me.role, 'user', 'non-listed user should default to user');

    const eve = await loginAndRegister(PORT, 'Eve');
    assert.strictEqual(eve.me.role, 'user');

    // --- Access control on the users list ---
    const unauth = await makeRequest(`http://localhost:${PORT}/api/users`, 'GET');
    assert.strictEqual(unauth.statusCode, 401, 'unauthenticated list should be 401');

    const eveList = await makeRequest(`http://localhost:${PORT}/api/users`, 'GET', null, { Cookie: eve.cookie });
    assert.strictEqual(eveList.statusCode, 403, 'a plain user must not list users');

    const bossList = await makeRequest(`http://localhost:${PORT}/api/users`, 'GET', null, { Cookie: boss.cookie });
    assert.strictEqual(bossList.statusCode, 200);
    assert.strictEqual(bossList.data.role, 'superadmin');
    const ids = bossList.data.users.map((u) => u.id);
    assert.ok(ids.includes('boss') && ids.includes('carol') && ids.includes('eve'), 'all signed-in users listed');
    const bossRow = bossList.data.users.find((u) => u.id === 'boss');
    assert.ok(bossRow.superAdmin && bossRow.self, 'boss row flagged superAdmin + self');

    // --- Super admin promotes a user to admin ---
    const promote = await makeRequest(`http://localhost:${PORT}/api/users/carol`, 'PATCH', { role: 'admin' }, { Cookie: boss.cookie });
    assert.strictEqual(promote.statusCode, 200);
    assert.strictEqual(promote.data.role, 'admin');

    // Carol now sees the admin role on her next /api/me, and can list users.
    const carolMe2 = await makeRequest(`http://localhost:${PORT}/api/me`, 'GET', null, { Cookie: carol.cookie });
    assert.strictEqual(carolMe2.data.role, 'admin', 'promoted user becomes admin');
    const carolList = await makeRequest(`http://localhost:${PORT}/api/users`, 'GET', null, { Cookie: carol.cookie });
    assert.strictEqual(carolList.statusCode, 200, 'admin can list users');

    // --- Guardrails ---
    // Cannot grant the env-only superadmin role.
    const grantSuper = await makeRequest(`http://localhost:${PORT}/api/users/eve`, 'PATCH', { role: 'superadmin' }, { Cookie: boss.cookie });
    assert.strictEqual(grantSuper.statusCode, 400, 'superadmin cannot be granted via API');

    // Cannot change your own role.
    const selfEdit = await makeRequest(`http://localhost:${PORT}/api/users/boss`, 'PATCH', { role: 'user' }, { Cookie: boss.cookie });
    assert.strictEqual(selfEdit.statusCode, 400, 'cannot change own role');

    // Cannot modify another super admin.
    const modSuper = await makeRequest(`http://localhost:${PORT}/api/users/root`, 'PATCH', { role: 'user' }, { Cookie: boss.cookie });
    assert.strictEqual(modSuper.statusCode, 403, 'super admins are immutable');

    // Unknown target is 404.
    const missing = await makeRequest(`http://localhost:${PORT}/api/users/nobody`, 'PATCH', { role: 'admin' }, { Cookie: boss.cookie });
    assert.strictEqual(missing.statusCode, 404);

    // A plain user cannot change roles at all.
    const evePatch = await makeRequest(`http://localhost:${PORT}/api/users/carol`, 'PATCH', { role: 'user' }, { Cookie: eve.cookie });
    assert.strictEqual(evePatch.statusCode, 403, 'plain users cannot change roles');

    // An admin (Carol) can demote another user-or-admin (revert Carol's grant of Eve).
    await makeRequest(`http://localhost:${PORT}/api/users/eve`, 'PATCH', { role: 'admin' }, { Cookie: carol.cookie });
    const demote = await makeRequest(`http://localhost:${PORT}/api/users/eve`, 'PATCH', { role: 'user' }, { Cookie: carol.cookie });
    assert.strictEqual(demote.statusCode, 200, 'admin can adjust non-super roles');
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 400));
    cleanupStore();
  }
});
