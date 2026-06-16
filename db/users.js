// @ts-check
import { pool } from './pool.js';

/**
 * @file db/users.js
 * @description Data-access functions for the `users` table (the permissions-page
 * directory of everyone who has signed in). These wrap raw SQL only; identity
 * derivation and role/env authority live in the caller.
 */

/**
 * Fetch a user's stored id and role.
 * @param {string} id Identity key (lowercased email or username).
 * @returns {Promise<{ id: string, role: string } | null>}
 */
export async function findUserById(id) {
  const res = await pool.query('SELECT id, role FROM users WHERE id = $1', [id]);
  return (res.rows && res.rows[0]) || null;
}

/**
 * Insert a new user row, stamping last_login to now.
 * @param {{ id: string, username: string|null, email: string|null, role: string, provider: string|null }} user
 * @returns {Promise<void>}
 */
export async function insertUser({ id, username, email, role, provider }) {
  await pool.query(
    'INSERT INTO users (id, username, email, role, provider, last_login) VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)',
    [id, username, email, role, provider]
  );
}

/**
 * Update an existing user's profile fields and bump last_login.
 * @param {{ id: string, username: string|null, email: string|null, provider: string|null, role: string }} user
 * @returns {Promise<void>}
 */
export async function updateUserProfile({ id, username, email, provider, role }) {
  await pool.query(
    'UPDATE users SET username = $1, email = $2, provider = $3, role = $4, last_login = CURRENT_TIMESTAMP WHERE id = $5',
    [username, email, provider, role, id]
  );
}

/**
 * Change a user's role only.
 * @param {string} id
 * @param {string} role
 * @returns {Promise<void>}
 */
export async function updateUserRole(id, role) {
  await pool.query('UPDATE users SET role = $1 WHERE id = $2', [role, id]);
}

/**
 * List all users for the permissions page, most-recently-active first.
 * @returns {Promise<any[]>}
 */
export async function listUsers() {
  const res = await pool.query(
    'SELECT id, username, email, role, provider, last_login FROM users ORDER BY last_login DESC'
  );
  return res.rows || [];
}

/**
 * List all users with the fields needed for directory search.
 * @returns {Promise<any[]>}
 */
export async function listUsersForSearch() {
  const res = await pool.query('SELECT id, username, email, role FROM users');
  return res.rows || [];
}

/**
 * List all users with the minimal fields needed to resolve share entries.
 * @returns {Promise<any[]>}
 */
export async function listUsersBasic() {
  const res = await pool.query('SELECT id, username, email FROM users');
  return res.rows || [];
}

/**
 * List just the identity keys of every known user.
 * @returns {Promise<any[]>}
 */
export async function listUserIds() {
  const res = await pool.query('SELECT id FROM users');
  return res.rows || [];
}
