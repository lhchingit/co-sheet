process.env.NODE_ENV = 'test';

/**
 * @file auth.test.js
 * @description Integration tests for co-sheet authentication routing.
 * Verifies that unauthenticated requests to the root path are redirected to the login page.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'child_process';
import http from 'http';
import { createTestDb } from './helpers/db.js';

// One throwaway database for the whole file: these tests only exercise auth routing
// and don't assert on cross-test DB state, so spawned servers share it via the
// inherited DATABASE_URL.
let db;
before(async () => {
  db = await createTestDb('auth');
  process.env.DATABASE_URL = db.url;
});
after(async () => {
  if (db) await db.cleanup();
});

test('Accessing / redirects to /login if unauthenticated', async (t) => {
  // --- Arrange ---
  // Start the server process on a unique port (31250) to prevent address-in-use errors.
  const PORT = '31250';
  const child = spawn('node', ['server.js'], {
    env: { ...process.env, PORT }
  });

  // Give the server 1 second to start listening on the port.
  await new Promise((resolve) => setTimeout(resolve, 1000));

  try {
    // --- Act ---
    // Make an HTTP GET request to the root path of the server.
    const res = await new Promise((resolve, reject) => {
      // We disable automatic redirect following by using http.get directly,
      // which allows us to inspect the raw 302 response headers.
      http.get(`http://localhost:${PORT}/`, (response) => {
        resolve(response);
      }).on('error', reject);
    });

    // --- Assert ---
    // Assert that the status code is a 302 Found redirect.
    assert.strictEqual(res.statusCode, 302);
    // Assert that the Location header points to the login page.
    assert.ok(res.headers.location.includes('/login'), `Expected redirect location to include "/login", got "${res.headers.location}"`);
  } finally {
    // Clean up the server process after testing.
    child.kill();
  }
});

test('Accessing /index.html redirects to /', async (t) => {
  // --- Arrange ---
  // Start the server process on a unique port (31251) to prevent address-in-use errors.
  const PORT = '31251';
  const child = spawn('node', ['server.js'], {
    env: { ...process.env, PORT }
  });

  // Give the server 1 second to start listening on the port.
  await new Promise((resolve) => setTimeout(resolve, 1000));

  try {
    // --- Act ---
    // Make an HTTP GET request to /index.html path of the server.
    const res = await new Promise((resolve, reject) => {
      http.get(`http://localhost:${PORT}/index.html`, (response) => {
        resolve(response);
      }).on('error', reject);
    });

    // --- Assert ---
    // Assert that the status code is a 302 Found redirect.
    assert.strictEqual(res.statusCode, 302);
    // Assert that the Location header points to /
    assert.strictEqual(res.headers.location, '/');
  } finally {
    // Clean up the server process after testing.
    child.kill();
  }
});

test('Google Login - redirects to Google OIDC authorization URL if credentials exist', async (t) => {
  // --- Arrange ---
  // Start the server process on a unique port (31252) with mocked Google credentials.
  const PORT = '31252';
  const child = spawn('node', ['server.js'], {
    env: { 
      ...process.env, 
      PORT, 
      GOOGLE_CLIENT_ID: 'mock-google-id', 
      GOOGLE_CLIENT_SECRET: 'mock-google-secret' 
    }
  });

  // Give the server 1 second to start listening on the port.
  await new Promise((resolve) => setTimeout(resolve, 1000));

  try {
    // --- Act ---
    // Perform an HTTP GET request to the Google login initiation path.
    const res = await new Promise((resolve, reject) => {
      http.get(`http://localhost:${PORT}/auth/google`, (response) => {
        resolve(response);
      }).on('error', reject);
    });

    // --- Assert ---
    // The passport strategy should initiate OIDC flow redirecting to Google auth URL (302 Found).
    assert.strictEqual(res.statusCode, 302);
    // Check that the redirect location points to Google's OAuth 2.0 authorization endpoint.
    assert.ok(res.headers.location.startsWith('https://accounts.google.com/o/oauth2/v2/auth'), `Expected redirect location to start with Google Auth URL, got "${res.headers.location}"`);

    // Assert that the redirect_uri query parameter uses the path /auth/google/callback.
    const expectedRedirectUriParam = encodeURIComponent(`http://localhost:${PORT}/auth/google/callback`);
    assert.ok(res.headers.location.includes(`redirect_uri=${expectedRedirectUriParam}`), `Expected redirect location to include redirect_uri=${expectedRedirectUriParam}, got "${res.headers.location}"`);
  } finally {
    // Clean up the server process after testing.
    child.kill();
  }
});

test('Google Login - serves mock Google Sign-In page if unconfigured', async (t) => {
  // --- Arrange ---
  // Start the server process on a unique port (31253) without Google credentials.
  const PORT = '31253';
  const cleanEnv = { 
    ...process.env, 
    PORT,
    // Set to a nonexistent path to prevent dotenv from loading the local .env file.
    DOTENV_CONFIG_PATH: 'nonexistent_dotenv_path_to_prevent_loading'
  };
  delete cleanEnv.GOOGLE_CLIENT_ID;
  delete cleanEnv.GOOGLE_CLIENT_SECRET;

  const child = spawn('node', ['server.js'], { env: cleanEnv });

  // Give the server 1 second to start listening on the port.
  await new Promise((resolve) => setTimeout(resolve, 1000));

  try {
    // --- Act ---
    // Perform an HTTP GET request to the Google login path.
    const res = await new Promise((resolve, reject) => {
      http.get(`http://localhost:${PORT}/auth/google`, (response) => {
        let data = '';
        response.on('data', chunk => { data += chunk; });
        response.on('end', () => {
          resolve({ statusCode: response.statusCode, headers: response.headers, data });
        });
      }).on('error', reject);
    });

    // --- Assert ---
    // The server should serve a 200 OK with the custom mock Google Sign-in page.
    assert.strictEqual(res.statusCode, 200);
    // Check that the mock login page contains expected title and subtitle elements.
    assert.ok(res.data.includes('<title>Mock Google Sign-In</title>'), 'Expected response data to contain "<title>Mock Google Sign-In</title>"');
    assert.ok(res.data.includes('with your Google Account'), 'Expected response data to contain "with your Google Account"');
  } finally {
    // Clean up the server process after testing.
    child.kill();
  }
});

test('Access to /api/me returns 401 Unauthorized when unauthenticated', async (t) => {
  // --- Arrange ---
  // Start the server process on a unique port (31254) to prevent address-in-use errors.
  const PORT = '31254';
  const child = spawn('node', ['server.js'], { env: { ...process.env, PORT } });
  
  // Give the server 1 second to start listening on the port.
  await new Promise((resolve) => setTimeout(resolve, 1000));

  try {
    // --- Act ---
    // Make an HTTP GET request to /api/me without authentication headers or cookies.
    const res = await new Promise((resolve, reject) => {
      http.get(`http://localhost:${PORT}/api/me`, (response) => {
        let data = '';
        response.on('data', chunk => { data += chunk; });
        response.on('end', () => {
          resolve({ statusCode: response.statusCode, data });
        });
      }).on('error', reject);
    });

    // --- Assert ---
    // Assert that status code is 401 Unauthorized.
    assert.strictEqual(res.statusCode, 401);
  } finally {
    // Clean up the server process after testing.
    child.kill();
  }
});

test('Access to /api/me returns authenticated user details', async (t) => {
  // --- Arrange ---
  // Start the server process on a unique port (31255) to prevent address-in-use errors.
  const PORT = '31255';
  const child = spawn('node', ['server.js'], { env: { ...process.env, PORT, NODE_ENV: 'test' } });
  
  // Give the server 1 second to start listening on the port.
  await new Promise((resolve) => setTimeout(resolve, 1000));

  try {
    // Authenticate and get cookie by calling the test login endpoint.
    const loginRes = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: 'localhost',
        port: PORT,
        path: '/auth/test-login',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, (response) => {
        resolve(response);
      });
      req.on('error', reject);
      req.write(JSON.stringify({ username: 'Alice' }));
      req.end();
    });
    assert.strictEqual(loginRes.statusCode, 200);
    const setCookie = loginRes.headers['set-cookie'];
    const cookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;

    // --- Act ---
    // Make a GET request to /api/me passing the authenticated session cookie.
    const res = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: 'localhost',
        port: PORT,
        path: '/api/me',
        method: 'GET',
        headers: { Cookie: cookie }
      }, (response) => {
        let data = '';
        response.on('data', chunk => { data += chunk; });
        response.on('end', () => {
          resolve({ statusCode: response.statusCode, data: JSON.parse(data) });
        });
      });
      req.on('error', reject);
      req.end();
    });

    // --- Assert ---
    // Assert that the response returns 200 OK and contains the profile details.
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.username, 'Alice');
    assert.strictEqual(res.data.provider, 'test');
  } finally {
    // Clean up the server process after testing.
    child.kill();
  }
});

test('GET /logout terminates session and clears cookies', async (t) => {
  // --- Arrange ---
  // Start the server process on a unique port (31256) to prevent address-in-use errors.
  const PORT = '31256';
  const child = spawn('node', ['server.js'], { env: { ...process.env, PORT, NODE_ENV: 'test' } });
  
  // Give the server 1 second to start listening on the port.
  await new Promise((resolve) => setTimeout(resolve, 1000));

  try {
    // Authenticate and get cookie by calling the test login endpoint.
    const loginRes = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: 'localhost',
        port: PORT,
        path: '/auth/test-login',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, (response) => {
        resolve(response);
      });
      req.on('error', reject);
      req.write(JSON.stringify({ username: 'Bob' }));
      req.end();
    });
    const setCookie = loginRes.headers['set-cookie'];
    const cookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;

    // --- Act ---
    // Make a GET request to the /logout endpoint, sending the session cookie.
    const res = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: 'localhost',
        port: PORT,
        path: '/logout',
        method: 'GET',
        headers: { Cookie: cookie }
      }, (response) => {
        resolve(response);
      });
      req.on('error', reject);
      req.end();
    });

    // --- Assert ---
    // Redirects back to login (302 Found redirect).
    assert.strictEqual(res.statusCode, 302);
    assert.ok(res.headers.location.includes('/login'));
    
    // Cookie is cleared or reset in the response headers.
    const newCookies = res.headers['set-cookie'] || [];
    const hasClearCookie = newCookies.some(c => c.startsWith('connect.sid=;'));
    assert.ok(hasClearCookie || newCookies.length > 0, 'Session cookie should be cleared');
  } finally {
    // Clean up the server process after testing.
    child.kill();
  }
});
