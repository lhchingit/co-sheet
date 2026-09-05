// @ts-check
import { pool } from './pool.js';

/**
 * @file db/versions.js
 * @description Data-access functions for the `workbook_versions` table (autosave/
 * restore snapshots). Raw SQL only; state (de)serialization is left to the caller.
 * Every snapshot is scoped to a workbook via `file_id` ('default' for the legacy
 * single-document workbook).
 */

/**
 * How many versions of a file the history listing returns, newest first.
 *
 * Also the count a file's history is to be pruned to, so in steady state the
 * listing shows everything that exists and this bound is invisible. It is applied
 * to the query as well because that is not something the query should have to
 * assume: without it, opening the history of a long-lived file returns every
 * snapshot ever taken of it — a full workbook copy is written after every 15
 * seconds of idle — and the sidebar renders the lot.
 */
export const VERSION_LIST_LIMIT = 100;

/**
 * List version metadata (no state payload) for one file, newest first.
 * Bounded: see VERSION_LIST_LIMIT.
 * @param {string} fileId
 * @param {number} [limit]
 * @returns {Promise<any[]>}
 */
export async function listVersions(fileId, limit = VERSION_LIST_LIMIT) {
  const r = await pool.query(
    `SELECT id, created_at, created_by FROM workbook_versions
      WHERE file_id = $1 ORDER BY id DESC LIMIT $2`,
    [fileId, limit]
  );
  return r.rows || [];
}

/**
 * Fetch the stored state snapshot for a version, scoped to its file so a version
 * id from one workbook cannot be read through another.
 * @param {number} id
 * @param {string} fileId
 * @returns {Promise<any | undefined>} The state object, or undefined if not found.
 */
export async function getVersionState(id, fileId) {
  const r = await pool.query(
    'SELECT state FROM workbook_versions WHERE id = $1 AND file_id = $2',
    [id, fileId]
  );
  if (!r.rows || r.rows.length === 0) return undefined;
  const state = r.rows[0].state;
  // Stored as TEXT (see db/schema.js), so the driver returns a string where it
  // parsed JSONB for us. Callers want the snapshot either way; which format holds
  // it is this layer's business, and tolerating both keeps the repository correct
  // against a database whose migration has not run yet.
  return typeof state === 'string' ? JSON.parse(state) : state;
}

/**
 * Delete a file's snapshots older than its newest `keep`.
 *
 * Each snapshot is a full copy of the workbook, not a diff, and one is written
 * after every 15 seconds of idle editing — so without this a file's history grows
 * without bound for as long as anyone works on it.
 *
 * The threshold is the id of the `keep`-th newest row, read straight off
 * idx_workbook_versions_file_id. A file with fewer than `keep` snapshots has no
 * such row, and the subquery returns NULL: `id < NULL` is NULL, never true, so
 * nothing is deleted — which is the wanted behaviour, arrived at by SQL's
 * three-valued logic rather than by a separate count.
 * @param {string} fileId
 * @param {number} [keep]
 * @returns {Promise<number>} How many snapshots were deleted.
 */
export async function pruneVersions(fileId, keep = VERSION_LIST_LIMIT) {
  const r = await pool.query(
    `DELETE FROM workbook_versions
      WHERE file_id = $1
        AND id < (
          SELECT id FROM workbook_versions
           WHERE file_id = $1 ORDER BY id DESC LIMIT 1 OFFSET $2 - 1
        )`,
    [fileId, keep]
  );
  return r.rowCount || 0;
}

/**
 * Record a new version snapshot for a file, then prune that file's history to the
 * newest VERSION_LIST_LIMIT.
 * @param {string} stateJson JSON-serialized workbook state.
 * @param {string} createdBy
 * @param {string} fileId
 * @returns {Promise<void>}
 */
export async function insertVersion(stateJson, createdBy, fileId) {
  await pool.query(
    'INSERT INTO workbook_versions (file_id, state, created_by) VALUES ($1, $2, $3)',
    [fileId, stateJson, createdBy]
  );
  // Pruning must never cost the caller the snapshot it just took: the version is
  // already committed, and a failure here means only that the trim is late — the
  // next snapshot of this file prunes the same rows. Deliberately narrower than
  // swallowing errors generally: nothing a caller can observe changes, and the
  // work retries on its own.
  try {
    await pruneVersions(fileId);
  } catch (e) { /* trimmed on the next snapshot */ }
}
