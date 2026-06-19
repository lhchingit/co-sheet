// @ts-check
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer } from '@testcontainers/redis';
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * @file tests/run-integration.mjs
 * @description Integration-test entrypoint. Boots throwaway PostgreSQL and Redis
 * servers via Testcontainers, exposes them as DATABASE_URL / REDIS_URL, then runs
 * the Node test runner against them. Each test carves out its own database on the
 * PostgreSQL server (see tests/helpers/db.js), so the suite exercises real SQL
 * end-to-end with no mock. With Redis present, the cross-instance realtime fan-out
 * tests (tests/realtime_multi_instance.test.js) run instead of skipping.
 *
 * Usage:
 *   node tests/run-integration.mjs [node --test flags] [test files]
 *
 * Any argument starting with "-" is forwarded to `node --test` (e.g. coverage and
 * reporter flags); any other argument is treated as a test file/path. With no file
 * arguments, every tests/*.test.js file is discovered and run.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POSTGRES_IMAGE = process.env.TEST_POSTGRES_IMAGE || 'postgres:16-alpine';
const REDIS_IMAGE = process.env.TEST_REDIS_IMAGE || 'redis:7-alpine';

async function main() {
  const passthrough = process.argv.slice(2);
  const flags = passthrough.filter((a) => a.startsWith('-'));
  const paths = passthrough.filter((a) => !a.startsWith('-'));

  let testFiles = paths;
  if (testFiles.length === 0) {
    testFiles = readdirSync(__dirname)
      .filter((f) => f.endsWith('.test.js'))
      .sort()
      .map((f) => path.join('tests', f));
  }

  console.log(`[run-integration] starting ${POSTGRES_IMAGE} and ${REDIS_IMAGE} containers...`);
  const [pgContainer, redisContainer] = await Promise.all([
    new PostgreSqlContainer(POSTGRES_IMAGE).start(),
    new RedisContainer(REDIS_IMAGE).start(),
  ]);
  const baseUri = pgContainer.getConnectionUri();
  process.env.DATABASE_URL = baseUri;
  // A stable admin URL the helper uses to create/drop per-test databases. Kept
  // separate from DATABASE_URL so in-process tests can freely reassign DATABASE_URL
  // without breaking database provisioning.
  process.env.TEST_PG_ADMIN_URL = baseUri;
  // Exposing REDIS_URL flips the cross-instance realtime tests from skipped to live.
  process.env.REDIS_URL = redisContainer.getConnectionUrl();
  console.log('[run-integration] containers ready; launching test runner.');

  const args = ['--test', ...flags, ...testFiles];
  const child = spawn(process.execPath, args, { stdio: 'inherit', env: process.env });

  const code = await new Promise((resolve) => {
    child.on('exit', (c, signal) => resolve(c == null ? (signal ? 1 : 0) : c));
  });

  console.log('[run-integration] stopping containers...');
  await Promise.all([pgContainer.stop(), redisContainer.stop()]);
  process.exit(code);
}

main().catch((err) => {
  console.error('[run-integration] fatal error:', err);
  process.exit(1);
});
