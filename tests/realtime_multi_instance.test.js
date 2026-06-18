process.env.NODE_ENV = 'test';

/**
 * @file realtime_multi_instance.test.js
 * @description Integration tests for cross-instance realtime fan-out via Redis.
 *
 * These spin up TWO server processes sharing one Redis (and one STORE_PATH, which
 * stands in for a shared database) and verify that an edit / presence event made
 * on a client connected to instance A is delivered to a client connected to
 * instance B — the behavior that makes horizontal scaling correct.
 *
 * A running Redis is required, so the whole suite is skipped unless REDIS_URL is
 * set. Run it locally with, e.g. (after `docker compose up -d redis`):
 *
 *   REDIS_URL=redis://localhost:6379 node --test tests/realtime_multi_instance.test.js
 */

import test from 'node:test';
import assert from 'node:assert';
import { spawn } from 'child_process';
import WebSocket from 'ws';
import fs from 'fs';
import path from 'path';

const REDIS_URL = process.env.REDIS_URL;
const skip = REDIS_URL ? false : 'REDIS_URL not set — skipping multi-instance Redis tests';

/** Spawn a server instance on `port` sharing `storePath` and REDIS_URL. */
function spawnInstance(port, storePath) {
  const child = spawn('node', ['server.js'], {
    env: { ...process.env, PORT: String(port), NODE_ENV: 'test', STORE_PATH: storePath, REDIS_URL }
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
  });
}

/** Poll `messages` until `pred` matches one, or reject after `timeoutMs`. */
function waitFor(messages, pred, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      const found = messages.find(pred);
      if (found) return resolve(found);
      if (Date.now() - started > timeoutMs) return reject(new Error('Timeout waiting for message'));
      setTimeout(check, 30);
    };
    check();
  });
}

test('Realtime - cell edits fan out across instances via Redis', { skip }, async () => {
  const STORE_PATH = path.resolve('store.multi.cell.test.json');
  if (fs.existsSync(STORE_PATH)) fs.unlinkSync(STORE_PATH);
  fs.writeFileSync(STORE_PATH, JSON.stringify({ cells: {} }, null, 2), 'utf8');

  const a = spawnInstance(31401, STORE_PATH);
  const b = spawnInstance(31402, STORE_PATH);
  // Wait for both servers to boot and connect to Redis.
  await new Promise((r) => setTimeout(r, 2000));

  let clientA, clientB;
  try {
    clientA = await connectClient(31401);
    clientB = await connectClient(31402);
    await new Promise((r) => setTimeout(r, 200));

    // Edit on instance A...
    clientA.ws.send(JSON.stringify({
      type: 'cell-edit',
      payload: { cellId: 'C3', formula: '=5*5', value: '25', style: { bold: true }, sheetName: 'Sheet1' }
    }));

    // ...must reach the client on instance B.
    const update = await waitFor(clientB.messages, (m) => m.type === 'cell-update' && m.payload.cellId === 'C3');
    assert.strictEqual(update.payload.value, '25');
    assert.strictEqual(update.payload.formula, '=5*5');
    assert.strictEqual(update.payload.sheetName, 'Sheet1');
  } finally {
    if (clientA) clientA.ws.close();
    if (clientB) clientB.ws.close();
    a.kill();
    b.kill();
    await new Promise((r) => setTimeout(r, 400));
    for (const p of [STORE_PATH, `${STORE_PATH}.versions.json`]) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  }
});

test('Realtime - presence (cursor) fans out across instances via Redis', { skip }, async () => {
  const STORE_PATH = path.resolve('store.multi.presence.test.json');
  if (fs.existsSync(STORE_PATH)) fs.unlinkSync(STORE_PATH);
  fs.writeFileSync(STORE_PATH, JSON.stringify({ cells: {} }, null, 2), 'utf8');

  const a = spawnInstance(31403, STORE_PATH);
  const b = spawnInstance(31404, STORE_PATH);
  await new Promise((r) => setTimeout(r, 2000));

  let clientA, clientB;
  try {
    clientA = await connectClient(31403);
    clientB = await connectClient(31404);
    await new Promise((r) => setTimeout(r, 200));

    // A cursor move on instance A...
    clientA.ws.send(JSON.stringify({ type: 'cursor-move', payload: { cellId: 'B2', sheetName: 'Sheet1' } }));

    // ...must surface as a cursor-update on instance B's client.
    const cu = await waitFor(clientB.messages, (m) => m.type === 'cursor-update' && m.payload.activeCell === 'B2');
    assert.ok(cu.payload.userId);
    assert.ok(cu.payload.color);

    // And when A disconnects, B sees the user-leave.
    clientA.ws.close();
    clientA = null;
    const leave = await waitFor(clientB.messages, (m) => m.type === 'user-leave');
    assert.ok(leave.payload.userId);
  } finally {
    if (clientA) clientA.ws.close();
    if (clientB) clientB.ws.close();
    a.kill();
    b.kill();
    await new Promise((r) => setTimeout(r, 400));
    for (const p of [STORE_PATH, `${STORE_PATH}.versions.json`]) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  }
});
