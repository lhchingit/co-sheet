// @ts-check
import { pool } from './pool.js';
import { listAllFileIds, insertFile } from './files.js';
import { workbookKeyExists, insertWorkbookState } from './workbook.js';

/**
 * @file db/schema.js
 * @description Schema provisioning. Creates the tables (idempotently) and seeds the
 * legacy 'default' workbook on a fresh database.
 */

/**
 * Provisions all tables (idempotently) on the given connection. Contains no seeding,
 * so it is safe to run against any database — the runtime uses it via initDatabase()
 * and the integration-test helper uses it to prepare a throwaway database before
 * seeding fixtures.
 * @param {{ query(text: string, params?: any[]): Promise<any> }} db
 * @returns {Promise<void>}
 */
export async function applySchema(db) {
  // Provision workbook_state table. `state` is TEXT, not JSONB: nothing in the
  // codebase ever uses a JSON operator on it — every read is `SELECT state` followed
  // by JSON.parse in JavaScript — so JSONB only bought parsing, validating and
  // re-encoding the whole document on every write, measured at ~2.7x the cost of a
  // text write for the same payload.
  await db.query(`
    CREATE TABLE IF NOT EXISTS workbook_state (
      key VARCHAR(50) PRIMARY KEY,
      state TEXT,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // Convert databases provisioned while the column was JSONB. Guarded on the
  // current type rather than run unconditionally: ALTER COLUMN ... TYPE rewrites
  // the table, so an unguarded statement would rewrite it on every boot.
  await db.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_name = 'workbook_state' AND column_name = 'state' AND data_type = 'jsonb'
      ) THEN
        ALTER TABLE workbook_state ALTER COLUMN state TYPE TEXT USING state::text;
      END IF;
    END $$;
  `);

  // Provision workbook_versions table for version history tracking. `file_id`
  // scopes each snapshot to its workbook; the legacy single-document behavior maps
  // to the 'default' file id.
  await db.query(`
    CREATE TABLE IF NOT EXISTS workbook_versions (
      id SERIAL PRIMARY KEY,
      file_id TEXT NOT NULL DEFAULT 'default',
      state TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      created_by TEXT NOT NULL
    )
  `);
  // TEXT for the same reason as workbook_state: no JSON operator is ever used on
  // this column, so JSONB only bought parsing, validating and re-encoding a whole
  // workbook copy on every snapshot. Guarded on the current type — ALTER COLUMN ...
  // TYPE rewrites the table, and applySchema runs on every server start.
  //
  // Ordered after the retention work on purpose: this rewrites every row, and until
  // history was pruned to the newest 100 per file the table had no bound at all.
  await db.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_name = 'workbook_versions' AND column_name = 'state' AND data_type = 'jsonb'
      ) THEN
        ALTER TABLE workbook_versions ALTER COLUMN state TYPE TEXT USING state::text;
      END IF;
    END $$;
  `);
  // Idempotent migration for databases provisioned before version history was
  // per-file: existing rows belong to the legacy 'default' workbook.
  await db.query(`ALTER TABLE workbook_versions ADD COLUMN IF NOT EXISTS file_id TEXT NOT NULL DEFAULT 'default'`);
  // Speeds up the per-file, newest-first listing the version-history sidebar issues.
  await db.query(`CREATE INDEX IF NOT EXISTS idx_workbook_versions_file_id ON workbook_versions (file_id, id DESC)`);

  // Provision files table backing the file-management interface. Each row is a
  // workbook whose cell data lives in workbook_state under the same key as files.id.
  await db.query(`
    CREATE TABLE IF NOT EXISTS files (
      id VARCHAR(64) PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      created_by TEXT,
      link_access TEXT NOT NULL DEFAULT 'restricted'
    )
  `);
  // Idempotent migration for databases provisioned before link_access existed.
  // 'restricted' = only owner/admin/shared users may open the file; 'anyone' = any
  // signed-in user with the link may open it (view-only).
  await db.query(`ALTER TABLE files ADD COLUMN IF NOT EXISTS link_access TEXT NOT NULL DEFAULT 'restricted'`);
  // listFileIdsByCreator backs the per-role file quota, checked on every file
  // creation; without this it scans the whole registry to count one user's files.
  await db.query(`CREATE INDEX IF NOT EXISTS idx_files_created_by ON files (created_by)`);

  // Provision the users table backing the permissions page. Each row is a user
  // who has signed in at least once; `role` is one of 'user' | 'admin' |
  // 'superadmin'. Super admins are initialized from the environment (see
  // SUPER_ADMIN_EMAILS) on login rather than seeded here.
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT,
      email TEXT,
      role TEXT NOT NULL DEFAULT 'user',
      provider TEXT,
      picture TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_login TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // Backfill the avatar column for databases created before it existed.
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS picture TEXT`);

  // Provision the file_shares table: each row grants a user access to a file owned
  // by someone else, surfacing that file in the user's drive listing. `role` is
  // 'editor' (can modify) or 'viewer' (read-only). New shares default to 'editor'
  // at the API; the column default is 'viewer' so any pre-existing rows (created
  // before roles existed) stay read-only.
  await db.query(`
    CREATE TABLE IF NOT EXISTS file_shares (
      file_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'viewer',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (file_id, user_id)
    )
  `);
  // Idempotent migration for databases provisioned before the role column existed.
  await db.query(`ALTER TABLE file_shares ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'viewer'`);
  // The primary key (file_id, user_id) serves the by-file lookups, but a btree can
  // only seek on a key prefix, so it cannot serve a lookup by user_id — which is
  // the direction the drive listing uses (listSharesByUser, on every load).
  await db.query(`CREATE INDEX IF NOT EXISTS idx_file_shares_user_id ON file_shares (user_id)`);

  // Provision the file_stars table: each row marks a file as "starred" (a personal
  // favourite) by a user. Starring is per-user — the same file may be starred by
  // some users and not others — so the drive's Starred view lists only the
  // signed-in user's own starred files.
  await db.query(`
    CREATE TABLE IF NOT EXISTS file_stars (
      file_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (file_id, user_id)
    )
  `);
  // Same as file_shares: the Starred view looks these up by user_id, which the
  // (file_id, user_id) primary key cannot answer.
  await db.query(`CREATE INDEX IF NOT EXISTS idx_file_stars_user_id ON file_stars (user_id)`);
}

/**
 * Provisions all tables and seeds the initial 'default' file and workbook state
 * if absent, using the runtime connection pool.
 * @returns {Promise<void>}
 */
export async function initDatabase() {
  await applySchema(pool);

  // On a first run (no files at all), surface the legacy 'default' workbook as a
  // file so the drive isn't empty and existing data is reachable. Once the user
  // has any files, we don't re-create 'default' — so deleting it sticks.
  const fileIds = await listAllFileIds();
  if (fileIds.length === 0) {
    await insertFile('default', 'Untitled spreadsheet', 'system');
  }

  // Seed the 'default' workbook state with default sheets and metadata if absent.
  if (!(await workbookKeyExists('default'))) {
    const freshSheets = Object.create(null);
    freshSheets['Sheet1'] = Object.create(null);
    const defaultState = {
      sheets: freshSheets,
      sheetOrder: ['Sheet1'],
      sheetColors: Object.create(null),
      hiddenSheets: []
    };
    await insertWorkbookState(JSON.stringify(defaultState), 'default');
  }
}
