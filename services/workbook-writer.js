// @ts-check

/**
 * @file services/workbook-writer.js
 * @description Per-key coalescing and rate-limiting for whole-document writes.
 *
 * Persisting a workbook rewrites the entire document, so a burst of edits — one
 * message per cell today — would otherwise queue one full serialization and one
 * UPDATE per edit, of a document the burst is itself growing. This keeps at most
 * one write in flight per key and at most one queued behind it; the queued write
 * reads the live document when it actually runs, so every state between the two
 * writes is simply never written. A burst of N edits collapses to ~2 writes.
 *
 * Coalescing alone bounds write CONCURRENCY, not write FREQUENCY: the trailing
 * write used to start the instant the previous one settled, so while anyone was
 * editing the server sat in a continuous full-document write loop, going as fast as
 * the storage would answer. `minIntervalMs` puts a floor between a key's writes.
 * It does not change the durability model — the coalescer already discards every
 * state between two writes; the floor only widens that window from "one write
 * duration" to the configured interval (#248).
 *
 * A key that has not been written recently is still written immediately, so a lone
 * edit is exactly as durable as an uncoalesced write. Transport- and
 * storage-agnostic: the caller supplies the write.
 */

/**
 * Create a coalescer over an async write function.
 * @param {(key: string) => Promise<void>} write Performs the write for a key. It
 *   must read the document's CURRENT state itself rather than accept a snapshot,
 *   since a coalesced write runs later than the call that asked for it.
 * @param {(err: unknown, key: string) => void} [onError] Notified when a write
 *   throws. A failed write never rejects the caller and never wedges the key: the
 *   next schedule() starts a fresh write.
 * @param {{ minIntervalMs?: number }} [options] `minIntervalMs` is the smallest gap
 *   allowed between the end of one write for a key and the start of the next
 *   (default 0 — write as fast as the storage allows, the previous behaviour).
 * @returns {{
 *   schedule(key: string): Promise<void>,
 *   isWriting(key: string): boolean,
 *   isPending(key: string): boolean,
 *   forget(key: string): boolean
 * }}
 */
export const createWriteCoalescer = (write, onError, options = {}) => {
  const minIntervalMs = Math.max(0, options.minIntervalMs || 0);

  /**
   * @type {Map<string, {
   *   writing: boolean,
   *   queued: Promise<void>|null,
   *   settleQueued: (() => void)|null,
   *   timer: any,
   *   lastWriteEnd: number
   * }>}
   */
  const states = new Map();

  const stateFor = (key) => {
    let s = states.get(key);
    if (!s) {
      s = { writing: false, queued: null, settleQueued: null, timer: null, lastWriteEnd: 0 };
      states.set(key, s);
    }
    return s;
  };

  /** The promise everyone waiting for the NEXT write shares. */
  const queuedPromise = (s) => {
    if (!s.queued) {
      s.queued = new Promise((resolve) => { s.settleQueued = resolve; });
    }
    return s.queued;
  };

  /** Take the pending waiters off `s`, so a new batch can accumulate behind them. */
  const takeWaiters = (s) => {
    const settle = s.settleQueued;
    s.queued = null;
    s.settleQueued = null;
    return settle;
  };

  /**
   * Run the write for `key` now, then hand the key to whoever queued behind it.
   * @param {string} key
   * @returns {Promise<void>}
   */
  const runWrite = (key) => {
    const s = stateFor(key);
    s.writing = true;
    return (async () => {
      try {
        await write(key);
      } catch (err) {
        if (onError) onError(err, key);
      } finally {
        s.writing = false;
        s.lastWriteEnd = Date.now();
        if (s.queued) {
          const settle = takeWaiters(s);
          // Back through schedule(), so the trailing write observes the floor
          // instead of starting the instant this one finished. schedule() never
          // rejects, so both arms simply settle the waiters.
          schedule(key).then(settle, settle);
        }
      }
    })();
  };

  /**
   * Persist `key`, coalescing against any write already running or armed for it and
   * respecting the minimum interval between writes.
   * @param {string} key
   * @returns {Promise<void>} Settles once a write that began AFTER this call
   *   completed — i.e. one whose serialization includes the caller's change.
   */
  const schedule = (key) => {
    const s = stateFor(key);

    // A write is running, or one is already armed to run when the floor expires.
    // Either way a later write will cover this caller's change, and one such write
    // serves everyone who arrives during the window.
    if (s.writing || s.timer) return queuedPromise(s);

    // How long this key must wait before it may be written again. Zero for a key
    // that has never been written, or one whose last write is already older than
    // the floor — those go straight through.
    const wait = s.lastWriteEnd === 0
      ? 0
      : Math.max(0, minIntervalMs - (Date.now() - s.lastWriteEnd));
    if (wait === 0) return runWrite(key);

    const waiters = queuedPromise(s);
    s.timer = setTimeout(() => {
      s.timer = null;
      const settle = takeWaiters(s);
      runWrite(key).then(settle, settle);
    }, wait);
    // Deliberately NOT unref'd. The timer holds a document that is not on disk
    // yet, so it should keep the process alive the way an in-flight write does —
    // a natural exit then flushes it, at the cost of at most one interval.
    return waiters;
  };

  /** Whether a write is currently in flight for `key` (used by tests). */
  const isWriting = (key) => !!(states.get(key) || {}).writing;

  /**
   * Whether `key` has a write in flight OR one armed behind the floor — i.e. state
   * a caller must not assume is already persisted.
   * @param {string} key
   * @returns {boolean}
   */
  const isPending = (key) => {
    const s = states.get(key);
    return !!s && (s.writing || !!s.timer);
  };

  /**
   * Drop the bookkeeping for a key whose document the caller is done with, so the
   * map does not accumulate an entry per document the process has ever written.
   * Refuses while a write is pending: an in-flight write's `finally` still needs
   * the entry to find its trailing write, and an armed one has not persisted the
   * document yet.
   * @param {string} key
   * @returns {boolean} True if the entry was dropped (or was never there).
   */
  const forget = (key) => {
    const s = states.get(key);
    if (!s) return true;
    if (s.writing || s.timer) return false;
    states.delete(key);
    return true;
  };

  return { schedule, isWriting, isPending, forget };
};
