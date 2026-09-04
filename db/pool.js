// @ts-check
import pg from 'pg';

/**
 * @file db/pool.js
 * @description Database connection layer. Exports a single `pool` object exposing a
 * `query(text, params)` / `end()` interface backed by a real `pg.Pool` connected via
 * DATABASE_URL. The rest of the application depends only on this `query` contract.
 *
 * Tests run against a real PostgreSQL server provisioned per-test by Testcontainers
 * (see tests/run-integration.mjs and tests/helpers/db.js); they pass a DATABASE_URL
 * pointing at a throwaway database, so there is no in-process mock here.
 */

// The `created_at` / `last_login` columns are `TIMESTAMP WITHOUT TIME ZONE` and are
// written with `CURRENT_TIMESTAMP` on a UTC database session, i.e. they hold UTC
// wall-clock values. By default node-postgres parses such columns into a JS Date
// using the *Node process* local time zone, which mislabels the instant whenever the
// server is not running in UTC (e.g. a UTC+8 host renders the value back as the raw
// UTC time). Force OID 1114 to be interpreted as UTC so the serialized ISO string is
// a correct absolute instant and the browser can convert it to the viewer's zone.
pg.types.setTypeParser(1114, (val) =>
  val == null ? val : new Date(val.replace(' ', 'T') + 'Z')
);

/** @type {{ query(text: string, params?: any[]): Promise<{ rows: any[], rowCount?: number }>, end(): Promise<void> }} */
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  // Stated rather than inherited. This is the ceiling on concurrent database work
  // for the whole process, so it belongs in the code as a decision: a burst of
  // workbook writes queues behind it, and everything else — sign-in, the drive
  // listing — queues behind that. node-postgres' own default is 10; keeping that
  // value here changes nothing today but makes the bound visible and tunable.
  max: Number.parseInt(process.env.PG_POOL_MAX || '10', 10)
});

export { pool };
