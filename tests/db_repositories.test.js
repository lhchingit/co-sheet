/**
 * @file db_repositories.test.js
 * @description Direct integration tests for the db/ repository layer. The rest of the
 * suite drives these functions indirectly through spawned server processes, where
 * `--experimental-test-coverage` cannot see them; here we import each repository
 * module in-process against a real, isolated PostgreSQL database and exercise every
 * exported function, asserting the actual SQL behavior (inserts, upserts, ON CONFLICT,
 * rowCount, NULL handling).
 *
 * The database modules bind to `DATABASE_URL` at import time, so this file creates its
 * own database, points `DATABASE_URL` at it, and only then dynamically imports them.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert';
import pg from 'pg';

const ADMIN_URL = process.env.TEST_PG_ADMIN_URL || process.env.DATABASE_URL;
const DB_NAME = `cs_repos_${process.pid}_${Date.now().toString(36)}`;

/** @type {Record<string, any>} */
let repo;

before(async () => {
  if (!ADMIN_URL) {
    throw new Error(
      'No test database URL is set. Run via `npm test` (Testcontainers boots PostgreSQL).'
    );
  }

  // Provision a dedicated database for this file.
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${DB_NAME}"`);
  } finally {
    await admin.end();
  }

  // Point the connection layer at the new database BEFORE importing it (db/pool.js
  // reads DATABASE_URL once, at import time).
  const u = new URL(ADMIN_URL);
  u.pathname = '/' + DB_NAME;
  process.env.DATABASE_URL = u.toString();

  const schema = await import('../db/schema.js');
  // Provision schema + seed the default file/workbook. Exercises initDatabase end to end.
  await schema.initDatabase();

  repo = {
    schema,
    files: await import('../db/files.js'),
    workbook: await import('../db/workbook.js'),
    versions: await import('../db/versions.js'),
    shares: await import('../db/shares.js'),
    stars: await import('../db/stars.js'),
    users: await import('../db/users.js'),
    pool: (await import('../db/pool.js')).pool
  };
});

after(async () => {
  try {
    if (repo && repo.pool) await repo.pool.end();
  } catch (e) { /* ignore */ }
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${DB_NAME}" WITH (FORCE)`);
  } finally {
    await admin.end();
  }
});

test('initDatabase seeds the default file and workbook', async () => {
  const { files, workbook } = repo;
  const ids = (await files.listAllFileIds()).map((r) => r.id);
  assert.ok(ids.includes('default'), 'default file should be seeded');
  assert.strictEqual(await workbook.workbookKeyExists('default'), true, 'default workbook seeded');

  // Re-running is idempotent: it must not duplicate the default file/workbook.
  await repo.schema.initDatabase();
  const idsAgain = (await files.listAllFileIds()).map((r) => r.id);
  assert.strictEqual(idsAgain.filter((id) => id === 'default').length, 1, 'no duplicate default file');
});

test('files repository - CRUD, metadata, link access, and NULL handling', async () => {
  const { files } = repo;

  await files.insertFile('f1', 'My File', 'alice');

  assert.strictEqual(await files.getFileName('f1'), 'My File');
  assert.strictEqual(await files.getFileOwner('f1'), 'alice');
  assert.strictEqual(await files.getFileLinkAccess('f1'), 'restricted', 'new files are restricted by default');

  const row = await files.getFileRow('f1');
  assert.strictEqual(row.name, 'My File');
  assert.strictEqual(row.created_by, 'alice');
  assert.ok(row.created_at, 'created_at present');

  const all = await files.listFiles();
  assert.ok(all.some((f) => f.id === 'f1') && all.some((f) => f.id === 'default'));

  const mine = (await files.listFileIdsByCreator('alice')).map((r) => r.id);
  assert.deepStrictEqual(mine, ['f1']);

  const rename = await files.renameFile('f1', 'Renamed');
  assert.strictEqual(rename.rowCount, 1, 'rename touches exactly one row');
  assert.strictEqual(await files.getFileName('f1'), 'Renamed');

  await files.updateFileLinkAccess('f1', 'anyone');
  assert.strictEqual(await files.getFileLinkAccess('f1'), 'anyone');

  await files.deleteFile('f1');
  assert.strictEqual(await files.getFileName('f1'), null, 'deleted file has no name');

  // Missing rows return null, not throw.
  assert.strictEqual(await files.getFileName('nope'), null);
  assert.strictEqual(await files.getFileOwner('nope'), null);
  assert.strictEqual(await files.getFileLinkAccess('nope'), null);
  assert.strictEqual(await files.getFileRow('nope'), null);
});

test('workbook repository - state read/write, existence, timestamps, delete', async () => {
  const { workbook } = repo;

  const seeded = await workbook.getWorkbookState('default');
  assert.ok(seeded && seeded.sheets && seeded.sheets.Sheet1, 'seeded default workbook has Sheet1');
  assert.ok(await workbook.getWorkbookUpdatedAt('default'), 'default has an updated_at');

  await workbook.insertWorkbookState(JSON.stringify({ sheets: { Sheet1: {} } }), 'wb1');
  assert.strictEqual(await workbook.workbookKeyExists('wb1'), true);

  await workbook.updateWorkbookState(JSON.stringify({ sheets: { Sheet1: { A1: { value: 'x' } } } }), 'wb1');
  const wb1 = await workbook.getWorkbookState('wb1');
  assert.strictEqual(wb1.sheets.Sheet1.A1.value, 'x');

  await workbook.updateDefaultWorkbookState(JSON.stringify({ sheets: { Sheet1: { B2: { value: 'd' } } } }));
  const def = await workbook.getWorkbookState('default');
  assert.strictEqual(def.sheets.Sheet1.B2.value, 'd');

  await workbook.deleteWorkbookState('wb1');
  assert.strictEqual(await workbook.workbookKeyExists('wb1'), false);
  assert.strictEqual(await workbook.getWorkbookState('wb1'), undefined);
  assert.strictEqual(await workbook.getWorkbookUpdatedAt('missing'), null);
});

test('versions repository - insert, list newest-first, fetch state (per file)', async () => {
  const { versions } = repo;

  assert.deepStrictEqual(await versions.listVersions('default'), [], 'no versions initially');

  await versions.insertVersion(JSON.stringify({ sheets: { Sheet1: { A1: { value: 'v1' } } } }), 'alice', 'default');
  await versions.insertVersion(JSON.stringify({ sheets: { Sheet1: { A1: { value: 'v2' } } } }), 'bob', 'default');
  // A version for a different file must not leak into 'default'.
  await versions.insertVersion(JSON.stringify({ sheets: { Sheet1: { A1: { value: 'other' } } } }), 'carol', 'file-xyz');

  const list = await versions.listVersions('default');
  assert.strictEqual(list.length, 2, 'only this file\'s versions are listed');
  assert.strictEqual(list[0].id, 2, 'newest first (id DESC)');
  assert.strictEqual(list[0].created_by, 'bob');
  assert.strictEqual(list[0].state, undefined, 'list metadata omits the state payload');

  const otherList = await versions.listVersions('file-xyz');
  assert.strictEqual(otherList.length, 1, 'other file has its own version history');
  assert.strictEqual(otherList[0].created_by, 'carol');

  const state = await versions.getVersionState(1, 'default');
  assert.strictEqual(state.sheets.Sheet1.A1.value, 'v1');
  // A version id is only fetchable through its own file.
  assert.strictEqual(await versions.getVersionState(3, 'default'), undefined, 'cross-file id => undefined');
  assert.strictEqual(await versions.getVersionState(99999, 'default'), undefined, 'missing version => undefined');
});

test('shares repository - upsert, role changes, listings, and deletes', async () => {
  const { files, shares } = repo;
  await files.insertFile('sf', 'Shared', 'owner');

  assert.strictEqual(await shares.getShareRole('sf', 'bob'), null, 'no share yet');

  await shares.upsertShare('sf', 'bob', 'viewer');
  assert.strictEqual(await shares.getShareRole('sf', 'bob'), 'viewer');

  // ON CONFLICT (file_id, user_id) DO UPDATE.
  await shares.upsertShare('sf', 'bob', 'editor');
  assert.strictEqual(await shares.getShareRole('sf', 'bob'), 'editor', 'upsert updates the role');

  assert.deepStrictEqual((await shares.listShareUserIds('sf')).map((r) => r.user_id), ['bob']);
  assert.deepStrictEqual(await shares.listSharesByFile('sf'), [{ user_id: 'bob', role: 'editor' }]);
  assert.deepStrictEqual(await shares.listSharesByUser('bob'), [{ file_id: 'sf', role: 'editor' }]);
  assert.deepStrictEqual((await shares.listSharedFileIds('bob')).map((r) => r.file_id), ['sf']);

  const upd = await shares.updateShareRole('sf', 'bob', 'viewer');
  assert.strictEqual(upd.rowCount, 1);
  assert.strictEqual(await shares.getShareRole('sf', 'bob'), 'viewer');

  await shares.insertShare('sf', 'carol', 'editor');
  assert.strictEqual(await shares.getShareRole('sf', 'carol'), 'editor');

  await shares.deleteShare('sf', 'bob');
  assert.strictEqual(await shares.getShareRole('sf', 'bob'), null);

  await shares.deleteSharesByFile('sf');
  assert.deepStrictEqual(await shares.listShareUserIds('sf'), []);
});

test('stars repository - per-user favourites with idempotent add and deletes', async () => {
  const { stars } = repo;

  assert.deepStrictEqual(await stars.listStarredFileIds('bob'), [], 'no stars yet');

  await stars.addStar('starred', 'bob');
  await stars.addStar('starred', 'bob'); // ON CONFLICT DO NOTHING
  const starred = (await stars.listStarredFileIds('bob')).map((r) => r.file_id);
  assert.deepStrictEqual(starred, ['starred'], 'starring is idempotent');

  await stars.addStar('starred2', 'bob');
  await stars.removeStar('starred', 'bob');
  assert.deepStrictEqual((await stars.listStarredFileIds('bob')).map((r) => r.file_id), ['starred2']);

  await stars.deleteStarsByFile('starred2');
  assert.deepStrictEqual(await stars.listStarredFileIds('bob'), []);
});

test('users repository - insert, profile/role updates, and directory listings', async () => {
  const { users } = repo;

  assert.strictEqual(await users.findUserById('alice'), null, 'unknown user => null');

  await users.insertUser({ id: 'alice', username: 'Alice', email: 'a@example.com', role: 'user', provider: 'test' });
  const found = await users.findUserById('alice');
  assert.deepStrictEqual(found, { id: 'alice', role: 'user' });

  await users.updateUserProfile({ id: 'alice', username: 'Alice2', email: 'a2@example.com', provider: 'test', role: 'admin' });
  assert.strictEqual((await users.findUserById('alice')).role, 'admin');

  await users.updateUserRole('alice', 'user');
  assert.strictEqual((await users.findUserById('alice')).role, 'user');

  // A second user, so the directory listings have more than one row to return.
  await users.insertUser({ id: 'bob', username: 'Bob', email: 'b@example.com', role: 'user', provider: 'test', picture: 'p.png' });

  const list = await users.listUsers();
  assert.ok(list.some((u) => u.id === 'alice') && list.some((u) => u.id === 'bob'));

  const search = await users.listUsersForSearch();
  assert.ok(search.some((u) => u.id === 'alice' && u.email === 'a2@example.com'));

  const basic = await users.listUsersBasic();
  assert.ok(basic.some((u) => u.id === 'bob' && u.username === 'Bob'));

  const ids = (await users.listUserIds()).map((r) => r.id);
  assert.ok(ids.includes('alice') && ids.includes('bob'));
});
