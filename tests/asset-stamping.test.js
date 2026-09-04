process.env.NODE_ENV = 'test';

/**
 * @file asset-stamping.test.js
 * @description Every HTML entry point stamps its local asset URLs with the shared
 * content-hash version, which is what puts them on the `immutable` cache path (see
 * asset-compression-caching.test.js). The drive and login pages used to reference
 * their scripts and stylesheets unstamped and so missed it entirely.
 *
 * Also pins the prerequisite that makes stamping a stylesheet safe: the version
 * must be derived from the .css files too. Stamping a file type the hash ignores
 * is the one actively dangerous combination — its URL would be cached for a year
 * behind a hash that never changes when it does. Follows the AAA pattern.
 */
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import http from 'http';
import { createTestDb } from './helpers/db.js';
import { waitForServer } from './helpers/wait-for-server.js';

function request(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET', headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

function post(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

/** The `?v=` value the login page stamps onto its stylesheet. */
function versionFromLoginPage(body) {
  const m = body.match(/\/styles-login\.css\?v=([0-9a-f]{6,})"/);
  assert.ok(m, 'the login page stamps its stylesheet');
  return m[1];
}

test('every entry point stamps its assets, and the version covers stylesheets', async () => {
  // --- Arrange ---
  const PORT = '31411';
  const PORT2 = '31412';
  const db = await createTestDb('stamping');
  const probeCss = path.resolve('public', '__asset-version-probe.css');
  // Both servers run in single-instance mode: this test only renders HTML, and
  // the suite's Redis bus is shared by every server it spawns, so joining it would
  // put extra participants (and extra `default`-workbook traffic) in front of the
  // tests that do exercise cross-instance behaviour.
  const { REDIS_URL: _redis, ...envWithoutRedis } = process.env;
  const serverEnv = { ...envWithoutRedis, NODE_ENV: 'test', DATABASE_URL: db.url };

  const child = spawn('node', ['server.js'], { env: { ...serverEnv, PORT } });
  child.stderr.on('data', (d) => console.error(`[srv] ${d.toString().trim()}`));
  await waitForServer(PORT);

  let child2 = null;
  try {
    const login = await post(`http://localhost:${PORT}/auth/test-login`, { username: 'Alice' });
    const setCookie = login.headers['set-cookie'];
    const cookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;

    // --- Act ---
    const loginPage = await request(`http://localhost:${PORT}/login`);
    const drivePage = await request(`http://localhost:${PORT}/`, { Cookie: cookie });
    const editorPage = await request(`http://localhost:${PORT}/sheet`, { Cookie: cookie });

    // --- Assert: one version, stamped everywhere ---
    const version = versionFromLoginPage(loginPage.body);

    assert.strictEqual(drivePage.statusCode, 200);
    for (const asset of ['styles-drive.css', 'i18n.js', 'user-menu.js', 'sheet-utils.js', 'xlsx-export.js', 'drive.js']) {
      assert.ok(
        drivePage.body.includes(`/${asset}?v=${version}`),
        `the drive page stamps ${asset} with the shared version`
      );
    }
    // The editor's stylesheet was the one asset its own page left unstamped.
    assert.ok(editorPage.body.includes(`/styles-editor.css?v=${version}`), 'the editor stamps its stylesheet');
    assert.ok(editorPage.body.includes(`/app.js?v=${version}`), 'and shares the drive/login version');

    // No page leaks an unsubstituted placeholder.
    for (const [name, page] of [['login', loginPage], ['drive', drivePage], ['editor', editorPage]]) {
      assert.ok(!page.body.includes('{{ASSET_VERSION}}'), `${name} page substituted its version`);
      assert.ok(!page.body.includes('{{FILE_NAME}}'), `${name} page has no leftover name placeholder`);
    }

    // --- Act: a stylesheet-only change must move the version ---
    fs.writeFileSync(probeCss, '/* asset version probe */\n.probe { color: red; }\n', 'utf8');
    child2 = spawn('node', ['server.js'], { env: { ...serverEnv, PORT: PORT2 } });
    child2.stderr.on('data', (d) => console.error(`[srv2] ${d.toString().trim()}`));
    await waitForServer(PORT2);
    const afterCss = await request(`http://localhost:${PORT2}/login`);

    // --- Assert ---
    assert.notStrictEqual(
      versionFromLoginPage(afterCss.body), version,
      'adding a .css file changes the asset version — otherwise a stamped, immutable stylesheet could never be busted'
    );
  } finally {
    if (child2) child2.kill();
    child.kill();
    if (fs.existsSync(probeCss)) fs.unlinkSync(probeCss);
    await new Promise((r) => setTimeout(r, 500));
    await db.cleanup();
  }
});
