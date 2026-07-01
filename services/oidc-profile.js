// @ts-check

/**
 * @file services/oidc-profile.js
 * @description Pure decision helper for whether the external ("Local OIDC")
 * provider's userinfo endpoint should be skipped. Kept side-effect free so it can
 * be unit-tested; server.js turns a positive decision into `skipUserProfile: true`
 * on the 'oidc-sso' strategy.
 *
 * Some self-hosted providers do not expose a userinfo endpoint (or do not support
 * the `profile` scope). Because our verify callback uses the 9-argument signature,
 * passport-openidconnect otherwise defaults to *always* fetching userinfo, so such
 * a provider makes every login fail with "Failed to fetch user profile". Setting
 * OIDC_SKIP_USERINFO derives identity from the ID-token claims instead.
 */

// Values of OIDC_SKIP_USERINFO that mean "skip the userinfo call". Anything else
// (including unset) keeps fetching userinfo — the standard OIDC behavior.
const TRUTHY = /^(1|true|yes|on)$/i;

/**
 * Whether OIDC_SKIP_USERINFO opts out of the external provider's userinfo call.
 * @param {Record<string, string|undefined>} [env]
 * @returns {boolean}
 */
export const isExternalOidcUserinfoSkipped = (env = process.env) =>
  TRUTHY.test(String(env.OIDC_SKIP_USERINFO || '').trim());
