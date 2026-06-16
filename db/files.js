// @ts-check
import { pool } from './pool.js';

/**
 * @file db/files.js
 * @description Data-access functions for the `files` table (the drive / file-manager
 * registry). Raw SQL only; access-control decisions live in the caller.
 */

/**
 * Fetch a file's display name.
 * @param {string} fileId
 * @returns {Promise<string|null>}
 */
export async function getFileName(fileId) {
  const r = await pool.query('SELECT name FROM files WHERE id = $1', [fileId]);
  const row = r.rows && r.rows[0];
  return row && row.name ? row.name : null;
}

/**
 * Fetch a file's owner (created_by identity).
 * @param {string} fileId
 * @returns {Promise<string|null>}
 */
export async function getFileOwner(fileId) {
  const r = await pool.query('SELECT created_by FROM files WHERE id = $1', [fileId]);
  const row = r.rows && r.rows[0];
  return row ? (row.created_by || null) : null;
}

/**
 * Fetch a file's link-access mode ('restricted' | 'anyone').
 * @param {string} fileId
 * @returns {Promise<string|null>}
 */
export async function getFileLinkAccess(fileId) {
  const r = await pool.query('SELECT link_access FROM files WHERE id = $1', [fileId]);
  const row = r.rows && r.rows[0];
  return row ? (row.link_access || null) : null;
}

/**
 * Fetch the name/created_at/created_by row for a file's details view.
 * @param {string} fileId
 * @returns {Promise<{ name: string, created_at: any, created_by: string } | null>}
 */
export async function getFileRow(fileId) {
  const r = await pool.query('SELECT name, created_at, created_by FROM files WHERE id = $1', [fileId]);
  return (r.rows && r.rows[0]) || null;
}

/**
 * List all files, newest first.
 * @returns {Promise<any[]>}
 */
export async function listFiles() {
  const r = await pool.query(
    'SELECT id, name, created_at, created_by, link_access FROM files ORDER BY created_at DESC'
  );
  return r.rows || [];
}

/**
 * List the ids of every file created by a given user.
 * @param {string} creator
 * @returns {Promise<any[]>}
 */
export async function listFileIdsByCreator(creator) {
  const r = await pool.query('SELECT id FROM files WHERE created_by = $1', [creator]);
  return r.rows || [];
}

/**
 * List the ids of all files.
 * @returns {Promise<any[]>}
 */
export async function listAllFileIds() {
  const r = await pool.query('SELECT id FROM files');
  return r.rows || [];
}

/**
 * Insert a new file registry row.
 * @param {string} id
 * @param {string} name
 * @param {string} createdBy
 * @returns {Promise<void>}
 */
export async function insertFile(id, name, createdBy) {
  await pool.query(
    'INSERT INTO files (id, name, created_by) VALUES ($1, $2, $3)',
    [id, name, createdBy]
  );
}

/**
 * Rename a file. Returns the pg result so callers can inspect rowCount.
 * @param {string} id
 * @param {string} name
 * @returns {Promise<{ rows: any[], rowCount?: number }>}
 */
export async function renameFile(id, name) {
  return pool.query('UPDATE files SET name = $1 WHERE id = $2', [name, id]);
}

/**
 * Update a file's link-access mode.
 * @param {string} id
 * @param {string} linkAccess
 * @returns {Promise<void>}
 */
export async function updateFileLinkAccess(id, linkAccess) {
  await pool.query('UPDATE files SET link_access = $1 WHERE id = $2', [linkAccess, id]);
}

/**
 * Delete a file registry row.
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function deleteFile(id) {
  await pool.query('DELETE FROM files WHERE id = $1', [id]);
}
