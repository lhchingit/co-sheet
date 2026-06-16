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
  return r.rows[0].state;
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
    "UPDATE workbook_state SET state = $1, updated_at = CURRENT_TIMESTAMP WHERE key = 'default'",
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
    'UPDATE workbook_state SET state = $1, updated_at = CURRENT_TIMESTAMP WHERE key = $2',
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
