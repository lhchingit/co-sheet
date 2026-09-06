process.env.NODE_ENV = 'test';

/**
 * @file token-bucket.test.js
 * @description Unit tests for services/token-bucket.js, the per-connection inbound
 * budget behind the WebSocket rate limit.
 *
 * Time is injected rather than slept through, which is the only way to assert the
 * refill curve without making the suite wait real seconds for it. Follows the AAA
 * pattern.
 */
import test from 'node:test';
import assert from 'node:assert';
import { createTokenBucket } from '../services/token-bucket.js';

/** A hand-driven clock, so a test can state how much time passed. */
function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test('a full bucket spends its whole burst at once, then refuses', () => {
  // --- Arrange ---
  const clock = fakeClock();
  const bucket = createTokenBucket({ capacity: 10, refillPerSec: 1, now: clock.now });

  // --- Act / Assert: the burst is available in one tick, with no time passing. ---
  for (let i = 0; i < 10; i++) {
    assert.strictEqual(bucket.take(), true, `token ${i + 1} of the burst should be available`);
  }
  assert.strictEqual(bucket.take(), false, 'the 11th exceeds the burst');
  assert.strictEqual(bucket.available(), 0);
});

test('tokens come back at the refill rate, and never past the capacity', () => {
  // --- Arrange ---
  const clock = fakeClock();
  const bucket = createTokenBucket({ capacity: 10, refillPerSec: 4, now: clock.now });
  for (let i = 0; i < 10; i++) bucket.take();
  assert.strictEqual(bucket.take(), false, 'drained');

  // --- Act: half a second at 4/s earns 2 tokens. ---
  clock.advance(500);

  // --- Assert ---
  assert.strictEqual(bucket.available(), 2);
  assert.strictEqual(bucket.take(2), true, 'both earned tokens are spendable');
  assert.strictEqual(bucket.take(), false, 'and nothing beyond them');

  // --- Act: idle far longer than it takes to fill. ---
  clock.advance(60_000);

  // --- Assert: the burst is a ceiling, not a running total. ---
  assert.strictEqual(bucket.available(), 10, 'refill saturates at the capacity');
});

test('take(n) is all-or-nothing, so a partial spend never happens', () => {
  // --- Arrange ---
  const clock = fakeClock();
  const bucket = createTokenBucket({ capacity: 5, refillPerSec: 1, now: clock.now });

  // --- Act / Assert ---
  assert.strictEqual(bucket.take(6), false, 'more than the bucket holds is refused');
  assert.strictEqual(bucket.available(), 5, 'a refused take spends nothing');
  assert.strictEqual(bucket.take(5), true);
  assert.strictEqual(bucket.available(), 0);
});

test('a clock that goes backwards does not drain the bucket', () => {
  // --- Arrange: an NTP step or a resumed VM can move Date.now() back. ---
  const clock = fakeClock();
  const bucket = createTokenBucket({ capacity: 10, refillPerSec: 5, now: clock.now });
  bucket.take(4);
  assert.strictEqual(bucket.available(), 6);

  // --- Act ---
  clock.advance(-5000);

  // --- Assert: treated as no time passing, rather than as negative refill. ---
  assert.strictEqual(bucket.available(), 6, 'time going backwards must not remove tokens');
  assert.strictEqual(bucket.take(6), true, 'and the tokens already earned are still spendable');
});

test('a zero capacity or rate disables the bucket entirely', () => {
  // --- Arrange / Act / Assert ---
  // The call site has no branch for "limiting is off", so a disabled bucket has to
  // be one that always says yes.
  for (const opts of [{ capacity: 0, refillPerSec: 100 }, { capacity: 100, refillPerSec: 0 }]) {
    const bucket = createTokenBucket(opts);
    assert.strictEqual(bucket.enabled, false, JSON.stringify(opts));
    for (let i = 0; i < 1000; i++) assert.strictEqual(bucket.take(), true);
    assert.strictEqual(bucket.available(), Infinity, 'a disabled bucket reports no ceiling');
  }
});

test('each bucket is independent, so one connection cannot spend another\'s budget', () => {
  // --- Arrange ---
  const clock = fakeClock();
  const a = createTokenBucket({ capacity: 3, refillPerSec: 1, now: clock.now });
  const b = createTokenBucket({ capacity: 3, refillPerSec: 1, now: clock.now });

  // --- Act ---
  a.take(3);

  // --- Assert ---
  assert.strictEqual(a.take(), false, 'A is drained');
  assert.strictEqual(b.take(), true, 'B is untouched by it');
});
