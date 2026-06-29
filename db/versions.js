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
 * List version metadata (no state payload) for one file, newest first.
 * @param {string} fileId
 * @returns {Promise<any[]>}
 */
export async function listVersions(fileId) {
  const r = await pool.query(
    'SELECT id, created_at, created_by FROM workbook_versions WHERE file_id = $1 ORDER BY id DESC',
    [fileId]
  );
  return r.rows || [];
}

/**
 * Fetch the stored state snapshot for a version, scoped to its file so a version
 * id from one workbook cannot be read through another.
 * @param {number} id
 * @param {string} fileId
 * @returns {Promise<any | undefined>} The raw `state` value, or undefined if not found.
 */
export async function getVersionState(id, fileId) {
  const r = await pool.query(
    'SELECT state FROM workbook_versions WHERE id = $1 AND file_id = $2',
    [id, fileId]
  );
  if (!r.rows || r.rows.length === 0) return undefined;
  return r.rows[0].state;
}

/**
 * Record a new version snapshot for a file.
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
}
