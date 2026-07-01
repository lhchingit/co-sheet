// @ts-check

/**
 * @file services/oidc-tls.js
 * @description Pure decision helpers for outbound TLS certificate verification of
 * the external ("Local OIDC") provider. Kept transport-agnostic and side-effect
 * free so it can be unit-tested; server.js turns a positive decision into an
 * insecure https.Agent for the 'oidc-sso' strategy.
 */

// Values of OIDC_TLS_VERIFY that mean "verification OFF". Anything else (including
// unset, "true", "1") keeps verification ON — secure by default.
const FALSY = /^(false|0|no|off)$/i;

/**
 * Whether OIDC_TLS_VERIFY explicitly disables certificate verification.
 * @param {Record<string, string|undefined>} [env]
 * @returns {boolean}
 */
export const isOidcTlsVerifyDisabled = (env = process.env) =>
  FALSY.test(String(env.OIDC_TLS_VERIFY || '').trim());

/**
 * Whether any configured external-OIDC endpoint is reached over HTTPS. Skipping
 * verification only makes sense (and is only safe to wire up) for HTTPS — an
 * https.Agent attached to a plain-http endpoint throws a protocol mismatch.
 * @param {Record<string, string|undefined>} [env]
 * @returns {boolean}
 */
export const oidcUsesHttps = (env = process.env) =>
  [env.OIDC_ISSUER, env.OIDC_AUTHORIZATION_URL, env.OIDC_TOKEN_URL, env.OIDC_USERINFO_URL]
    .some((u) => typeof u === 'string' && /^https:/i.test(u.trim()));

/**
 * Whether the server should skip TLS cert verification for the Local OIDC
 * provider: verification disabled AND at least one HTTPS endpoint configured.
 * @param {Record<string, string|undefined>} [env]
 * @returns {boolean}
 */
export const shouldSkipOidcTls = (env = process.env) =>
  isOidcTlsVerifyDisabled(env) && oidcUsesHttps(env);
