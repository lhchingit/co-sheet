// @ts-check

/**
 * @file services/token-bucket.js
 * @description A token bucket, used to bound what one WebSocket connection can ask
 * the server to do.
 *
 * Refill is computed lazily, on take(), rather than driven by a timer. That is the
 * whole reason this is worth a module: a per-connection timer would mean one timer
 * per editor — thousands of them on a busy instance, all firing to add a fraction of
 * a token to a bucket that is nearly always full. Elapsed time is enough.
 *
 * `capacity` is the burst a connection may spend at once and `refillPerSec` the rate
 * it earns tokens back, so the two knobs separate "how much may arrive in one go"
 * from "how much may arrive over time". That separation is the point: a paste is a
 * legitimate burst of several hundred messages in one tick, while a script is a
 * legitimate-looking rate that never stops.
 *
 * A capacity or rate of 0 disables the bucket — take() always succeeds — so a
 * deployment (or the test suite) can turn the limit off without a branch at the call
 * site.
 */

/**
 * Create a token bucket.
 * @param {{ capacity: number, refillPerSec: number, now?: () => number }} opts
 *   `now` is injectable so tests can drive time instead of sleeping through it.
 * @returns {{ take(n?: number): boolean, available(): number, enabled: boolean }}
 */
export const createTokenBucket = ({ capacity, refillPerSec, now = Date.now }) => {
  const enabled = capacity > 0 && refillPerSec > 0;
  let tokens = capacity;
  let last = now();

  /**
   * Add whatever the elapsed time has earned, capped at `capacity`. Called before
   * every read so the bucket is never stale.
   */
  const refill = () => {
    const t = now();
    // Guard a clock that goes backwards (NTP step, VM resume): treat it as no time
    // passed rather than draining the bucket by a negative amount.
    if (t > last) {
      tokens = Math.min(capacity, tokens + ((t - last) / 1000) * refillPerSec);
      last = t;
    }
  };

  return {
    enabled,

    /**
     * Spend `n` tokens if they are there.
     * @param {number} [n]
     * @returns {boolean} True if the caller may proceed; false if it is over budget.
     */
    take(n = 1) {
      if (!enabled) return true;
      refill();
      if (tokens < n) return false;
      tokens -= n;
      return true;
    },

    /** Tokens currently available (fractional). Exposed for tests and diagnostics. */
    available() {
      if (!enabled) return Infinity;
      refill();
      return tokens;
    }
  };
};
