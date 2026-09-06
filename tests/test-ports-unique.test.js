process.env.NODE_ENV = 'test';

/**
 * @file test-ports-unique.test.js
 * @description No two test files may claim the same TCP port.
 *
 * `node --test` runs test FILES in parallel, so two files that bind the same port
 * are a race: whichever loses gets EADDRINUSE, or its client gets ECONNRESET when
 * it reaches the other file's server and that server is torn down. It fails
 * intermittently and only when the scheduler happens to overlap those two files —
 * which is to say, it fails when someone adds an unrelated test and changes the
 * scheduling.
 *
 * That is exactly what happened: ws-compression.test.js and
 * realtime-multi-instance.test.js both used 31401, harmlessly for months, until a
 * new file shifted the order and the suite started failing on main with an
 * ECONNRESET. Picking a port by reading the other files and hoping is what got us
 * here, so this asserts it instead.
 *
 * The suite uses the 31000-32999 range exclusively for ports, so any number in it
 * is one. Timeouts and limits live outside that range (300000, 30000, …) and are
 * not matched.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
/** Ports live here; nothing else in the suite uses a number in this range. */
const PORT_PATTERN = /\b(3[12][0-9]{3})\b/g;

test('no two test files claim the same port', () => {
  // --- Arrange ---
  const files = readdirSync(TESTS_DIR).filter((f) => f.endsWith('.test.js'));
  assert.ok(files.length > 20, `expected to find the suite, saw ${files.length} files`);

  // --- Act ---
  /** @type {Map<string, string[]>} port -> the files that claim it */
  const claims = new Map();
  for (const file of files) {
    if (file === path.basename(fileURLToPath(import.meta.url))) continue; // this file names ports in prose
    const src = readFileSync(path.join(TESTS_DIR, file), 'utf8');
    for (const port of new Set(src.match(PORT_PATTERN) || [])) {
      if (!claims.has(port)) claims.set(port, []);
      claims.get(port).push(file);
    }
  }

  // --- Assert ---
  const shared = [...claims.entries()].filter(([, owners]) => owners.length > 1);
  assert.deepStrictEqual(
    shared.map(([port, owners]) => `${port}: ${owners.join(', ')}`), [],
    'test files run in parallel, so a port may be claimed by only one of them'
  );
});
