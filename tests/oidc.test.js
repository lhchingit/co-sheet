process.env.NODE_ENV = 'test';

/**
 * @file oidc.test.js
 * @description Integration tests for the co-sheet mock OIDC provider endpoints.
 * This test file verifies that the OIDC configuration, JWKS, redirect validation,
 * token exchange, signed JWT validation, and user info endpoints work correctly.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'child_process';
import http from 'http';
import { createTestDb } from './helpers/db.js';

// One throwaway database for the whole file; spawned servers inherit it via
// DATABASE_URL (including the production-mode login-page tests, which previously
// needed a file-store shim to boot without a real database).
let db;
before(async () => {
  db = await createTestDb('oidc');
  process.env.DATABASE_URL = db.url;
});
after(async () => {
  if (db) await db.cleanup();
});

test('OIDC metadata endpoint serves openid-configuration JSON', async () => {
  // --- Arrange ---
  // Start the server process on a custom port (31235) to avoid port conflicts.
  // We pass the PORT environment variable to the child process.
  const child = spawn('node', ['server.js'], {
    env: { ...process.env, PORT: '31235' }
  });

  // Wait 1 second (1000ms) for the Express server to boot up and start listening on port 31235.
  // Poll until the server is listening instead of a fixed sleep that races CI.
  await fetchWithRetry('http://localhost:31235/login');

  try {
    // --- Act ---
    // Make an HTTP GET request to the openid-configuration discovery endpoint.
    const body = await new Promise((resolve, reject) => {
      http.get('http://localhost:31235/oidc/.well-known/openid-configuration', (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`Failed to parse response JSON: ${data}`));
          }
        });
      }).on('error', reject);
    });

    // --- Assert ---
    // Verify that the issuer and authorization endpoint in the returned configuration are as expected.
    assert.strictEqual(body.issuer, 'http://localhost:31235/oidc');
    assert.strictEqual(body.authorization_endpoint, 'http://localhost:31235/oidc/authorize');
    assert.strictEqual(body.token_endpoint, 'http://localhost:31235/oidc/token');
    assert.strictEqual(body.userinfo_endpoint, 'http://localhost:31235/oidc/userinfo');
    assert.strictEqual(body.jwks_uri, 'http://localhost:31235/oidc/jwks');
  } finally {
    // Clean up the server process. We always kill the child process in the finally block.
    child.kill();
  }
});

test('OIDC JWKS endpoint returns the mock public key', async () => {
  // --- Arrange ---
  // Start the server process on a custom port (31235) to avoid port conflicts.
  const child = spawn('node', ['server.js'], {
    env: { ...process.env, PORT: '31235' }
  });

  // Wait 1 second (1000ms) for the Express server to boot.
  // Poll until the server is listening instead of a fixed sleep that races CI.
  await fetchWithRetry('http://localhost:31235/login');

  try {
    // --- Act ---
    // Make an HTTP request to the JWKS endpoint.
    const res = await fetch('http://localhost:31235/oidc/jwks');
    const body = await res.json();

    // --- Assert ---
    // Verify the JWKS structure and public key configuration.
    assert.strictEqual(res.status, 200);
    assert.ok(body.keys);
    assert.strictEqual(body.keys.length, 1);
    assert.strictEqual(body.keys[0].kid, 'mock-key-id');
    assert.strictEqual(body.keys[0].alg, 'RS256');
    assert.strictEqual(body.keys[0].use, 'sig');
  } finally {
    // Clean up the server process. We always kill the child process in the finally block.
    child.kill();
  }
});

test('OIDC authorization endpoint rejects non-local redirect_uri', async () => {
  // --- Arrange ---
  // Start the server process on a custom port (31235) to avoid port conflicts.
  const child = spawn('node', ['server.js'], {
    env: { ...process.env, PORT: '31235' }
  });

  // Wait 1 second (1000ms) for the Express server to boot.
  // Poll until the server is listening instead of a fixed sleep that races CI.
  await fetchWithRetry('http://localhost:31235/login');

  try {
    // --- Act & Assert ---
    // 1. Test basic malicious external host
    const res1 = await fetch('http://localhost:31235/oidc/authorize?redirect_uri=http://malicious.com&state=xyz&client_id=123');
    assert.strictEqual(res1.status, 400);
    const text1 = await res1.text();
    assert.ok(text1.includes('Invalid redirect_uri'));

    // 2. Test bypass attempt using subdomain/suffix: http://localhost.attacker.com
    const res2 = await fetch('http://localhost:31235/oidc/authorize?redirect_uri=http://localhost.attacker.com&state=xyz&client_id=123');
    assert.strictEqual(res2.status, 400);
    const text2 = await res2.text();
    assert.ok(text2.includes('Invalid redirect_uri'));

    // 3. Test bypass attempt using authority credentials: http://localhost@attacker.com
    const res3 = await fetch('http://localhost:31235/oidc/authorize?redirect_uri=http://localhost@attacker.com&state=xyz&client_id=123');
    assert.strictEqual(res3.status, 400);
    const text3 = await res3.text();
    assert.ok(text3.includes('Invalid redirect_uri'));
  } finally {
    // Clean up the server process. We always kill the child process in the finally block.
    child.kill();
  }
});

test('OIDC full authentication flow works successfully', async () => {
  // --- Arrange ---
  // Start the server process on a custom port (31235) to avoid port conflicts.
  const child = spawn('node', ['server.js'], {
    env: { ...process.env, PORT: '31235' }
  });

  // Wait 1 second (1000ms) for the Express server to boot.
  // Poll until the server is listening instead of a fixed sleep that races CI.
  await fetchWithRetry('http://localhost:31235/login');

  try {
    // Generate a mock code matching the server's expected format (base64 of JSON { username })
    const mockCode = Buffer.from(JSON.stringify({ username: 'john_doe' })).toString('base64');

    // --- Act & Assert: Part 1 - Token Exchange ---
    // Make a POST request to exchange the authorization code for tokens
    const tokenRes = await fetch('http://localhost:31235/oidc/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        code: mockCode,
        client_id: 'co-sheet-client-id'
      })
    });

    assert.strictEqual(tokenRes.status, 200);
    const tokenBody = await tokenRes.json();

    assert.ok(tokenBody.access_token);
    assert.strictEqual(tokenBody.token_type, 'Bearer');
    assert.ok(tokenBody.id_token);

    // Verify the id_token is a valid signed JWT with 3 parts: header, payload, and signature
    const jwtParts = tokenBody.id_token.split('.');
    assert.strictEqual(jwtParts.length, 3);

    // Decode the payload from base64url and parse it
    const idTokenPayload = JSON.parse(Buffer.from(jwtParts[1], 'base64url').toString('utf8'));
    assert.strictEqual(idTokenPayload.iss, 'http://localhost:31235/oidc');
    assert.strictEqual(idTokenPayload.sub, 'mock-sub-john_doe');
    assert.strictEqual(idTokenPayload.name, 'john_doe');
    assert.strictEqual(idTokenPayload.email, 'john_doe@localhost');

    // --- Act & Assert: Part 2 - User Info Retrieval ---
    // Query the userinfo endpoint using the received access token
    const userInfoRes = await fetch('http://localhost:31235/oidc/userinfo', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${tokenBody.access_token}`
      }
    });

    assert.strictEqual(userInfoRes.status, 200);
    const userInfoBody = await userInfoRes.json();

    assert.strictEqual(userInfoBody.sub, 'mock-sub-john_doe');
    assert.strictEqual(userInfoBody.name, 'john_doe');
    assert.strictEqual(userInfoBody.email, 'john_doe@localhost');
  } finally {
    // Clean up the server process. We always kill the child process in the finally block.
    child.kill();
  }
});

test('OIDC edge cases: protocol restriction, invalid token, and invalid code validation', async () => {
  // --- Arrange ---
  // Start the server process on a custom port (31235) to avoid port conflicts.
  const child = spawn('node', ['server.js'], {
    env: { ...process.env, PORT: '31235' }
  });

  // Wait 1 second (1000ms) for the Express server to boot.
  // Poll until the server is listening instead of a fixed sleep that races CI.
  await fetchWithRetry('http://localhost:31235/login');

  try {
    // --- Act & Assert: Part 1 - Protocol restriction validation ---
    // Make request to authorize with non-http/https protocol (e.g. javascript: scheme)
    const resProto = await fetch('http://localhost:31235/oidc/authorize?redirect_uri=javascript:alert(1)&state=xyz&client_id=123');
    assert.strictEqual(resProto.status, 400);

    // --- Act & Assert: Part 2 - Invalid / missing code validation ---
    // POST request without code
    const resTokenMissingCode = await fetch('http://localhost:31235/oidc/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: 'co-sheet-client-id' })
    });
    assert.strictEqual(resTokenMissingCode.status, 400);

    // POST request with invalid code format
    const resTokenInvalidCode = await fetch('http://localhost:31235/oidc/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code: 'not-base-64', client_id: 'co-sheet-client-id' })
    });
    assert.strictEqual(resTokenInvalidCode.status, 400);

    // POST request with base64 encoded but invalid JSON payload (missing username)
    const invalidPayloadCode = Buffer.from(JSON.stringify({ not_username: 'test' })).toString('base64');
    const resTokenMissingUsername = await fetch('http://localhost:31235/oidc/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code: invalidPayloadCode, client_id: 'co-sheet-client-id' })
    });
    assert.strictEqual(resTokenMissingUsername.status, 400);

    // --- Act & Assert: Part 3 - Invalid userinfo token validation ---
    // GET request without authorization header
    const resUserinfoNoAuth = await fetch('http://localhost:31235/oidc/userinfo');
    assert.strictEqual(resUserinfoNoAuth.status, 401);
    const bodyNoAuth = await resUserinfoNoAuth.json();
    assert.strictEqual(bodyNoAuth.error, 'invalid_token');

    // GET request with invalid token prefix
    const resUserinfoBadPrefix = await fetch('http://localhost:31235/oidc/userinfo', {
      headers: { 'Authorization': 'Bearer bad-token-prefix' }
    });
    assert.strictEqual(resUserinfoBadPrefix.status, 401);
  } finally {
    // Clean up the server process. We always kill the child process in the finally block.
    child.kill();
  }
});

/**
 * Fetch a URL, retrying on connection errors until it responds or the timeout
 * elapses. A freshly spawned server may not be listening yet (a fixed sleep
 * races against a loaded CI runner's startup), so poll instead of guessing.
 */
async function fetchWithRetry(url, options, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      return await fetch(url, options);
    } catch (err) {
      lastErr = err; // connection refused while the server boots; retry
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
  throw lastErr;
}

/**
 * Boots the server with the given extra env vars, fetches /login, and returns the
 * page HTML. Always kills the child process afterwards.
 */
async function fetchLoginPage(extraEnv) {
  const child = spawn('node', ['server.js'], {
    // Supply a SESSION_SECRET: some of these cases boot with NODE_ENV=production,
    // where the server (correctly) refuses to start without one. extraEnv can
    // still override it.
    env: { ...process.env, PORT: '31236', SESSION_SECRET: 'test-session-secret', ...extraEnv }
  });
  try {
    const res = await fetchWithRetry('http://localhost:31236/login');
    return await res.text();
  } finally {
    child.kill();
  }
}

test('Login page shows the Mock OIDC button by default (non-production)', async () => {
  // NODE_ENV=test (set at the top of this file) is not production, so the mock
  // button should be present without any explicit flag.
  const html = await fetchLoginPage({ MOCK_OIDC_ENABLED: '' });
  assert.ok(html.includes('Sign in with Mock OIDC'));
  // Other providers are unaffected by the flag.
  assert.ok(html.includes('Sign in with Local OIDC'));
  assert.ok(html.includes('Sign in with Google'));
});

test('Login page hides the Mock OIDC button when MOCK_OIDC_ENABLED=false', async () => {
  const html = await fetchLoginPage({ MOCK_OIDC_ENABLED: 'false' });
  assert.ok(!html.includes('Sign in with Mock OIDC'));
  // The other login options remain intact.
  assert.ok(html.includes('Sign in with Local OIDC'));
  assert.ok(html.includes('Sign in with Google'));
});

test('Login page hides the Mock OIDC button in production by default', async () => {
  const html = await fetchLoginPage({ NODE_ENV: 'production', MOCK_OIDC_ENABLED: '' });
  assert.ok(!html.includes('Sign in with Mock OIDC'));
});

test('Login page shows the Mock OIDC button in production when explicitly enabled', async () => {
  const html = await fetchLoginPage({ NODE_ENV: 'production', MOCK_OIDC_ENABLED: 'true' });
  assert.ok(html.includes('Sign in with Mock OIDC'));
});

test('Mock OIDC endpoints return 404 when disabled', async () => {
  // Boot with the mock provider disabled and confirm the provider/login routes are
  // unreachable, not merely hidden on the login page.
  const child = spawn('node', ['server.js'], {
    env: { ...process.env, PORT: '31237', MOCK_OIDC_ENABLED: 'false' }
  });
  // Poll until the server is listening instead of a fixed sleep that races CI.
  await fetchWithRetry('http://localhost:31237/login');

  try {
    const discovery = await fetch('http://localhost:31237/oidc/.well-known/openid-configuration');
    assert.strictEqual(discovery.status, 404);

    const jwks = await fetch('http://localhost:31237/oidc/jwks');
    assert.strictEqual(jwks.status, 404);

    // /auth/oidc must not start the passport flow (which would redirect); it 404s.
    const authStart = await fetch('http://localhost:31237/auth/oidc', { redirect: 'manual' });
    assert.strictEqual(authStart.status, 404);

    const token = await fetch('http://localhost:31237/oidc/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code: 'x', client_id: 'co-sheet-client-id' })
    });
    assert.strictEqual(token.status, 404);
  } finally {
    child.kill();
  }
});

test('Login page shows the Google button by default', async () => {
  // Google is the primary production sign-in, so it is enabled without any flag.
  const html = await fetchLoginPage({ GOOGLE_LOGIN_ENABLED: '' });
  assert.ok(html.includes('Sign in with Google'));
  // Other providers are unaffected by the flag.
  assert.ok(html.includes('Sign in with Local OIDC'));
  assert.ok(html.includes('Sign in with Mock OIDC'));
});

test('Login page still shows the Google button in production by default', async () => {
  // Unlike the mock provider, Google stays enabled in production unless turned off.
  const html = await fetchLoginPage({ NODE_ENV: 'production', GOOGLE_LOGIN_ENABLED: '' });
  assert.ok(html.includes('Sign in with Google'));
});

test('Login page hides the Google button when GOOGLE_LOGIN_ENABLED=false', async () => {
  const html = await fetchLoginPage({ GOOGLE_LOGIN_ENABLED: 'false' });
  assert.ok(!html.includes('Sign in with Google'));
  // The other login options remain intact.
  assert.ok(html.includes('Sign in with Local OIDC'));
  assert.ok(html.includes('Sign in with Mock OIDC'));
});

test('Google endpoints return 404 when disabled', async () => {
  // Boot with Google login disabled and confirm the sign-in routes are unreachable,
  // not merely hidden on the login page.
  const child = spawn('node', ['server.js'], {
    env: { ...process.env, PORT: '31238', GOOGLE_LOGIN_ENABLED: 'off' }
  });
  // Poll until the server is listening instead of a fixed sleep that races CI.
  await fetchWithRetry('http://localhost:31238/login');

  try {
    // /auth/google must not start the flow or serve the mock page; it 404s.
    const authStart = await fetch('http://localhost:31238/auth/google', { redirect: 'manual' });
    assert.strictEqual(authStart.status, 404);

    const callback = await fetch('http://localhost:31238/auth/google/callback', { redirect: 'manual' });
    assert.strictEqual(callback.status, 404);

    const mockLogin = await fetch('http://localhost:31238/auth/google/mock-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: 'a@b.c' })
    });
    assert.strictEqual(mockLogin.status, 404);
  } finally {
    child.kill();
  }
});

