process.env.NODE_ENV = 'test';

/**
 * @file asset-compression-caching.test.js
 * @description Client assets are compressed on the wire, and their caching policy
 * follows the content-hash version query: a `?v=<hash>` URL is immutable (the hash
 * is the cache key, so it never needs revalidating), while an unstamped URL — which
 * no page emits any more, but a direct hit can still ask for — must revalidate.
 * Replaces the blanket
 * `no-store` that re-sent every byte of the ~861 KB bundle on every page load.
 * See tests/asset-cache-busting.test.js for the stamping itself.
 */
import test from 'node:test';
import assert from 'node:assert';
import { spawn } from 'child_process';
import http from 'http';
import { createTestDb } from './helpers/db.js';
import { waitForServer } from './helpers/wait-for-server.js';

/**
 * GET a URL, keeping the body as raw bytes so a compressed response can be
 * measured (node's http client does not decompress on its own).
 * @returns {Promise<{statusCode: number, headers: object, bytes: number, body: Buffer}>}
 */
function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET', headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          resolve({ statusCode: res.statusCode, headers: res.headers, bytes: body.length, body });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

test('assets are gzipped, and cached by their content-hash version', async () => {
  const PORT = '31371';
  const db = await createTestDb('assetcache');
  const child = spawn('node', ['server.js'], { env: { ...process.env, PORT, NODE_ENV: 'test', DATABASE_URL: db.url } });
  child.stderr.on('data', (d) => console.error(`[srv] ${d.toString().trim()}`));
  await waitForServer(PORT);

  try {
    // --- Compression -------------------------------------------------------
    const identity = await get(`http://localhost:${PORT}/app.js`, { 'Accept-Encoding': 'identity' });
    assert.strictEqual(identity.statusCode, 200);
    assert.ok(!identity.headers['content-encoding'], 'a client that cannot decompress gets the raw asset');

    const gzipped = await get(`http://localhost:${PORT}/app.js`, { 'Accept-Encoding': 'gzip' });
    assert.strictEqual(gzipped.statusCode, 200);
    assert.strictEqual(gzipped.headers['content-encoding'], 'gzip', 'app.js is compressed for a gzip-capable client');
    // The real win is large (506 KB -> ~129 KB); assert a conservative half.
    assert.ok(
      gzipped.bytes < identity.bytes / 2,
      `gzip more than halves app.js (raw ${identity.bytes}, gzip ${gzipped.bytes})`
    );
    // Shared caches must key on the encoding, or a proxy can hand gzip to a client
    // that asked for identity.
    assert.match(String(gzipped.headers.vary || ''), /Accept-Encoding/i, 'Vary: Accept-Encoding is set');

    // --- Caching policy ----------------------------------------------------
    // A stamped URL is immutable: any change to any file in public/ mints a new
    // hash, so this exact URL can never go stale.
    const versioned = await get(`http://localhost:${PORT}/app.js?v=deadbeef01`);
    assert.strictEqual(versioned.statusCode, 200);
    assert.strictEqual(
      versioned.headers['cache-control'],
      'public, max-age=31536000, immutable',
      'a ?v= asset is cached indefinitely'
    );

    // An unstamped URL carries no freshness proof, so it must be revalidated —
    // but as a 304, not the full body the old no-store forced. No page references
    // assets this way any more (see asset-stamping.test.js), but a direct or
    // bookmarked hit must still never be pinned for a year.
    const plain = await get(`http://localhost:${PORT}/drive.js`);
    assert.strictEqual(plain.statusCode, 200);
    assert.strictEqual(plain.headers['cache-control'], 'no-cache', 'an unstamped asset revalidates');
    assert.ok(plain.headers.etag, 'an unstamped asset carries an ETag to revalidate against');

    const revalidated = await get(`http://localhost:${PORT}/drive.js`, { 'If-None-Match': plain.headers.etag });
    assert.strictEqual(revalidated.statusCode, 304, 'revalidation returns 304, not the body again');
    assert.strictEqual(revalidated.bytes, 0, 'the 304 carries no body');

    // The stale-bundle guarantee the old no-store was there for still holds from
    // the other side: the HTML naming the hashed URLs is itself always revalidated,
    // so a deploy's new hashes always reach the browser.
    const login = await get(`http://localhost:${PORT}/login`);
    assert.strictEqual(login.statusCode, 200);
    assert.strictEqual(login.headers['cache-control'], 'no-cache', 'the HTML entry point revalidates');
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 500));
    await db.cleanup();
  }
});
