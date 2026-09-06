process.env.NODE_ENV = 'test';

/**
 * @file broadcast-file-isolation.test.js
 * @description Edits and presence reach the sockets on their own file and no
 * others. The server used to find those sockets by walking every connection it
 * held and comparing file ids; it now keeps an index of file -> sockets (#256), so
 * the property that used to fall out of a filter is now something the index has to
 * get right — and stay right as sockets come and go.
 *
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

/** Opens a socket on one file and waits for its `init`. */
async function connect(port, fileId, cookie) {
  const ws = new WebSocket(`ws://localhost:${port}/?file=${fileId}`, { headers: { Cookie: cookie } });
  const messages = [];
  ws.on('message', (d) => messages.push(JSON.parse(d)));
  await new Promise((resolve, reject) => {
    const done = (fn, arg) => { clearInterval(poll); clearTimeout(timer); fn(arg); };
    const poll = setInterval(() => {
      if (messages.some((m) => m.type === 'init')) done(resolve, undefined);
    }, 25);
    const timer = setTimeout(() => done(reject, new Error('ws init timeout')), 5000);
    ws.on('error', (err) => done(reject, err));
  });
  return { ws, messages };
}

/** Waits until `predicate` finds a message, or fails after `timeout` ms. */
async function waitFor(messages, predicate, what, timeout = 5000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const found = messages.find(predicate);
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

test('a file\'s edits and presence stay on that file', async () => {
  // --- Arrange ---
  const PORT = '31448';
  const db = await createTestDb('bcast-isolation');
  const child = spawn('node', ['server.js'], {
    // Ada is a super admin so one account can own both files; a regular user's
    // quota is one.
    env: { ...process.env, PORT, NODE_ENV: 'test', DATABASE_URL: db.url, SUPER_ADMIN_EMAILS: 'ada' }
  });
  child.stderr.on('data', (d) => console.error(`[srv] ${d.toString().trim()}`));
  await waitForServer(PORT);

  let a1, a2, b1;
  try {
    const login = await makeRequest(`http://localhost:${PORT}/auth/test-login`, 'POST', { username: 'Ada' });
    const cookie = [].concat(login.headers['set-cookie'])[0];
    const fileA = (await makeRequest(`http://localhost:${PORT}/api/files`, 'POST', { name: 'A' }, { Cookie: cookie })).data.id;
    const fileB = (await makeRequest(`http://localhost:${PORT}/api/files`, 'POST', { name: 'B' }, { Cookie: cookie })).data.id;
    assert.ok(fileA && fileB && fileA !== fileB, 'two distinct files');

    a1 = await connect(PORT, fileA, cookie);
    a2 = await connect(PORT, fileA, cookie);
    b1 = await connect(PORT, fileB, cookie);

    // --- Assert: the roster in `init` is scoped to the file ---
    const rosterB = b1.messages.find((m) => m.type === 'init').payload.users;
    assert.strictEqual(rosterB.length, 1, "file B's roster holds only its own socket");
    assert.strictEqual(rosterB[0].userId, b1.messages.find((m) => m.type === 'init').payload.self.userId);

    a2.messages.length = 0;
    b1.messages.length = 0;

    // --- Act: an edit on file A ---
    a1.ws.send(JSON.stringify({
      type: 'cell-edit',
      payload: { cellId: 'A1', formula: '', value: 'only for A', style: {}, sheetName: 'Sheet1' }
    }));

    // --- Assert ---
    const update = await waitFor(a2.messages, (m) => m.type === 'cell-update', "A's peer to see the edit");
    assert.strictEqual(update.payload.value, 'only for A');
    // Absence cannot be polled for, so this one waits: by the time A's peer has the
    // message, anything headed for B has had its chance.
    await new Promise((r) => setTimeout(r, 300));
    assert.deepStrictEqual(
      b1.messages.filter((m) => m.type === 'cell-update' || m.type === 'cell-update-bulk'), [],
      'a socket on another file hears nothing'
    );

    // --- Act: a socket on file A leaves ---
    b1.messages.length = 0;
    a2.ws.close();
    await new Promise((r) => a2.ws.on('close', r));

    // --- Assert ---
    await waitFor(a1.messages, (m) => m.type === 'user-leave', "A's remaining socket to see the departure");
    await new Promise((r) => setTimeout(r, 300));
    assert.deepStrictEqual(
      b1.messages.filter((m) => m.type === 'user-leave'), [],
      'the departure is not announced on another file'
    );

    // --- Assert: a socket joining B afterwards still sees only B ---
    const late = await connect(PORT, fileB, cookie);
    try {
      const roster = late.messages.find((m) => m.type === 'init').payload.users.map((u) => u.userId);
      assert.strictEqual(roster.length, 2, "B's roster grew by exactly the new socket");
      assert.ok(
        !roster.includes(a1.messages.find((m) => m.type === 'init').payload.self.userId),
        "and never picked up file A's socket"
      );
    } finally {
      late.ws.close();
    }
  } finally {
    for (const c of [a1, a2, b1]) {
      if (c && c.ws.readyState === WebSocket.OPEN) c.ws.close();
    }
    child.kill();
    await db.cleanup();
  }
});
