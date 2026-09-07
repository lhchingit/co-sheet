process.env.NODE_ENV = 'test';

/**
 * @file ws-rate-limit.test.js
 * @description WebSocket traffic is not covered by the HTTP limiters in
 * services/rate-limit.js, and `MAX_BULK_CELL_EDITS` bounds only how much ONE message
 * may ask for. Nothing bounded how many messages, so a single client looping
 * `cell-edit` drove a whole-document write schedule and a fan-out to every peer on
 * the file as fast as it could write into a socket.
 *
 * Per-connection token buckets now bound that, and the two kinds of traffic are
 * deliberately treated differently — which is the part worth pinning:
 *
 *  - a cursor move over budget is DROPPED, because it is superseded by the next one;
 *  - an edit over budget CLOSES the socket, because a state-changing message must not
 *    be discarded behind the user's back. The client applies edits optimistically, so
 *    a silently dropped one leaves its view holding a value the server does not have.
 *    Closing re-syncs it: the client reconnects and the server sends a fresh `init`.
 *
 * The limits are lowered by env here so the test does not have to send the production
 * burst of 400. Follows the AAA pattern.
 */
import test from 'node:test';
import assert from 'node:assert';
import { spawn } from 'child_process';
import WebSocket from 'ws';
import { createTestDb } from './helpers/db.js';
import { waitForServer } from './helpers/wait-for-server.js';

const PORT = '31530';
const OP_BURST = 10;
const PRESENCE_BURST = 5;

/** Open a socket on the default workbook and resolve once `init` has arrived. */
function connectClient() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/`);
    const messages = [];
    const closes = [];
    ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
    ws.on('close', (code, reason) => closes.push({ code, reason: reason.toString() }));
    ws.on('error', () => { /* a policy close can surface as an error on some paths */ });
    ws.on('open', () => {
      const waitInit = () => {
        if (messages.some((m) => m.type === 'init')) resolve({ ws, messages, closes });
        else setTimeout(waitInit, 20);
      };
      waitInit();
    });
    setTimeout(() => reject(new Error('connect timeout')), 5000);
  });
}

const cellEdit = (cellId, value) => JSON.stringify({
  type: 'cell-edit',
  payload: { cellId, formula: '', value, style: {}, sheetName: 'Sheet1' }
});

const settle = (ms = 600) => new Promise((r) => setTimeout(r, ms));

test('an over-budget client is closed for edits but only throttled for cursors', async () => {
  // --- Arrange ---
  const db = await createTestDb('ws-rate-limit');
  const child = spawn('node', ['server.js'], {
    env: {
      ...process.env,
      PORT,
      NODE_ENV: 'test',
      DATABASE_URL: db.url,
      WS_OP_BURST: String(OP_BURST),
      WS_OP_RATE: '1',
      WS_PRESENCE_BURST: String(PRESENCE_BURST),
      WS_PRESENCE_RATE: '1'
    }
  });
  child.stderr.on('data', (d) => console.error(`[srv] ${d.toString().trim()}`));
  await waitForServer(PORT);

  let wellBehaved, flooder, cursorFlooder, observer;
  try {
    // --- A client inside its budget is untouched. ---
    wellBehaved = await connectClient();
    for (let i = 1; i <= OP_BURST - 2; i++) wellBehaved.ws.send(cellEdit(`A${i}`, `v${i}`));
    await settle();

    assert.strictEqual(wellBehaved.ws.readyState, WebSocket.OPEN, 'a burst inside the budget must not be punished');
    assert.deepStrictEqual(wellBehaved.closes, [], 'and must not close the socket');
    const cells = await db.getCells('default', 'Sheet1');
    for (let i = 1; i <= OP_BURST - 2; i++) {
      assert.strictEqual(cells[`A${i}`].value, `v${i}`, `edit A${i} should have been applied`);
    }

    // --- Act: a client well past the budget. ---
    flooder = await connectClient();
    for (let i = 0; i < OP_BURST * 5; i++) flooder.ws.send(cellEdit('B1', `flood${i}`));
    await settle();

    // --- Assert: closed, with the policy code, rather than silently ignored. ---
    assert.strictEqual(flooder.ws.readyState, WebSocket.CLOSED, 'a flooding client is disconnected');
    assert.strictEqual(flooder.closes.length, 1, 'exactly one close');
    assert.strictEqual(flooder.closes[0].code, 1008, 'closed as a policy violation, not a crash or a normal close');

    // --- Act: the same excess, but presence. ---
    observer = await connectClient();
    cursorFlooder = await connectClient();
    await settle(300);
    const seenBefore = observer.messages.length;
    const CURSOR_FLOOD = PRESENCE_BURST * 8;
    for (let i = 1; i <= CURSOR_FLOOD; i++) {
      cursorFlooder.ws.send(JSON.stringify({ type: 'cursor-move', payload: { cellId: `C${i}`, sheetName: 'Sheet1' } }));
    }
    await settle();

    // --- Assert: throttled, not disconnected. Losing a cursor position costs the
    //     peers a stale tag for a moment; losing the connection costs a re-init. ---
    assert.strictEqual(cursorFlooder.ws.readyState, WebSocket.OPEN, 'presence excess must not close the socket');
    assert.deepStrictEqual(cursorFlooder.closes, [], 'a chatty cursor is not a policy violation');

    const forwarded = observer.messages.slice(seenBefore)
      .filter((m) => m.type === 'cursor-update' && m.payload.userId === cursorFlooder.messages
        .find((x) => x.type === 'init').payload.self.userId).length;
    assert.ok(forwarded > 0, 'the moves inside the budget are still delivered');
    assert.ok(
      forwarded < CURSOR_FLOOD,
      `the excess is dropped, not forwarded (saw ${forwarded} of ${CURSOR_FLOOD})`
    );

    // The socket still works afterwards: throttling is not a one-way door.
    await settle(1200); // earn tokens back at 1/s
    const seenAfter = observer.messages.length;
    cursorFlooder.ws.send(JSON.stringify({ type: 'cursor-move', payload: { cellId: 'D9', sheetName: 'Sheet1' } }));
    await settle(400);
    assert.ok(
      observer.messages.slice(seenAfter).some((m) => m.type === 'cursor-update' && m.payload.activeCell === 'D9'),
      'once tokens refill the client is served normally again'
    );
  } finally {
    for (const c of [wellBehaved, flooder, cursorFlooder, observer]) {
      if (c && c.ws.readyState === WebSocket.OPEN) c.ws.close();
    }
    child.kill();
    await new Promise((r) => setTimeout(r, 400));
    await db.cleanup();
  }
});
