process.env.NODE_ENV = 'test';

/**
 * @file workbook-writer.test.js
 * @description Unit tests for the per-key write coalescer (services/workbook-writer.js).
 * Persisting a workbook rewrites the whole document, so a burst of edits must
 * collapse to ~2 writes rather than one per edit — without ever leaving the final
 * state unwritten, which is the invariant everything else depends on.
 *
 * The second half covers the write floor (#248): coalescing bounds how many writes
 * a key has at once, the floor bounds how many it has per second.
 */
import test from 'node:test';
import assert from 'node:assert';
import { createWriteCoalescer } from '../services/workbook-writer.js';

/** A write whose completion the test controls, recording what it saw each time. */
function controllableWrite() {
  const calls = [];
  let release = null;
  const write = (key) => {
    const call = { key, done: false };
    calls.push(call);
    return new Promise((resolve) => {
      release = () => { call.done = true; resolve(); };
    });
  };
  return { write, calls, release: () => release() };
}

test('an idle key is written immediately, with no coalescing delay', async () => {
  const seen = [];
  const { schedule } = createWriteCoalescer(async (key) => { seen.push(key); });

  await schedule('default');

  assert.deepStrictEqual(seen, ['default'], 'a lone edit is written straight through');
});

test('a burst during an in-flight write collapses to one trailing write', async () => {
  const c = controllableWrite();
  const { schedule } = createWriteCoalescer(c.write);

  // First edit starts a write and holds it open.
  const first = schedule('file1');
  assert.strictEqual(c.calls.length, 1, 'the first edit writes immediately');

  // 50 more edits land while that write is in flight.
  const queued = [];
  for (let i = 0; i < 50; i++) queued.push(schedule('file1'));
  assert.strictEqual(c.calls.length, 1, 'none of them starts a second concurrent write');

  // Let the first write finish; exactly one trailing write covers all 50.
  c.release();
  await first;
  assert.strictEqual(c.calls.length, 2, '50 queued edits produce ONE trailing write');

  c.release();
  await Promise.all(queued);
  assert.strictEqual(c.calls.length, 2, 'and no further writes after the queue drains');
});

test('every caller settles only after a write that began after its own call', async () => {
  // The invariant that makes coalescing safe: nobody is told "persisted" on the
  // strength of a write whose serialization predates their change.
  const order = [];
  let writes = 0;
  let release = null;
  const { schedule } = createWriteCoalescer(async () => {
    const n = ++writes;
    await new Promise((r) => { release = r; });
    order.push(`write${n}`);
  });

  const first = schedule('f');
  const late = schedule('f');           // arrives mid-flight; write1 cannot cover it
  let lateSettled = false;
  late.then(() => { lateSettled = true; order.push('late-settled'); });

  release();                            // finish write1
  await first;
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(lateSettled, false, 'the late caller is NOT settled by write1');

  release();                            // finish write2 (the trailing write)
  await late;
  assert.deepStrictEqual(order, ['write1', 'write2', 'late-settled']);
});

test('a failed write is reported, never rejects the caller, and never wedges the key', async () => {
  const errors = [];
  let attempt = 0;
  const { schedule, isWriting } = createWriteCoalescer(
    async () => { if (++attempt === 1) throw new Error('connection lost'); },
    (err, key) => errors.push(`${key}: ${err.message}`)
  );

  await schedule('f');                  // must not throw
  assert.deepStrictEqual(errors, ['f: connection lost'], 'the failure is reported');
  assert.strictEqual(isWriting('f'), false, 'the latch is released after a failure');

  await schedule('f');                  // the next edit still writes
  assert.strictEqual(attempt, 2, 'a later edit is not blocked by the earlier failure');
});

test('keys are coalesced independently', async () => {
  const c = controllableWrite();
  const { schedule } = createWriteCoalescer(c.write);

  schedule('fileA');
  schedule('fileB');

  assert.deepStrictEqual(c.calls.map((x) => x.key), ['fileA', 'fileB'],
    'one workbook holding a write does not stall another');
});

// --- The write floor (#248) -------------------------------------------------

/** Resolves after `ms`, for tests that must let a real floor expire. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('the first write of a key goes straight through, floor or no floor', async () => {
  const seen = [];
  const { schedule } = createWriteCoalescer(async (key) => { seen.push(key); }, undefined,
    { minIntervalMs: 10000 });

  // A ten-second floor must not delay a key that has never been written: a lone
  // edit stays exactly as durable as it was before the floor existed.
  await schedule('f');

  assert.deepStrictEqual(seen, ['f'], 'a lone edit is written straight through');
});

test('a second write waits out the floor instead of following the first immediately', async () => {
  const at = [];
  const start = Date.now();
  const { schedule } = createWriteCoalescer(async () => { at.push(Date.now() - start); }, undefined,
    { minIntervalMs: 120 });

  await schedule('f');                  // immediate
  const second = schedule('f');         // must wait out the floor
  await sleep(40);
  assert.strictEqual(at.length, 1, 'the second write has not started 40ms in');

  await second;
  assert.strictEqual(at.length, 2, 'it does run, once the floor expires');
  assert.ok(at[1] >= 100, `the gap honours the floor (was ${at[1]}ms)`);
});

test('a key idle longer than the floor is written immediately again', async () => {
  const at = [];
  const start = Date.now();
  const { schedule } = createWriteCoalescer(async () => { at.push(Date.now() - start); }, undefined,
    { minIntervalMs: 50 });

  await schedule('f');
  await sleep(80);                      // longer than the floor: nothing is owed
  const t = Date.now();
  await schedule('f');

  assert.strictEqual(at.length, 2);
  assert.ok(Date.now() - t < 40, 'the later edit is not made to wait all over again');
});

test('sustained editing settles into one write per interval, not one per edit', async () => {
  // The behaviour the floor exists for: while someone keeps editing, the server
  // writes at a bounded RATE rather than as fast as storage will answer.
  let writes = 0;
  const { schedule } = createWriteCoalescer(async () => { writes++; }, undefined,
    { minIntervalMs: 50 });

  // An edit every 5ms for ~300ms. Uncoalesced that is ~60 writes; with coalescing
  // alone it is one per completed write (here, effectively one per edit, since the
  // write resolves instantly); with the floor it is bounded by the elapsed time.
  const deadline = Date.now() + 300;
  while (Date.now() < deadline) {
    schedule('f');
    await sleep(5);
  }
  await schedule('f');

  assert.ok(writes <= 9, `~300ms of continuous editing stays near the floor's rate (was ${writes})`);
  assert.ok(writes >= 2, `and the document is still being written (was ${writes})`);
});

test('a key with a write armed behind the floor is neither idle nor forgettable', async () => {
  const { schedule, isWriting, isPending, forget } = createWriteCoalescer(async () => {}, undefined,
    { minIntervalMs: 120 });

  await schedule('f');
  const second = schedule('f');         // armed, not running

  assert.strictEqual(isWriting('f'), false, 'nothing is in flight');
  assert.strictEqual(isPending('f'), true, 'but the document is not persisted yet');
  assert.strictEqual(forget('f'), false, 'so the key must not be dropped');

  await second;
  assert.strictEqual(isPending('f'), false, 'once the armed write runs, nothing is owed');
  assert.strictEqual(forget('f'), true, 'and the key can be dropped');
});
