process.env.NODE_ENV = 'test';

/**
 * @file db-workbook-state-text.test.js
 * @description Both state columns — `workbook_state.state` and
 * `workbook_versions.state` — are TEXT, not JSONB: nothing ever uses a JSON operator
 * on either, so JSONB only bought parsing, validating and re-encoding a whole
 * workbook on every write (~2.7x a text write for the same payload).
 *
 * Two things have to hold. A database provisioned while the column was JSONB must
 * convert, with its contents intact. And the conversion must not run again once it
 * has: `ALTER COLUMN … TYPE` rewrites the table, so an unguarded statement would
 * rewrite it on every boot. A rewrite is observable — it changes the table's
 * relfilenode — which is what these assert on rather than trusting the guard by
 * inspection.
 *
 * That the repository still hands callers a state OBJECT across the type change is
 * covered by db-repositories.test.js, which imports db/workbook.js against its own
 * database and reads `state.sheets.Sheet1` back. Follows the AAA pattern.
 */
import test from 'node:test';
import assert from 'node:assert';
import { createTestDb } from './helpers/db.js';
import { applySchema } from '../db/schema.js';

/** The declared type of a table's `state` column. */
async function stateColumnType(db, table) {
  const r = await db.query(
    `SELECT data_type FROM information_schema.columns
      WHERE table_name = $1 AND column_name = 'state'`,
    [table]
  );
  return r.rows[0].data_type;
}

/** A table's on-disk file id; it changes if and only if the table is rewritten. */
async function relfilenode(db, table) {
  const r = await db.query('SELECT relfilenode FROM pg_class WHERE relname = $1', [table]);
  return String(r.rows[0].relfilenode);
}

test('a database provisioned with a JSONB state column converts, keeping its data', async () => {
  // --- Arrange: wind the schema back to how it was provisioned before ---
  const db = await createTestDb('statetype');

  try {
    await db.query('ALTER TABLE workbook_state ALTER COLUMN state TYPE JSONB USING state::jsonb');
    assert.strictEqual(await stateColumnType(db, 'workbook_state'), 'jsonb', 'the old shape is in place');

    await db.query(
      `INSERT INTO workbook_state (key, state) VALUES ('legacy', $1)
       ON CONFLICT (key) DO UPDATE SET state = EXCLUDED.state`,
      [JSON.stringify({ sheets: { Sheet1: { A1: { formula: '', value: 'kept', style: { bold: true } } } } })]
    );
    const before = await relfilenode(db, 'workbook_state');

    // --- Act ---
    await applySchema(db.pool);

    // --- Assert ---
    assert.strictEqual(await stateColumnType(db, 'workbook_state'), 'text', 'the column converted');
    assert.notStrictEqual(await relfilenode(db, 'workbook_state'), before, 'the conversion rewrote the table, once');

    const state = await db.getWorkbookState('legacy');
    assert.strictEqual(state.sheets.Sheet1.A1.value, 'kept', 'the document survived the conversion');
    assert.deepStrictEqual(state.sheets.Sheet1.A1.style, { bold: true }, 'including its formatting');
  } finally {
    await db.cleanup();
  }
});

test('re-provisioning an already-converted database does not rewrite the table', async () => {
  // The reason the migration is guarded on the current column type. Every server
  // start runs applySchema, so an unguarded ALTER would rewrite workbook_state on
  // every boot — and take a lock for the duration each time.
  const db = await createTestDb('statetype2');

  try {
    assert.strictEqual(await stateColumnType(db, 'workbook_state'), 'text', 'a fresh database is already TEXT');
    const before = await relfilenode(db, 'workbook_state');

    // --- Act: two more boots' worth of provisioning ---
    await applySchema(db.pool);
    await applySchema(db.pool);

    // --- Assert ---
    assert.strictEqual(await relfilenode(db, 'workbook_state'), before, 'the table was not rewritten');
    assert.strictEqual(await stateColumnType(db, 'workbook_state'), 'text', 'and is still TEXT');
  } finally {
    await db.cleanup();
  }
});

test('a JSONB workbook_versions column converts, keeping its snapshots', async () => {
  // The same migration on the other state column. It is ordered after the retention
  // work because it rewrites every row, and until history was pruned to the newest
  // 100 per file that table had no bound at all.
  const db = await createTestDb('versiontype');

  try {
    await db.query('ALTER TABLE workbook_versions ALTER COLUMN state TYPE JSONB USING state::jsonb');
    assert.strictEqual(await stateColumnType(db, 'workbook_versions'), 'jsonb');
    await db.seedVersion({ sheets: { Sheet1: { C3: { formula: '', value: 'snapshot', style: {} } } } }, 'alice');
    const before = await relfilenode(db, 'workbook_versions');

    await applySchema(db.pool);

    assert.strictEqual(await stateColumnType(db, 'workbook_versions'), 'text', 'the column converted');
    assert.notStrictEqual(await relfilenode(db, 'workbook_versions'), before, 'the table was rewritten, once');

    const rows = await db.listVersions();
    assert.strictEqual(rows[0].state.sheets.Sheet1.C3.value, 'snapshot', 'the snapshot survived');

    // And re-provisioning leaves it alone, as for workbook_state.
    const after = await relfilenode(db, 'workbook_versions');
    await applySchema(db.pool);
    assert.strictEqual(await relfilenode(db, 'workbook_versions'), after, 'no rewrite on the next boot');
  } finally {
    await db.cleanup();
  }
});
