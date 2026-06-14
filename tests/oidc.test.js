process.env.NODE_ENV = 'test';

/**
 * @file oidc.test.js
 * @description Integration tests for the co-sheet mock OIDC provider endpoints.
 * This test file verifies that the OIDC configuration, JWKS, redirect validation,
 * token exchange, signed JWT validation, and user info endpoints work correctly.
 */

import test from 'node:test';
import assert from 'node:assert';
import { spawn } from 'child_process';
import http from 'http';

test('OIDC metadata endpoint serves openid-configuration JSON', async (t) => {
  // --- Arrange ---
  // Start the server process on a custom port (31235) to avoid port conflicts.
  // We pass the PORT environment variable to the child process.
  const child = spawn('node', ['server.js'], {
    env: { ...process.env, PORT: '31235' }
  });

  // Wait 1 second (1000ms) for the Express server to boot up and start listening on port 31235.
  await new Promise(resolve => setTimeout(resolve, 1000));

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

test('OIDC JWKS endpoint returns the mock public key', async (t) => {
  // --- Arrange ---
  // Start the server process on a custom port (31235) to avoid port conflicts.
  const child = spawn('node', ['server.js'], {
    env: { ...process.env, PORT: '31235' }
  });

  // Wait 1 second (1000ms) for the Express server to boot.
  await new Promise(resolve => setTimeout(resolve, 1000));

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

test('OIDC authorization endpoint rejects non-local redirect_uri', async (t) => {
  // --- Arrange ---
  // Start the server process on a custom port (31235) to avoid port conflicts.
  const child = spawn('node', ['server.js'], {
    env: { ...process.env, PORT: '31235' }
  });

  // Wait 1 second (1000ms) for the Express server to boot.
  await new Promise(resolve => setTimeout(resolve, 1000));

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

test('OIDC full authentication flow works successfully', async (t) => {
  // --- Arrange ---
  // Start the server process on a custom port (31235) to avoid port conflicts.
  const child = spawn('node', ['server.js'], {
    env: { ...process.env, PORT: '31235' }
  });

  // Wait 1 second (1000ms) for the Express server to boot.
  await new Promise(resolve => setTimeout(resolve, 1000));

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

test('OIDC edge cases: protocol restriction, invalid token, and invalid code validation', async (t) => {
  // --- Arrange ---
  // Start the server process on a custom port (31235) to avoid port conflicts.
  const child = spawn('node', ['server.js'], {
    env: { ...process.env, PORT: '31235' }
  });

  // Wait 1 second (1000ms) for the Express server to boot.
  await new Promise(resolve => setTimeout(resolve, 1000));

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

