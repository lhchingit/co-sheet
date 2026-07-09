process.env.NODE_ENV = 'test';

/**
 * @file asset-cache-busting.test.js
 * @description The editor page (/sheet) stamps a content-hash version onto every
 * client <script> URL (?v=<hash>) so a deploy always changes those URLs, defeating
 * any browser/CDN/proxy cache that would otherwise serve a stale bundle. Verifies
 * the placeholder is substituted, the hash is stable across requests, and the
 * versioned asset URL still resolves.
 */
import test from 'node:test';
import assert from 'node:assert';
import { spawn } from 'child_process';
import http from 'http';
import { createTestDb } from './helpers/db.js';

function request(url, method, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

test('editor page stamps a stable cache-busting version on its scripts', async () => {
  const PORT = '31361';
  const db = await createTestDb('cachebust');
  const child = spawn('node', ['server.js'], { env: { ...process.env, PORT, NODE_ENV: 'test', DATABASE_URL: db.url } });
  child.stderr.on('data', (d) => console.error(`[srv] ${d.toString().trim()}`));
  await new Promise((r) => setTimeout(r, 1500));

  try {
    // Authenticate (the /sheet route requires it).
    const login = await request(`http://localhost:${PORT}/auth/test-login`, 'POST', { username: 'Alice' });
    const setCookie = login.headers['set-cookie'];
    const cookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;

    const page = await request(`http://localhost:${PORT}/sheet`, 'GET', null, { Cookie: cookie });
    assert.strictEqual(page.statusCode, 200);

    // Placeholder must be fully substituted — no literal tokens leak to the client.
    assert.ok(!page.body.includes('{{ASSET_VERSION}}'), 'ASSET_VERSION placeholder was substituted');

    // app.js (and its siblings) carry ?v=<hex hash>.
    const m = page.body.match(/\/app\.js\?v=([0-9a-f]{6,})"/);
    assert.ok(m, 'app.js script carries a hex version query');
    const version = m[1];

    // Every local module shares the same version (one deploy → one bundle version).
    const siblings = ['sheet-utils', 'formula-engine', 'i18n', 'fn-autocomplete'];
    for (const s of siblings) {
      assert.ok(page.body.includes(`/${s}.js?v=${version}`), `${s}.js carries the same version`);
    }

    // Stable across requests within the same server process.
    const page2 = await request(`http://localhost:${PORT}/sheet`, 'GET', null, { Cookie: cookie });
    assert.ok(page2.body.includes(`/app.js?v=${version}"`), 'version is stable across requests');

    // The versioned URL still resolves to the real asset (static middleware ignores the query).
    const asset = await request(`http://localhost:${PORT}/app.js?v=${version}`, 'GET');
    assert.strictEqual(asset.statusCode, 200, 'versioned app.js resolves');
    assert.ok(asset.body.includes('saveCellUpdate'), 'served the real app.js');
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 500));
    await db.cleanup();
  }
});
