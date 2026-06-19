process.env.NODE_ENV = 'test';

/**
 * @file server.test.js
 * @description Integration tests for the co-sheet Express server.
 * This test file verifies that the Express server starts up and serves the root page (index.html) correctly.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'child_process';
import http from 'http';
import { createTestDb } from './helpers/db.js';

// One throwaway database for the whole file (these tests only check page serving).
let db;
before(async () => {
  db = await createTestDb('server');
  process.env.DATABASE_URL = db.url;
});
after(async () => {
  if (db) await db.cleanup();
});

test('HTTP Server returns 200 OK for login page', async (t) => {
  // --- Arrange ---
  // Start the server process on a custom port (31234) to avoid port conflicts with running servers.
  // We pass the PORT environment variable to the child process.
  const child = spawn('node', ['server.js'], {
    env: { ...process.env, PORT: '31234' }
  });

  // Wait 1 second (1000ms) for the Express server to boot up and start listening on port 31234.
  await new Promise(resolve => setTimeout(resolve, 1000));

  try {
    // --- Act ---
    // Make an HTTP GET request to the login URL of the running server.
    const res = await new Promise((resolve, reject) => {
      http.get('http://localhost:31234/login', (response) => {
        resolve(response);
      }).on('error', reject);
    });

    // --- Assert ---
    // Verify that the HTTP status code returned by the server is 200 OK.
    assert.strictEqual(res.statusCode, 200);
  } finally {
    // Clean up the server process. We always kill the child process in the finally block
    // to prevent orphaned node processes running in the background.
    child.kill();
  }
});

test('HTTP Server serves app.js statically without authentication', async (t) => {
  // --- Arrange ---
  const PORT = '31234';
  const child = spawn('node', ['server.js'], {
    env: { ...process.env, PORT }
  });
  await new Promise(resolve => setTimeout(resolve, 1000));

  try {
    // --- Act ---
    const res = await new Promise((resolve, reject) => {
      http.get(`http://localhost:${PORT}/app.js`, (response) => {
        resolve(response);
      }).on('error', reject);
    });

    // --- Assert ---
    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.headers['content-type'].includes('application/javascript'));
  } finally {
    child.kill();
  }
});

test('HTTP Server serves the spreadsheet editor at /sheet containing grid-root and app.js link when authenticated', async (t) => {
  // --- Arrange ---
  const PORT = '31234';
  const child = spawn('node', ['server.js'], {
    env: { ...process.env, PORT, NODE_ENV: 'test' }
  });
  await new Promise(resolve => setTimeout(resolve, 1000));

  try {
    // 1. Login to get session cookie
    const loginRes = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: 'localhost',
        port: PORT,
        path: '/auth/test-login',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          data: JSON.parse(data)
        }));
      });
      req.on('error', reject);
      req.write(JSON.stringify({ username: 'Test User' }));
      req.end();
    });

    assert.strictEqual(loginRes.statusCode, 200);
    const cookie = Array.isArray(loginRes.headers['set-cookie']) ? loginRes.headers['set-cookie'][0] : loginRes.headers['set-cookie'];

    // 2. Request GET /sheet with session cookie (the editor now lives at /sheet; / serves the drive)
    const pageRes = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: 'localhost',
        port: PORT,
        path: '/sheet',
        method: 'GET',
        headers: { Cookie: cookie }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve({
          statusCode: res.statusCode,
          html: data
        }));
      });
      req.on('error', reject);
      req.end();
    });

    // --- Assert ---
    assert.strictEqual(pageRes.statusCode, 200);
    assert.ok(pageRes.html.includes('id="grid-root"'));
    assert.ok(pageRes.html.includes('src="/app.js"'));
  } finally {
    child.kill();
  }
});
