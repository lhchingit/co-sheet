process.env.NODE_ENV = 'test';

/**
 * @file workbook-writer.test.js
 * @description Unit tests for the per-key write coalescer (services/workbook-writer.js).
 * Persisting a workbook rewrites the whole document, so a burst of edits must
 * collapse to ~2 writes rather than one per edit — without ever leaving the final
 * state unwritten, which is the invariant everything else depends on.
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
