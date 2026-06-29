// @ts-check
import pg from 'pg';
import { applySchema } from '../../db/schema.js';

/**
 * @file tests/helpers/db.js
 * @description Per-test PostgreSQL database helper for the integration suite.
 *
 * The Testcontainers runner (tests/run-integration.mjs) starts one PostgreSQL
 * server and exposes its base connection string as DATABASE_URL. Each test calls
 * {@link createTestDb} to carve out its own throwaway database on that server, so
 * tests are fully isolated from one another without a shared, mutable file store.
 *
 * A test passes `db.url` as DATABASE_URL when it spawns `node server.js`, and uses
 * the seed/query helpers below to set up fixtures and assert on persisted state.
 */

let seq = 0;

/**
 * The base (admin) connection string the runner provisioned. Prefers the dedicated
 * TEST_PG_ADMIN_URL so that tests reassigning DATABASE_URL in-process can't break
 * database provisioning; falls back to DATABASE_URL.
 */
function adminConnectionString() {
  const url = process.env.TEST_PG_ADMIN_URL || process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'No test database URL is set. Run the integration tests via `npm test` ' +
      '(which boots a PostgreSQL container through tests/run-integration.mjs).'
    );
  }
  return url;
}

/** Return `base` with its database name swapped for `name`. */
function withDatabaseName(base, name) {
  const u = new URL(base);
  u.pathname = '/' + name;
  return u.toString();
}

/**
 * Create a fresh, isolated database on the shared test server, provision the schema,
 * and (by default) seed the legacy 'default' file + empty workbook so spawned servers
 * never race to seed it.
 *
 * @param {string} [label] Short label woven into the database name for debuggability.
 * @param {{ seedDefault?: boolean }} [opts]
 * @returns {Promise<TestDb>}
 */
export async function createTestDb(label = 'test', opts = {}) {
  const { seedDefault = true } = opts;
  const base = adminConnectionString();
  const name = `cs_${label}_${process.pid}_${Date.now().toString(36)}_${seq++}`
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .slice(0, 60);

  await withAdmin(base, async (admin) => {
    // Concurrent CREATE DATABASE calls can transiently collide on the template
    // database ("source database ... is being accessed by other users"); retry.
    let lastErr;
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        await admin.query(`CREATE DATABASE "${name}"`);
        return;
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
      }
    }
    throw lastErr;
  });

  const url = withDatabaseName(base, name);
  const pool = new pg.Pool({ connectionString: url });
  await applySchema(pool);

  const db = new TestDb(name, url, pool, base);
  if (seedDefault) {
    await db.seedFile('default', 'Untitled spreadsheet', 'system');
    await db.seedWorkbookState('default', {
      sheets: { Sheet1: {} },
      sheetOrder: ['Sheet1'],
      sheetColors: {},
      hiddenSheets: []
    });
  }
  return db;
}

/** Run `fn` with a short-lived admin client connected to `base`. */
async function withAdmin(base, fn) {
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  try {
    return await fn(admin);
  } finally {
    await admin.end();
  }
}

/** A throwaway test database with seed/inspect helpers. */
class TestDb {
  /**
   * @param {string} name
   * @param {string} url
   * @param {import('pg').Pool} pool
   * @param {string} adminUrl
   */
  constructor(name, url, pool, adminUrl) {
    this.name = name;
    this.url = url;
    this.pool = pool;
    this.adminUrl = adminUrl;
  }

  /** Run a raw query against this database. */
  query(sql, params) {
    return this.pool.query(sql, params);
  }

  /** Insert a files-registry row (no-op if it already exists). */
  async seedFile(id, name, createdBy = 'system') {
    await this.pool.query(
      'INSERT INTO files (id, name, created_by) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING',
      [id, name, createdBy]
    );
  }

  /** Upsert a workbook_state row for `key` with the given JS state object. */
  async seedWorkbookState(key, state) {
    await this.pool.query(
      `INSERT INTO workbook_state (key, state) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET state = EXCLUDED.state`,
      [key, JSON.stringify(state)]
    );
  }

  /** Read back a workbook's persisted state object (or undefined). */
  async getWorkbookState(key = 'default') {
    const r = await this.pool.query('SELECT state FROM workbook_state WHERE key = $1', [key]);
    return r.rows[0] ? r.rows[0].state : undefined;
  }

  /** Read back the cells map for a given workbook + sheet (or undefined). */
  async getCells(key = 'default', sheet = 'Sheet1') {
    const state = await this.getWorkbookState(key);
    return state && state.sheets ? state.sheets[sheet] : undefined;
  }

  /** Insert a workbook_versions snapshot; returns its generated id. */
  async seedVersion(state, createdBy, fileId = 'default') {
    const r = await this.pool.query(
      'INSERT INTO workbook_versions (file_id, state, created_by) VALUES ($1, $2, $3) RETURNING id',
      [fileId, JSON.stringify(state), createdBy]
    );
    return r.rows[0].id;
  }

  /** All version rows (id ascending), with parsed state. */
  async listVersions() {
    const r = await this.pool.query(
      'SELECT id, state, created_at, created_by FROM workbook_versions ORDER BY id ASC'
    );
    return r.rows;
  }

  /** Close the pool and drop the database. Safe to call once, in a test's finally. */
  async cleanup() {
    try {
      await this.pool.end();
    } catch (e) { /* ignore */ }
    await withAdmin(this.adminUrl, async (admin) => {
      await admin.query(`DROP DATABASE IF EXISTS "${this.name}" WITH (FORCE)`);
    });
  }
}
