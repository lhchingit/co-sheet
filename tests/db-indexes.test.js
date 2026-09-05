process.env.NODE_ENV = 'test';

/**
 * @file db-indexes.test.js
 * @description `file_shares` and `file_stars` are keyed (file_id, user_id), which a
 * btree can only seek on by its prefix — so neither key could serve the by-user_id
 * lookups the drive listing makes on every load, and `files.created_by` (the file
 * quota check) had no index at all. These tests assert the indexes exist AND that
 * the planner can actually use each one for the query it was added for; an index on
 * the wrong column would satisfy the first check and fail the second.
 * Follows the AAA pattern.
 */
import test from 'node:test';
import assert from 'node:assert';
import { createTestDb } from './helpers/db.js';

/**
 * Plan for `sql` with sequential scans disabled, on one pinned connection.
 * Turning seqscan off asks the planner "is there an index path for this predicate
 * at all?", which is the claim under test — on a table of a few rows it would
 * otherwise pick a sequential scan no matter what indexes exist.
 */
async function planWithoutSeqScan(db, sql) {
  const client = await db.pool.connect();
  try {
    await client.query('SET enable_seqscan = off');
    const r = await client.query(`EXPLAIN ${sql}`);
    return r.rows.map((row) => row['QUERY PLAN']).join('\n');
  } finally {
    client.release();
  }
}

test('the by-user and by-creator lookups each have an index the planner can use', async () => {
  // --- Arrange ---
  const db = await createTestDb('indexes');

  try {
    // A few rows so the tables are not empty; the planner is steered by
    // enable_seqscan rather than by data volume.
    await db.query("INSERT INTO files (id, name, created_by) VALUES ('f1', 'One', 'alice')");
    await db.query("INSERT INTO file_shares (file_id, user_id, role) VALUES ('f1', 'bob', 'editor')");
    await db.query("INSERT INTO file_stars (file_id, user_id) VALUES ('f1', 'bob')");

    // --- Act ---
    const indexes = await db.query(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname = 'public' AND indexname = ANY($1)`,
      [['idx_file_shares_user_id', 'idx_file_stars_user_id', 'idx_files_created_by']]
    );
    const byName = Object.fromEntries(indexes.rows.map((r) => [r.indexname, r.indexdef]));

    // --- Assert: they exist, on the column they are meant to be on ---
    assert.match(byName.idx_file_shares_user_id || '', /file_shares.*\(user_id\)/,
      'file_shares is indexed by user_id');
    assert.match(byName.idx_file_stars_user_id || '', /file_stars.*\(user_id\)/,
      'file_stars is indexed by user_id');
    assert.match(byName.idx_files_created_by || '', /files.*\(created_by\)/,
      'files is indexed by created_by');

    // --- Assert: and the planner has a path through them for the real queries ---
    // These are the statements from db/shares.js, db/stars.js and db/files.js.
    const sharesPlan = await planWithoutSeqScan(db,
      "SELECT file_id, role FROM file_shares WHERE user_id = 'bob'");
    assert.match(sharesPlan, /idx_file_shares_user_id/,
      `listSharesByUser can use the index:\n${sharesPlan}`);

    const starsPlan = await planWithoutSeqScan(db,
      "SELECT file_id FROM file_stars WHERE user_id = 'bob'");
    assert.match(starsPlan, /idx_file_stars_user_id/,
      `listStarredFileIds can use the index:\n${starsPlan}`);

    const filesPlan = await planWithoutSeqScan(db,
      "SELECT id FROM files WHERE created_by = 'alice'");
    assert.match(filesPlan, /idx_files_created_by/,
      `listFileIdsByCreator can use the index:\n${filesPlan}`);
  } finally {
    await db.cleanup();
  }
});

test('the composite primary keys are kept for the by-file direction', async () => {
  // The new indexes are an additional access path, not a replacement: the
  // (file_id, user_id) keys still serve listSharesByFile / deleteSharesByFile and
  // still enforce one row per (file, user).
  const db = await createTestDb('indexespk');

  try {
    await db.query("INSERT INTO file_shares (file_id, user_id, role) VALUES ('f1', 'bob', 'editor')");
    await assert.rejects(
      () => db.query("INSERT INTO file_shares (file_id, user_id, role) VALUES ('f1', 'bob', 'viewer')"),
      /duplicate key/,
      'a second share for the same (file, user) is still rejected'
    );

    const plan = await planWithoutSeqScan(db,
      "SELECT user_id, role FROM file_shares WHERE file_id = 'f1'");
    assert.match(plan, /file_shares_pkey/, `the by-file lookup still uses the primary key:\n${plan}`);
  } finally {
    await db.cleanup();
  }
});
