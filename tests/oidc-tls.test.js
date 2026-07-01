/**
 * @file oidc-tls.test.js
 * @description Unit tests for the Local-OIDC TLS-verification decision helpers:
 * the OIDC_TLS_VERIFY parsing and the HTTPS-endpoint gate that together decide
 * whether the server skips outbound certificate verification.
 */

import test from 'node:test';
import assert from 'node:assert';
import { isOidcTlsVerifyDisabled, oidcUsesHttps, shouldSkipOidcTls } from '../services/oidc-tls.js';

const HTTPS_ENV = { OIDC_TOKEN_URL: 'https://idp.lan/token' };
const HTTP_ENV = { OIDC_TOKEN_URL: 'http://idp.lan/token' };

test('isOidcTlsVerifyDisabled: ON by default and for truthy values', () => {
  assert.strictEqual(isOidcTlsVerifyDisabled({}), false);
  assert.strictEqual(isOidcTlsVerifyDisabled({ OIDC_TLS_VERIFY: 'true' }), false);
  assert.strictEqual(isOidcTlsVerifyDisabled({ OIDC_TLS_VERIFY: '1' }), false);
  assert.strictEqual(isOidcTlsVerifyDisabled({ OIDC_TLS_VERIFY: 'anything' }), false);
});

test('isOidcTlsVerifyDisabled: OFF for falsy values, case/space-insensitive', () => {
  for (const v of ['false', '0', 'no', 'off', 'FALSE', '  Off  ']) {
    assert.strictEqual(isOidcTlsVerifyDisabled({ OIDC_TLS_VERIFY: v }), true, `expected ${v} => disabled`);
  }
});

test('oidcUsesHttps: true only when some endpoint is https', () => {
  assert.strictEqual(oidcUsesHttps(HTTPS_ENV), true);
  assert.strictEqual(oidcUsesHttps({ OIDC_ISSUER: 'HTTPS://idp.lan' }), true);
  assert.strictEqual(oidcUsesHttps(HTTP_ENV), false);
  assert.strictEqual(oidcUsesHttps({}), false);
});

test('shouldSkipOidcTls: requires BOTH verification disabled AND an https endpoint', () => {
  // Disabled + https => skip.
  assert.strictEqual(shouldSkipOidcTls({ ...HTTPS_ENV, OIDC_TLS_VERIFY: 'false' }), true);
  // Disabled but only http => do NOT skip (no TLS; avoids https.Agent protocol mismatch).
  assert.strictEqual(shouldSkipOidcTls({ ...HTTP_ENV, OIDC_TLS_VERIFY: 'false' }), false);
  // https but verification left on => do NOT skip.
  assert.strictEqual(shouldSkipOidcTls({ ...HTTPS_ENV, OIDC_TLS_VERIFY: 'true' }), false);
  // Neither => do NOT skip.
  assert.strictEqual(shouldSkipOidcTls({}), false);
});
