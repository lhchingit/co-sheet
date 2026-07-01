/**
 * @file oidc-userinfo.test.js
 * @description Unit tests for the OIDC_SKIP_USERINFO decision helper that controls
 * whether the external ("Local OIDC") provider's userinfo endpoint is skipped (for
 * providers that don't expose one).
 */

import test from 'node:test';
import assert from 'node:assert';
import { isExternalOidcUserinfoSkipped } from '../services/oidcProfile.js';

test('isExternalOidcUserinfoSkipped: OFF by default (fetch userinfo)', () => {
  assert.strictEqual(isExternalOidcUserinfoSkipped({}), false);
  assert.strictEqual(isExternalOidcUserinfoSkipped({ OIDC_SKIP_USERINFO: '' }), false);
  assert.strictEqual(isExternalOidcUserinfoSkipped({ OIDC_SKIP_USERINFO: 'false' }), false);
  assert.strictEqual(isExternalOidcUserinfoSkipped({ OIDC_SKIP_USERINFO: '0' }), false);
  assert.strictEqual(isExternalOidcUserinfoSkipped({ OIDC_SKIP_USERINFO: 'anything' }), false);
});

test('isExternalOidcUserinfoSkipped: ON for truthy values, case/space-insensitive', () => {
  for (const v of ['1', 'true', 'yes', 'on', 'TRUE', '  On  ']) {
    assert.strictEqual(isExternalOidcUserinfoSkipped({ OIDC_SKIP_USERINFO: v }), true, `expected ${v} => skip`);
  }
});
