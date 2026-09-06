// @ts-check
import { pool } from './pool.js';

/**
 * @file db/workbook.js
 * @description Data-access functions for the `workbook_state` table (the persisted
 * cell/sheet state per workbook key). Raw SQL only; the in-memory state model,
 * cells proxy, and caching live in the caller.
 */

/**
 * Fetch the stored state for a workbook key.
 * @param {string} key
 * @returns {Promise<any | undefined>} The raw `state` value, or undefined if absent.
 */
export async function getWorkbookState(key) {
  const r = await pool.query('SELECT state FROM workbook_state WHERE key = $1', [key]);
  if (!r.rows || r.rows.length === 0) return undefined;
  const state = r.rows[0].state;
  // The column is TEXT (see db/schema.js), so the driver hands back a string; it
  // used to be JSONB, where the driver parsed it for us. Callers want the state
  // object either way — which storage format holds it is this layer's business, and
  // tolerating both keeps the repository correct against a database whose migration
  // has not run yet.
  return typeof state === 'string' ? JSON.parse(state) : state;
}

/**
 * Whether a workbook key exists.
 * @param {string} key
 * @returns {Promise<boolean>}
 */
export async function workbookKeyExists(key) {
  const r = await pool.query('SELECT key FROM workbook_state WHERE key = $1', [key]);
  return !!(r.rows && r.rows.length > 0);
}

/**
 * Fetch a workbook's last-updated timestamp.
 * @param {string} key
 * @returns {Promise<any | null>}
 */
export async function getWorkbookUpdatedAt(key) {
  const r = await pool.query('SELECT updated_at FROM workbook_state WHERE key = $1', [key]);
  const row = r.rows && r.rows[0];
  return row ? (row.updated_at || null) : null;
}

/**
 * Insert a new workbook state row.
 * @param {string} stateJson JSON-serialized state.
 * @param {string} key
 * @returns {Promise<void>}
 */
export async function insertWorkbookState(stateJson, key) {
  await pool.query('INSERT INTO workbook_state (state, key) VALUES ($1, $2)', [stateJson, key]);
}

/**
 * Update the default workbook's state.
 * @param {string} stateJson JSON-serialized state.
 * @returns {Promise<void>}
 */
export async function updateDefaultWorkbookState(stateJson) {
  await pool.query(
    "UPDATE workbook_state SET state = $1, version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE key = 'default'",
    [stateJson]
  );
}

/**
 * Update a specific workbook's state by key.
 * @param {string} stateJson JSON-serialized state.
 * @param {string} key
 * @returns {Promise<void>}
 */
export async function updateWorkbookState(stateJson, key) {
  await pool.query(
    'UPDATE workbook_state SET state = $1, version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE key = $2',
    [stateJson, key]
  );
}

/**
 * Delete a workbook's state by key.
 * @param {string} key
 * @returns {Promise<void>}
 */
export async function deleteWorkbookState(key) {
  await pool.query('DELETE FROM workbook_state WHERE key = $1', [key]);
}

/**
 * Fetch a workbook's stored state together with its optimistic-concurrency version.
 * The version is what a later {@link updateWorkbookStateIfVersion} must present to
 * prove it is writing on top of the state it read.
 * @param {string} key
 * @returns {Promise<{ state: any, version: number } | undefined>} undefined if absent.
 */
export async function getWorkbookStateWithVersion(key) {
  const r = await pool.query('SELECT state, version FROM workbook_state WHERE key = $1', [key]);
  if (!r.rows || r.rows.length === 0) return undefined;
  const row = r.rows[0];
  // Same TEXT-or-JSONB tolerance as getWorkbookState; see the note there.
  const state = typeof row.state === 'string' ? JSON.parse(row.state) : row.state;
  return { state, version: toVersion(row.version) };
}

/**
 * Fetch a workbook's current version without its (potentially megabyte-sized) state.
 * Used to re-sync after a write conflict.
 * @param {string} key
 * @returns {Promise<number | null>} null if the row is absent.
 */
export async function getWorkbookVersion(key) {
  const r = await pool.query('SELECT version FROM workbook_state WHERE key = $1', [key]);
  const row = r.rows && r.rows[0];
  return row ? toVersion(row.version) : null;
}

/**
 * Compare-and-set write: replace a workbook's state only if its stored version is
 * still `expectedVersion`, bumping the version on success.
 *
 * Every write here rewrites the WHOLE document from one instance's in-memory cache,
 * so with more than one app instance a write can carry a document that predates an
 * op another instance has already persisted — silently losing it. The predicate
 * cannot merge (there is no op log to replay), but it makes the collision visible
 * to the caller, which is the difference between a lost update we can alert on and
 * one nobody ever learns about.
 *
 * @param {string} stateJson JSON-serialized state.
 * @param {string} key
 * @param {number} expectedVersion The version the caller's state is based on.
 * @returns {Promise<number | null>} The new version, or null when another writer
 *   moved the row first (or the row is gone).
 */
export async function updateWorkbookStateIfVersion(stateJson, key, expectedVersion) {
  const r = await pool.query(
    `UPDATE workbook_state
        SET state = $1, version = version + 1, updated_at = CURRENT_TIMESTAMP
      WHERE key = $2 AND version = $3
      RETURNING version`,
    [stateJson, key, expectedVersion]
  );
  if (!r.rows || r.rows.length === 0) return null;
  return toVersion(r.rows[0].version);
}

/**
 * Normalize a `version` column value. The column is BIGINT, which the pg driver
 * hands back as a string to avoid precision loss; every value we produce is a small
 * counter, so a Number is exact and comparable.
 * @param {unknown} raw
 * @returns {number}
 */
function toVersion(raw) {
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}
