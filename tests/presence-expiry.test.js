process.env.NODE_ENV = 'test';

/**
 * @file presence-expiry.test.js
 * @description Cross-instance presence has to survive an instance dying.
 *
 * A socket that drops is reaped by the WebSocket heartbeat, which fires `close` and
 * publishes a `leave`. Nothing played that role for a whole instance: a pod killed
 * by a rolling update, an OOMKill or a scale-down publishes no leaves, so every
 * other instance kept its users in `remoteUsers` forever and their cursors haunted
 * the sheet. Rollouts are routine, so this was not an edge case.
 *
 * Each instance now re-announces its own roster on a beat and expires the remote
 * users it has stopped hearing from. Both halves need pinning, and the second is
 * the one that is easy to get wrong: an expiry sweep with no heartbeat to refresh
 * it would blink LIVE collaborators out of everyone's roster the moment they went
 * idle, which is worse than the ghosts it set out to fix.
 *
 * Requires Redis (the runner provides it); skipped otherwise. Follows the AAA pattern.
 */
import test from 'node:test';
import assert from 'node:assert';
import { spawn } from 'child_process';
import WebSocket from 'ws';
import { createTestDb } from './helpers/db.js';

const REDIS_URL = process.env.REDIS_URL;
const skip = REDIS_URL ? false : 'REDIS_URL not set — skipping cross-instance presence tests';

// Short enough to keep the test quick, same 3-beats-to-expiry ratio as the defaults.
const HEARTBEAT_MS = 300;
const TTL_MS = 900;

/** Spawn a server sharing `dbUrl` and REDIS_URL, with a fast presence beat. */
function spawnInstance(port, dbUrl) {
  const child = spawn('node', ['server.js'], {
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'test',
      DATABASE_URL: dbUrl,
      REDIS_URL,
      PRESENCE_HEARTBEAT_MS: String(HEARTBEAT_MS),
      PRESENCE_TTL_MS: String(TTL_MS)
    }
  });
  child.stderr.on('data', (d) => console.error(`[srv ${port}] ${d.toString().trim()}`));
  return child;
}

/** Open a socket and resolve once its `init` payload has arrived. */
function connectClient(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/`);
    const messages = [];
    ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
    ws.on('error', reject);
    ws.on('open', () => {
      const waitInit = () => {
        const init = messages.find((m) => m.type === 'init');
        if (init) resolve({ ws, messages, self: init.payload.self });
        else setTimeout(waitInit, 25);
      };
      waitInit();
    });
  });
}

/** Poll `messages` until `pred` matches one, or reject after `timeoutMs`. */
function waitFor(messages, pred, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      const found = messages.find(pred);
      if (found) return resolve(found);
      if (Date.now() - started > timeoutMs) return reject(new Error('Timeout waiting for message'));
      setTimeout(check, 25);
    };
    check();
  });
}

test('a killed instance stops haunting the presence list on its peers', { skip }, async () => {
  // --- Arrange: one client on each of two instances sharing a bus. ---
  const db = await createTestDb('presence-expiry');
  const a = spawnInstance(31520, db.url);
  const b = spawnInstance(31521, db.url);
  await new Promise((r) => setTimeout(r, 2000));

  let clientA, clientB;
  try {
    clientA = await connectClient(31520);
    clientB = await connectClient(31521);

    // A must have learned about B's user before we can assert it forgets them.
    const joined = await waitFor(
      clientA.messages,
      (m) => m.type === 'cursor-update' && m.payload.userId === clientB.self.userId
    );
    assert.ok(joined, 'the peer instance announced its user');

    // --- Act: kill instance B outright. SIGKILL is the point — a graceful close
    //     would publish a `leave`, which is the path that already worked. ---
    b.kill('SIGKILL');

    // --- Assert: A expires the user it can no longer hear from. Polls the live
    //     array, not a snapshot — no `user-leave` for this user can have arrived
    //     before the kill, so matching anywhere in it is unambiguous. ---
    const left = await waitFor(
      clientA.messages,
      (m) => m.type === 'user-leave' && m.payload.userId === clientB.self.userId,
      TTL_MS + 3000
    );
    assert.ok(left, 'the peer\'s user is cleared once its instance stops answering');
  } finally {
    if (clientA) clientA.ws.close();
    if (clientB) clientB.ws.close();
    a.kill();
    b.kill();
    await new Promise((r) => setTimeout(r, 400));
    await db.cleanup();
  }
});

test('an idle but live remote user is kept alive by the roster heartbeat', { skip }, async () => {
  // --- Arrange: same two-instance setup, but nothing dies. ---
  const db = await createTestDb('presence-keepalive');
  const a = spawnInstance(31522, db.url);
  const b = spawnInstance(31523, db.url);
  await new Promise((r) => setTimeout(r, 2000));

  let clientA, clientB;
  try {
    clientA = await connectClient(31522);
    clientB = await connectClient(31523);
    await waitFor(clientA.messages, (m) => m.type === 'cursor-update' && m.payload.userId === clientB.self.userId);

    // --- Act: sit idle for several TTLs. B's user sends nothing at all — no cursor
    //     moves, no edits — so only the heartbeat can keep them in A's roster. ---
    const seenBefore = clientA.messages.length;
    await new Promise((r) => setTimeout(r, TTL_MS * 3));

    // --- Assert: no expiry, and no re-announcement storm either. ---
    const later = clientA.messages.slice(seenBefore);
    assert.ok(
      !later.some((m) => m.type === 'user-leave' && m.payload.userId === clientB.self.userId),
      'a user who is merely idle must not be expired'
    );
    assert.strictEqual(
      later.filter((m) => m.type === 'cursor-update' && m.payload.userId === clientB.self.userId).length, 0,
      'a roster beat for a user we already hold must not be re-broadcast to local sockets — '
      + 'that would make presence cost O(users^2) messages per beat'
    );

    // And the roster is still what a fresh client is told on connect.
    const clientA2 = await connectClient(31522);
    try {
      const roster = clientA2.messages.find((m) => m.type === 'init').payload.users;
      assert.ok(
        roster.some((u) => u.userId === clientB.self.userId),
        'the remote user is still in the presence list a new connection receives'
      );
    } finally {
      clientA2.ws.close();
    }
  } finally {
    if (clientA) clientA.ws.close();
    if (clientB) clientB.ws.close();
    a.kill();
    b.kill();
    await new Promise((r) => setTimeout(r, 400));
    await db.cleanup();
  }
});
