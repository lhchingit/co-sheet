// @ts-check

/**
 * @file services/workbook-writer.js
 * @description Per-key coalescing for whole-document writes.
 *
 * Persisting a workbook rewrites the entire document, so a burst of edits — one
 * message per cell today — would otherwise queue one full serialization and one
 * UPDATE per edit, of a document the burst is itself growing. This keeps at most
 * one write in flight per key and at most one queued behind it; the queued write
 * reads the live document when it actually runs, so every state between the two
 * writes is simply never written. A burst of N edits collapses to ~2 writes.
 *
 * An idle key is written immediately — the coalescing only engages while a write
 * is already in flight — so a lone edit is exactly as durable as an uncoalesced
 * write. Transport- and storage-agnostic: the caller supplies the write.
 */

/**
 * Create a coalescer over an async write function.
 * @param {(key: string) => Promise<void>} write Performs the write for a key. It
 *   must read the document's CURRENT state itself rather than accept a snapshot,
 *   since a coalesced write runs later than the call that asked for it.
 * @param {(err: unknown, key: string) => void} [onError] Notified when a write
 *   throws. A failed write never rejects the caller and never wedges the key: the
 *   next schedule() starts a fresh write.
 * @returns {{ schedule(key: string): Promise<void>, isWriting(key: string): boolean }}
 */
export const createWriteCoalescer = (write, onError) => {
  /** @type {Map<string, { writing: boolean, queued: Promise<void>|null, settleQueued: (() => void)|null }>} */
  const states = new Map();

  const stateFor = (key) => {
    let s = states.get(key);
    if (!s) {
      s = { writing: false, queued: null, settleQueued: null };
      states.set(key, s);
    }
    return s;
  };

  /**
   * Persist `key`, coalescing against any write already running for it.
   * @param {string} key
   * @returns {Promise<void>} Settles once a write that began AFTER this call
   *   completed — i.e. one whose serialization includes the caller's change.
   */
  const schedule = (key) => {
    const s = stateFor(key);

    // A write is already running; its serialization may predate this caller's
    // change, so a trailing write is needed. One serves everyone who arrives
    // during this window, since a single later write covers them all.
    if (s.writing) {
      if (!s.queued) {
        s.queued = new Promise((resolve) => { s.settleQueued = resolve; });
      }
      return s.queued;
    }

    s.writing = true;
    return (async () => {
      try {
        await write(key);
      } catch (err) {
        if (onError) onError(err, key);
      } finally {
        s.writing = false;
        if (s.queued) {
          const settle = s.settleQueued;
          s.queued = null;
          s.settleQueued = null;
          // Run the trailing write, then release everyone who queued behind this
          // one. schedule() never rejects, so both arms simply settle them.
          schedule(key).then(settle, settle);
        }
      }
    })();
  };

  /** Whether a write is currently in flight for `key` (used by tests). */
  const isWriting = (key) => !!(states.get(key) || {}).writing;

  return { schedule, isWriting };
};
