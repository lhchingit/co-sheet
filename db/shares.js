// @ts-check
import { pool } from './pool.js';

/**
 * @file db/shares.js
 * @description Data-access functions for the `file_shares` table (view/edit grants).
 * Raw SQL only.
 */

/**
 * The share role a user holds on a file, if any.
 * @param {string} fileId
 * @param {string} userId
 * @returns {Promise<'owner'|'editor'|'viewer'|null>}
 */
export async function getShareRole(fileId, userId) {
  const r = await pool.query('SELECT role FROM file_shares WHERE file_id = $1 AND user_id = $2', [fileId, userId]);
  const row = r.rows && r.rows[0];
  return row ? (row.role || 'viewer') : null;
}

/**
 * Identity keys of the users a file has been explicitly shared with.
 * @param {string} fileId
 * @returns {Promise<any[]>}
 */
export async function listShareUserIds(fileId) {
  const r = await pool.query('SELECT user_id FROM file_shares WHERE file_id = $1', [fileId]);
  return r.rows || [];
}

/**
 * All (user_id, role) share rows for a file.
 * @param {string} fileId
 * @returns {Promise<any[]>}
 */
export async function listSharesByFile(fileId) {
  const r = await pool.query('SELECT user_id, role FROM file_shares WHERE file_id = $1', [fileId]);
  return r.rows || [];
}

/**
 * All (file_id, role) share rows for a user.
 * @param {string} userId
 * @returns {Promise<any[]>}
 */
export async function listSharesByUser(userId) {
  const r = await pool.query('SELECT file_id, role FROM file_shares WHERE user_id = $1', [userId]);
  return r.rows || [];
}

/**
 * The file ids shared with a user.
 * @param {string} userId
 * @returns {Promise<any[]>}
 */
export async function listSharedFileIds(userId) {
  const r = await pool.query('SELECT file_id FROM file_shares WHERE user_id = $1', [userId]);
  return r.rows || [];
}

/**
 * Grant or update a share (upsert on the (file_id, user_id) key).
 * @param {string} fileId
 * @param {string} userId
 * @param {string} role
 * @returns {Promise<void>}
 */
export async function upsertShare(fileId, userId, role) {
  await pool.query(
    'INSERT INTO file_shares (file_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (file_id, user_id) DO UPDATE SET role = EXCLUDED.role',
    [fileId, userId, role]
  );
}

/**
 * Insert a share row without conflict handling (used when copying to a brand-new file).
 * @param {string} fileId
 * @param {string} userId
 * @param {string} role
 * @returns {Promise<void>}
 */
export async function insertShare(fileId, userId, role) {
  await pool.query(
    'INSERT INTO file_shares (file_id, user_id, role) VALUES ($1, $2, $3)',
    [fileId, userId, role]
  );
}

/**
 * Change an existing share's role. Returns the pg result so callers can inspect rowCount.
 * @param {string} fileId
 * @param {string} userId
 * @param {string} role
 * @returns {Promise<{ rows: any[], rowCount?: number }>}
 */
export async function updateShareRole(fileId, userId, role) {
  return pool.query('UPDATE file_shares SET role = $3 WHERE file_id = $1 AND user_id = $2', [fileId, userId, role]);
}

/**
 * Remove a single share.
 * @param {string} fileId
 * @param {string} userId
 * @returns {Promise<void>}
 */
export async function deleteShare(fileId, userId) {
  await pool.query('DELETE FROM file_shares WHERE file_id = $1 AND user_id = $2', [fileId, userId]);
}

/**
 * Remove all shares for a file.
 * @param {string} fileId
 * @returns {Promise<void>}
 */
export async function deleteSharesByFile(fileId) {
  await pool.query('DELETE FROM file_shares WHERE file_id = $1', [fileId]);
}
