// @ts-check
import { pool } from './pool.js';

/**
 * @file db/versions.js
 * @description Data-access functions for the `workbook_versions` table (autosave/
 * restore snapshots). Raw SQL only; state (de)serialization is left to the caller.
 */

/**
 * List version metadata (no state payload), newest first.
 * @returns {Promise<any[]>}
 */
export async function listVersions() {
  const r = await pool.query('SELECT id, created_at, created_by FROM workbook_versions ORDER BY id DESC');
  return r.rows || [];
}

/**
 * Fetch the stored state snapshot for a version.
 * @param {number} id
 * @returns {Promise<any | undefined>} The raw `state` value, or undefined if not found.
 */
export async function getVersionState(id) {
  const r = await pool.query('SELECT state FROM workbook_versions WHERE id = $1', [id]);
  if (!r.rows || r.rows.length === 0) return undefined;
  return r.rows[0].state;
}

/**
 * Record a new version snapshot.
 * @param {string} stateJson JSON-serialized workbook state.
 * @param {string} createdBy
 * @returns {Promise<void>}
 */
export async function insertVersion(stateJson, createdBy) {
  await pool.query(
    'INSERT INTO workbook_versions (state, created_by) VALUES ($1, $2)',
    [stateJson, createdBy]
  );
}
