// @ts-check
import { pool } from './pool.js';

/**
 * @file db/stars.js
 * @description Data-access functions for the `file_stars` table (per-user favourites).
 * Raw SQL only.
 */

/**
 * The file ids a user has starred.
 * @param {string} userId
 * @returns {Promise<any[]>}
 */
export async function listStarredFileIds(userId) {
  const r = await pool.query('SELECT file_id FROM file_stars WHERE user_id = $1', [userId]);
  return r.rows || [];
}

/**
 * Star a file for a user (no-op if already starred).
 * @param {string} fileId
 * @param {string} userId
 * @returns {Promise<void>}
 */
export async function addStar(fileId, userId) {
  await pool.query(
    'INSERT INTO file_stars (file_id, user_id) VALUES ($1, $2) ON CONFLICT (file_id, user_id) DO NOTHING',
    [fileId, userId]
  );
}

/**
 * Remove a user's star from a file.
 * @param {string} fileId
 * @param {string} userId
 * @returns {Promise<void>}
 */
export async function removeStar(fileId, userId) {
  await pool.query('DELETE FROM file_stars WHERE file_id = $1 AND user_id = $2', [fileId, userId]);
}

/**
 * Remove all stars for a file (used when the file is deleted).
 * @param {string} fileId
 * @returns {Promise<void>}
 */
export async function deleteStarsByFile(fileId) {
  await pool.query('DELETE FROM file_stars WHERE file_id = $1', [fileId]);
}
