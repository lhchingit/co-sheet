process.env.NODE_ENV = 'test';

/**
 * @file realtime-channel-isolation.test.js
 * @description The realtime channel is what makes a set of instances one
 * deployment. It used to be a hardcoded constant, so every server every test file
 * spawned joined the same bus and applied, persisted and rebroadcast every other
 * file's traffic — the cause of a run of intermittent failures (#211).
 *
 * This is the negative half of realtime-multi-instance.test.js: same Redis, same
 * database, same workbook, DIFFERENT channels — and therefore no fan-out. Together
 * they pin both directions of what the channel controls.
 *
 * Requires a running Redis, like its sibling; skipped without REDIS_URL.
 * Follows the AAA pattern.
 */
import test from 'node:test';
import assert from 'node:assert';
import { spawn } from 'child_process';
import WebSocket from 'ws';
import { createTestDb } from './helpers/db.js';
import { waitForServer } from './helpers/wait-for-server.js';

const REDIS_URL = process.env.REDIS_URL;
const skip = REDIS_URL ? false : 'REDIS_URL not set — skipping realtime channel tests';

/** Spawn a server on `port` sharing `dbUrl` and REDIS_URL, on the given channel. */
function spawnInstance(port, dbUrl, channel) {
  const child = spawn('node', ['server.js'], {
    env: {
      ...process.env,
      PORT: String(port), NODE_ENV: 'test', DATABASE_URL: dbUrl,
      REDIS_URL, REALTIME_CHANNEL: channel
    }
  });
  child.stderr.on('data', (d) => console.error(`[Server ${port} STDERR] ${d.toString().trim()}`));
  return child;
}

/** Open a WebSocket and resolve once it has received its `init` payload. */
function connectClient(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/`);
    const messages = [];
    ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
    ws.on('error', reject);
    ws.on('open', () => {
      const waitInit = () => {
        if (messages.some((m) => m.type === 'init')) resolve({ ws, messages });
        else setTimeout(waitInit, 25);
      };
      waitInit();
    });
    setTimeout(() => reject(new Error(`timed out connecting to ${port}`)), 5000);
  });
}

test('instances on different channels do not hear each other', { skip }, async () => {
  // --- Arrange: one Redis, one database, one workbook — only the channel differs ---
  const PORT_A = 31431;
  const PORT_B = 31432;
  const db = await createTestDb('rtchannel');
  const a = spawnInstance(PORT_A, db.url, 'cosheet:rt:test:isolation-a');
  const b = spawnInstance(PORT_B, db.url, 'cosheet:rt:test:isolation-b');

  let clientA, clientB;
  try {
    await Promise.all([waitForServer(PORT_A), waitForServer(PORT_B)]);
    clientA = await connectClient(PORT_A);
    clientB = await connectClient(PORT_B);
    clientB.messages.length = 0;

    // --- Act ---
    clientA.ws.send(JSON.stringify({
      type: 'cell-edit',
      payload: { cellId: 'D4', formula: '', value: 'only on A', style: {}, sheetName: 'Sheet1' }
    }));

    // --- Assert ---
    // An absence cannot be polled for, so this waits a fixed, generous window: the
    // sibling test sees the same fan-out land well inside it when the channel is
    // shared, so a delivery here would have arrived.
    await new Promise((r) => setTimeout(r, 1500));

    const leaked = clientB.messages.filter(
      (m) => m.type === 'cell-update' && m.payload && m.payload.cellId === 'D4'
    );
    assert.deepStrictEqual(leaked, [], 'the edit stayed on its own channel');

    // The edit really did happen — otherwise this test would pass on a broken send.
    const cells = await db.getCells('default', 'Sheet1');
    assert.strictEqual(cells.D4.value, 'only on A', 'instance A applied and persisted it');
  } finally {
    if (clientA) clientA.ws.close();
    if (clientB) clientB.ws.close();
    a.kill();
    b.kill();
    await new Promise((r) => setTimeout(r, 500));
    await db.cleanup();
  }
});

test('the suite gives each test file its own channel', { skip }, async () => {
  // The isolation above is only load-bearing if the helper actually claims a
  // distinct channel per process — servers inherit it through process.env, so
  // nothing at a spawn site would reveal a regression here.
  const { TEST_REALTIME_CHANNEL } = await import('./helpers/db.js');

  assert.strictEqual(
    process.env.REALTIME_CHANNEL, TEST_REALTIME_CHANNEL,
    'importing the db helper claimed a channel for this process'
  );
  assert.notStrictEqual(
    process.env.REALTIME_CHANNEL, 'cosheet:rt',
    'and it is not the production default every instance would share'
  );
  assert.match(TEST_REALTIME_CHANNEL, new RegExp(`:${process.pid}:`), 'keyed to this process');
});
