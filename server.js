// @ts-check
import 'dotenv/config';

/**
 * @file server.js
 * @description Main entry point for the co-sheet collaborative spreadsheet application.
 * Configures the Express server to serve static assets and handles routing.
 */

import express from 'express';
import compression from 'compression';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import https from 'https';
import session from 'express-session';
import passport from 'passport';
import { Strategy as OIDCStrategy } from 'passport-openidconnect';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';

// Database layer: the connection pool (real pg or test mock) and per-table
// repository modules. All SQL lives behind these modules; server.js composes them.
import { pool } from './db/pool.js';
import { initDatabase } from './db/schema.js';
import * as usersRepo from './db/users.js';
import * as filesRepo from './db/files.js';
import * as sharesRepo from './db/shares.js';
import * as starsRepo from './db/stars.js';
import * as versionsRepo from './db/versions.js';
import * as workbookRepo from './db/workbook.js';

// Service layer: transport-agnostic business logic shared by the REST routes and
// the WebSocket handler.
import * as cellService from './services/cell-service.js';
import * as sheetService from './services/sheet-service.js';
import * as dimensionService from './services/dimension-service.js';
import { shouldSkipOidcTls } from './services/oidc-tls.js';
import { isExternalOidcUserinfoSkipped } from './services/oidc-profile.js';
import { createRealtimeBus, resolveRedisOptions, createRedisClient } from './services/realtime-bus.js';
import { parseXlsx } from './services/xlsx-import.js';
import { createRateLimiters } from './services/rate-limit.js';
import { createWriteCoalescer } from './services/workbook-writer.js';
import { logger, component } from './services/logger.js';
import { isMetricsEnabled, startMetricsServer, httpMetricsMiddleware } from './services/metrics.js';

// Per-subsystem child loggers. Each tags its lines with a `component` field so
// logs can be filtered by area; the default `logger` covers the REST handlers.
const sessionLog = component('session');
const oidcLog = component('oidc');
const wsLog = component('ws');
const autosaveLog = component('autosave');
const realtimeLog = component('realtime');

// Calculate the directory name of the current ES module to handle relative path resolution.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize the Express application instance.
const app = express();

// Trust the reverse proxy in front of the app (Cloud Run, a load balancer, nginx)
// so req.ip / req.protocol reflect the real client instead of the proxy. This is
// required for the auth rate limiter to key by the true client IP — without it every
// request appears to come from the proxy and the whole fleet shares one bucket.
// TRUST_PROXY accepts a hop count (e.g. 1 for Cloud Run), a boolean, or an Express
// trust-proxy string (subnet/preset). Default: disabled, for local/dev correctness.
const TRUST_PROXY = process.env.TRUST_PROXY;
if (TRUST_PROXY) {
  if (/^(1|true|yes|on)$/i.test(TRUST_PROXY)) app.set('trust proxy', 1);
  else if (/^(0|false|no|off)$/i.test(TRUST_PROXY)) app.set('trust proxy', false);
  else if (/^\d+$/.test(TRUST_PROXY)) app.set('trust proxy', Number(TRUST_PROXY));
  else app.set('trust proxy', TRUST_PROXY);
}

// Determine the port number: default to 3000 unless overridden by the PORT environment variable.
const PORT = process.env.PORT || 3000;

// Whether REDIS_URL points at a true (cluster-mode-enabled) Redis Cluster, which
// needs a slot-aware client. Leave unset for a single endpoint (a standalone Redis
// or a managed HA instance behind one address, e.g. Memorystore / ElastiCache
// cluster-mode-disabled) — those work with the default single-node client.
const REDIS_CLUSTER = /^(1|true|yes|on)$/i.test(process.env.REDIS_CLUSTER || '');

// Secret used to sign the session ID cookie (and to verify that signature during
// the WebSocket upgrade). Read from SESSION_SECRET. In production it MUST be set:
// a shared, committed value would let anyone who can read the source forge a
// session cookie for any user, so fail fast when it is missing. Outside production
// fall back to a fixed development value so local runs and tests need no extra
// setup. Rotating this value invalidates all existing sessions.
const SESSION_SECRET = process.env.SESSION_SECRET || (() => {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'SESSION_SECRET must be set in production — it signs the session cookie.'
    );
  }
  return 'co-sheet-dev-session-secret';
})();

// Generate RSA key pair for signing mock JWTs at server startup
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});

// Export the public key in JWK format for the JWKS endpoint
/** @type {{ kid?: string, alg?: string, use?: string, [k: string]: any }} */
const jwk = crypto.createPublicKey(publicKey).export({ format: 'jwk' });
jwk.kid = 'mock-key-id';
jwk.alg = 'RS256';
jwk.use = 'sig';

/**
 * Validates that a redirect URI is secure, strictly pointing to localhost or 127.0.0.1
 * with http: or https: schemes.
 * @param {string} redirectUri The URI to validate.
 * @returns {boolean} True if secure, false otherwise.
 */
const isValidLocalRedirect = (redirectUri) => {
  try {
    const parsed = new URL(redirectUri);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
           (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');
  } catch (e) {
    return false;
  }
};

/**
 * Escapes characters in a string to prevent Reflective XSS vulnerabilities.
 * @param {string} str The string to escape.
 * @returns {string} The escaped safe string.
 */
const escapeHtml = (str) => {
  if (typeof str !== 'string') return '';
  return str.replace(/[&<>"']/g, (match) => {
    switch (match) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#39;';
      default: return match;
    }
  });
};

/**
 * Role-based access control (RBAC) configuration.
 *
 * Super admins are NOT assigned through the UI — they are initialized from the
 * environment so the very first privileged account exists before anyone can log
 * in to grant roles. SUPER_ADMIN_EMAILS is a comma-separated list of emails (or,
 * for the local mock/test sign-in that has no email, usernames). Matching is
 * case-insensitive. Everyone else defaults to the 'user' role; admins (and super
 * admins) can promote other users to 'admin' from the permissions page.
 */
const SUPER_ADMIN_IDS = new Set(
  (process.env.SUPER_ADMIN_EMAILS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);

/**
 * Derive a stable, case-insensitive identity key for a session user. Prefers the
 * email (the durable identifier across providers); falls back to username for the
 * local mock/test sign-in which has no email.
 * @param {Object} user The passport session user.
 * @returns {string|null} The identity key, or null if it cannot be derived.
 */
const userIdentity = (user) => {
  if (!user) return null;
  const key = (user.email || user.username || '').trim().toLowerCase();
  return key || null;
};

/**
 * Whether a session user is designated a super admin by the environment.
 * Matches either their email or (for emailless mock/test logins) their username.
 * @param {Object} user The passport session user.
 * @returns {boolean}
 */
const isSuperAdminIdentity = (user) => {
  if (!user) return false;
  const email = (user.email || '').trim().toLowerCase();
  const username = (user.username || '').trim().toLowerCase();
  return (!!email && SUPER_ADMIN_IDS.has(email)) || (!!username && SUPER_ADMIN_IDS.has(username));
};

/**
 * Records a login in the users table and returns the effective role.
 * Super admin status is re-derived from the environment on every login (the env
 * is authoritative): a user listed in SUPER_ADMIN_EMAILS is always 'superadmin',
 * and a previously-stored super admin who has been removed from the env is
 * demoted to 'admin' so stale elevated access does not silently persist.
 * @param {Object} user The passport session user.
 * @returns {Promise<string>} The user's role ('superadmin' | 'admin' | 'user').
 */
async function upsertUser(user) {
  const id = userIdentity(user);
  if (!id) return 'user';
  const envSuper = isSuperAdminIdentity(user);
  const username = user.username || null;
  const email = user.email || null;
  const provider = user.provider || null;
  const picture = user.picture || null;

  const existing = await usersRepo.findUserById(id);

  let role;
  if (existing) {
    if (envSuper) role = 'superadmin';
    else role = (existing.role === 'superadmin') ? 'admin' : (existing.role || 'user');
    await usersRepo.updateUserProfile({ id, username, email, provider, role, picture });
  } else {
    role = envSuper ? 'superadmin' : 'user';
    await usersRepo.insertUser({ id, username, email, role, provider, picture });
  }
  return role;
}

/**
 * Reads a user's effective role without recording a login. Applies the same env
 * authority as upsertUser so super admin status is always honored.
 * @param {Object} user The passport session user.
 * @returns {Promise<string>} The user's role ('superadmin' | 'admin' | 'user').
 */
async function getUserRole(user) {
  const id = userIdentity(user);
  if (!id) return 'user';
  if (isSuperAdminIdentity(user)) return 'superadmin';
  try {
    const row = await usersRepo.findUserById(id);
    if (!row) return 'user';
    return (row.role === 'superadmin') ? 'admin' : (row.role || 'user');
  } catch (e) {
    return 'user';
  }
}

/**
 * The maximum number of files a role may own (the shared 'default' workbook never
 * counts). A regular user gets one; an admin gets five; super admins are unlimited.
 * @param {string} role The effective role ('superadmin' | 'admin' | 'user').
 * @returns {number} The quota (Infinity for unlimited).
 */
const fileLimitForRole = (role) => {
  if (role === 'superadmin') return Infinity;
  if (role === 'admin') return 5;
  return 1;
};

/**
 * Whether creating one more file would exceed the caller's per-role quota.
 * @param {Object} user The passport session user.
 * @param {string} creator The owner identity key.
 * @returns {Promise<boolean>}
 */
async function wouldExceedFileQuota(user, creator) {
  const role = await getUserRole(user);
  const limit = fileLimitForRole(role);
  if (limit === Infinity) return false;
  const owned = await filesRepo.listFileIdsByCreator(creator);
  const ownedCount = owned.filter((r) => r.id !== 'default').length;
  return ownedCount >= limit;
}

/**
 * Reads the owner (created_by identity) of a file.
 * @param {string} fileId
 * @returns {Promise<string|null>} The owner identity, or null if unknown.
 */
async function getFileOwner(fileId) {
  try {
    return await filesRepo.getFileOwner(fileId);
  } catch (e) {
    return null;
  }
}

/**
 * The owner and link-access mode of a file, in one query. Both columns live in the
 * same `files` row, and an access check needs both — reading them separately made
 * it read that row twice.
 * @param {string} fileId
 * @returns {Promise<{ owner: string|null, linkAccess: 'restricted'|'anyone' }>}
 *   Defaults to no owner and 'restricted' for an unknown file or a failed read,
 *   matching what getFileOwner/getFileAccess each returned on their own.
 */
async function getFileAccessInfo(fileId) {
  try {
    const row = await filesRepo.getFileAccessRow(fileId);
    return {
      owner: row ? row.created_by : null,
      linkAccess: row && row.link_access === 'anyone' ? 'anyone' : 'restricted'
    };
  } catch (e) {
    return { owner: null, linkAccess: 'restricted' };
  }
}

/**
 * Whether a user may edit / rename / delete a file. The legacy 'default' workbook
 * is a shared document and stays editable by any authenticated user; for every
 * other file only the owner, admins, and super admins are allowed.
 * @param {Object} user The passport session user (may be null for guest sockets).
 * @param {string} fileId
 * @returns {Promise<boolean>}
 */
async function canModifyFile(user, fileId) {
  if (fileId === 'default') return true;
  const role = await getUserRole(user);
  if (role === 'admin' || role === 'superadmin') return true;
  const id = userIdentity(user);
  // Neither lookup depends on the other, so they go together: this is two round
  // trips rather than three, at the cost of reading the share row for an owner who
  // would have short-circuited before it. One indexed read, in parallel with one
  // this path was making anyway, is worth a round trip on every gated request.
  const [file, shareRole] = await Promise.all([
    getFileAccessInfo(fileId),
    getShareRole(fileId, id)
  ]);
  if (id && file.owner && id === file.owner) return true;
  // A user shared as 'editor' or co-'owner' may modify the file; 'viewer' may not.
  return ['editor', 'owner'].includes(shareRole);
}

/**
 * The share role a user holds on a file, if any.
 * @param {string} fileId
 * @param {string|null} userId
 * @returns {Promise<'owner'|'editor'|'viewer'|null>}
 */
async function getShareRole(fileId, userId) {
  if (!userId) return null;
  try {
    return await sharesRepo.getShareRole(fileId, userId);
  } catch (e) {
    return null;
  }
}

/**
 * Whether a user may open / view a file. The 'default' workbook is public; otherwise
 * the creator, admins, any explicitly-shared user, or anyone when general access is
 * 'anyone' may view. ('anyone' grants view-only — editing is still gated by
 * canModifyFile.)
 * @param {Object} user The passport session user (may be null for guest sockets).
 * @param {string} fileId
 * @returns {Promise<boolean>}
 */
async function canViewFile(user, fileId) {
  if (fileId === 'default') return true;
  const role = await getUserRole(user);
  if (role === 'admin' || role === 'superadmin') return true;
  const id = userIdentity(user);
  // Two round trips, not four: the file row carries owner AND link access (it used
  // to be read once for each), and the share role is fetched alongside it rather
  // than after it. See canModifyFile for why an owner's share read is worth paying.
  const [file, shareRole] = await Promise.all([
    getFileAccessInfo(fileId),
    getShareRole(fileId, id)
  ]);
  if (id && file.owner && id === file.owner) return true;
  if (id && shareRole !== null) return true;
  return file.linkAccess === 'anyone';
}

/**
 * Identity keys of the users a file has been explicitly shared with.
 * @param {string} fileId
 * @returns {Promise<string[]>}
 */
async function getSharedUserIds(fileId) {
  try {
    const rows = await sharesRepo.listShareUserIds(fileId);
    return rows.map((x) => x.user_id);
  } catch (e) {
    return [];
  }
}

/**
 * Map of file id -> share role for every file shared with a given user. Keys give
 * drive visibility; values ('editor'/'viewer') give modify rights.
 * @param {string|null} userId
 * @returns {Promise<Map<string,string>>}
 */
async function getSharedRoleMap(userId) {
  if (!userId) return new Map();
  try {
    const rows = await sharesRepo.listSharesByUser(userId);
    return new Map(rows.map((x) => [x.file_id, x.role || 'viewer']));
  } catch (e) {
    return new Map();
  }
}

/**
 * Set of file ids the given user has starred (a personal favourite). Starring is
 * per-user, so the same file can be starred by some users and not others.
 * @param {string|null} userId
 * @returns {Promise<Set<string>>}
 */
async function getStarredFileIds(userId) {
  if (!userId) return new Set();
  try {
    const rows = await starsRepo.listStarredFileIds(userId);
    return new Set(rows.map((x) => x.file_id));
  } catch (e) {
    return new Set();
  }
}

/**
 * Signs a payload to create a signed JWT using RS256 algorithm.
 * @param {Object} payload The payload containing claims to be encoded in the JWT.
 * @returns {string} The formatted JSON Web Token (header.payload.signature).
 */
const signJwt = (payload) => {
  const header = { alg: 'RS256', typ: 'JWT', kid: 'mock-key-id' };
  const base64Header = Buffer.from(JSON.stringify(header)).toString('base64url');
  const base64Payload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(`${base64Header}.${base64Payload}`);
  const signature = sign.sign(privateKey, 'base64url');
  return `${base64Header}.${base64Payload}.${signature}`;
};

// Compress every text response (the client bundle, the editor HTML, JSON APIs).
// Registered before the routes so it wraps all of them. Nothing sits in front of
// this process in the shipped compose file, so without it `public/` goes out as
// raw bytes: app.js alone is 506 KB uncompressed against 129 KB gzipped, and the
// whole JS+CSS set 861 KB against 216 KB. `compression` skips responses that are
// already compressed or too small to be worth it.
app.use(compression());

// Middleware to parse incoming request bodies as JSON.
app.use(express.json());

// Middleware to parse urlencoded bodies, typical of form submissions.
app.use(express.urlencoded({ extended: true }));

// When Prometheus metrics are enabled (METRICS_PORT set), record the latency and
// outcome of every request. Registered early so it wraps all routes; the actual
// /metrics endpoint is served on a separate port (see startMetricsServer below).
if (isMetricsEnabled()) {
  app.use(httpMetricsMiddleware);
}

// ---------------------------------------------------------------------------
// Health / probe endpoints for Kubernetes (and other orchestrators).
//
// Registered before the session/auth middleware so they are public, cheap, and
// never allocate a session. Three distinct probes with different semantics:
//
//   GET /livez     Liveness  — the process is up and the event loop responsive.
//                  Always 200. A failure here means the container is wedged and
//                  should be restarted; it deliberately checks no dependencies
//                  so a transient DB/Redis outage never triggers a kill loop.
//
//   GET /startupz  Startup   — initialization (DB schema, state load, bus init)
//                  has finished. 200 once ready, else 503. Point the startup
//                  probe here so liveness/readiness don't run until boot is done.
//
//   GET /readyz    Readiness — this instance can serve traffic: startup is done
//                  AND its backing dependencies (Postgres, and Redis when
//                  configured) are reachable. 200 when all checks pass, else 503
//                  with a per-check breakdown so a failing instance is pulled
//                  from the load balancer without being restarted.
//
// All three respond to HEAD as well (Express maps HEAD to the GET handler), so
// `httpGet` probes work whether or not they send a body.
// ---------------------------------------------------------------------------

// Flipped true once the startup sequence in `ready` completes (see below).
let startupComplete = false;

app.get('/livez', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.get('/startupz', (req, res) => {
  if (startupComplete) {
    res.status(200).json({ status: 'ok' });
  } else {
    res.status(503).json({ status: 'starting' });
  }
});

app.get('/readyz', async (req, res) => {
  const checks = { startup: startupComplete ? 'ok' : 'starting', db: 'ok', redis: 'ok' };
  let healthy = startupComplete;

  // Postgres: a trivial round-trip proves the pool can reach the database.
  try {
    await pool.query('SELECT 1');
  } catch (e) {
    checks.db = `error: ${e && e.message ? e.message : 'query failed'}`;
    healthy = false;
  }

  // Redis: no-op (always ok) in single-instance mode; a real PING when configured.
  try {
    if (!(await bus.ping())) {
      checks.redis = 'error: ping failed';
      healthy = false;
    }
  } catch (e) {
    checks.redis = `error: ${e && e.message ? e.message : 'ping failed'}`;
    healthy = false;
  }

  res.status(healthy ? 200 : 503).json({ status: healthy ? 'ok' : 'error', checks });
});

// Shared session store, queried both by the HTTP session middleware and during
// the WebSocket upgrade. With multiple app instances the store MUST be shared, or
// a socket whose login landed on instance A can't be authenticated on instance B.
// When REDIS_URL is set we back it with Redis; otherwise we keep the in-memory
// store (single-instance / local / tests). Top-level await is fine here — ESM
// supports it and it simply delays the rest of module init until the store is up.
let sessionStore;
const redisConfig = resolveRedisOptions({ redisUrl: process.env.REDIS_URL, cluster: REDIS_CLUSTER });
if (redisConfig) {
  const { RedisStore } = await import('connect-redis');
  // A cluster-aware client when REDIS_CLUSTER is set, else a single-node client.
  // connect-redis works with either.
  const sessionRedisClient = await createRedisClient(redisConfig);
  sessionRedisClient.on('error', (e) => sessionLog.error({ err: e }, 'redis error'));
  await sessionRedisClient.connect();
  sessionStore = new RedisStore({ client: sessionRedisClient, prefix: 'cosheet:sess:' });
  sessionLog.info(`using Redis-backed session store (${redisConfig.cluster ? 'cluster' : 'single'})`);
} else {
  sessionStore = new session.MemoryStore();
}

// Configure express-session middleware with secure false cookie configuration.
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: sessionStore,
  cookie: { secure: false }
}));

// Initialize passport and passport.session() middleware for managing authenticated sessions.
app.use(passport.initialize());
app.use(passport.session());

// Set up serialize and deserialize user functions for session persistence.
passport.serializeUser((user, done) => {
  done(null, user);
});
passport.deserializeUser((obj, done) => {
  done(null, obj);
});

// Rate limiting for auth + write routes. The counter store is shared across app
// instances via Redis when configured, so limits are enforced globally (not per
// replica); a dedicated connection keeps limiter traffic off the session client.
// Enabled in production by default (RATE_LIMIT_ENABLED overrides) — the middleware is
// always mounted but stays inert elsewhere, so local dev and tests are unaffected.
const RATE_LIMIT_ENABLED = process.env.RATE_LIMIT_ENABLED
  ? /^(1|true|yes|on)$/i.test(process.env.RATE_LIMIT_ENABLED)
  : process.env.NODE_ENV === 'production';
let rateLimitRedisClient = null;
if (redisConfig && RATE_LIMIT_ENABLED) {
  rateLimitRedisClient = await createRedisClient(redisConfig);
  rateLimitRedisClient.on('error', (e) => logger.error({ err: e }, 'rate-limit redis error'));
  await rateLimitRedisClient.connect();
}
const { authLimiter, writeLimiter } = createRateLimiters({
  redisClient: rateLimitRedisClient,
  cluster: !!(redisConfig && redisConfig.cluster),
  enabled: RATE_LIMIT_ENABLED
});
// Mounted before the route definitions below so they wrap those handlers. authLimiter
// guards the login / OIDC / OAuth endpoints (brute force); writeLimiter guards the
// state-changing /api routes (writeLimiter itself skips read-only GET/HEAD).
app.use(['/login', '/logout', '/auth', '/oidc'], authLimiter);
app.use('/api', writeLimiter);



/**
 * Returns true when a real, external OIDC provider has been fully configured via
 * the OIDC_* environment variables. Used both to register the 'oidc-sso' strategy
 * and to gate its login/callback routes so they fail gracefully when unconfigured.
 */
const isExternalOidcConfigured = () => Boolean(
  process.env.OIDC_ISSUER &&
  process.env.OIDC_AUTHORIZATION_URL &&
  process.env.OIDC_TOKEN_URL &&
  process.env.OIDC_CLIENT_ID &&
  process.env.OIDC_CLIENT_SECRET
);

/**
 * Build the HTTPS agent to hand the 'oidc-sso' strategy, or undefined to use the
 * default (verifying) agent. Returns an insecure agent only when OIDC_TLS_VERIFY
 * is disabled AND a configured endpoint is HTTPS (see services/oidc-tls.js). This
 * exists because a self-hosted OIDC server on the LAN often uses a self-signed
 * certificate whose CA is not installed in the machine's trust store, which would
 * otherwise fail token/userinfo calls with UNABLE_TO_VERIFY_LEAF_SIGNATURE /
 * SELF_SIGNED_CERT_IN_CHAIN.
 */
const buildOidcAgent = () => {
  if (!shouldSkipOidcTls()) return undefined;
  oidcLog.warn('OIDC_TLS_VERIFY is disabled — skipping TLS certificate ' +
    'verification for the external (Local OIDC) provider. Use only for a trusted ' +
    'self-signed server on a trusted network.');
  return new https.Agent({ rejectUnauthorized: false });
};

/**
 * Registers the OIDC authentication strategy dynamically.
 * This is done after the server starts listening because the port number
 * can be dynamic, and the strategy relies on the port for issuer and endpoint URLs.
 */
const registerStrategies = () => {
  // Determine the base URL for OAuth callbacks: prefer BASE_URL from the environment
  // (e.g., when deployed on Cloud Run) and fallback to localhost when running locally.
  const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;

  passport.use('oidc', new OIDCStrategy({
    issuer: `${baseUrl}/oidc`,
    authorizationURL: `${baseUrl}/oidc/authorize`,
    tokenURL: `${baseUrl}/oidc/token`,
    userInfoURL: `${baseUrl}/oidc/userinfo`,
    clientID: 'co-sheet-client-id',
    clientSecret: 'co-sheet-client-secret',
    callbackURL: `${baseUrl}/auth/oidc/callback`,
    scope: 'openid profile email'
  }, (issuer, profile, done) => {
    // Authenticate the user and pass their profile details to passport.
    return done(null, {
      username: profile.displayName || profile.username || 'Unknown User',
      email: profile.emails && profile.emails[0] ? profile.emails[0].value : null,
      picture: profile.photos && profile.photos[0] ? profile.photos[0].value : null,
      provider: 'oidc'
    });
  }));

  // Register an external / self-hosted OIDC provider (e.g. Keycloak, Authentik,
  // Dex, Zitadel, Okta) when its endpoints and client credentials are configured.
  // This is independent of the built-in mock 'oidc' strategy above, so a real
  // local OIDC server and the mock can coexist as separate login options.
  if (isExternalOidcConfigured()) {
    passport.use('oidc-sso', new OIDCStrategy({
      issuer: process.env.OIDC_ISSUER,
      authorizationURL: process.env.OIDC_AUTHORIZATION_URL,
      tokenURL: process.env.OIDC_TOKEN_URL,
      userInfoURL: process.env.OIDC_USERINFO_URL || `${process.env.OIDC_ISSUER.replace(/\/$/, '')}/userinfo`,
      clientID: process.env.OIDC_CLIENT_ID,
      clientSecret: process.env.OIDC_CLIENT_SECRET,
      callbackURL: `${baseUrl}/auth/oidc-sso/callback`,
      scope: process.env.OIDC_SCOPE || 'openid profile email',
      // Some self-hosted providers don't expose a userinfo endpoint (or the
      // `profile` scope). Our 9-arg verify would otherwise make passport-openidconnect
      // always GET userinfo, so every login would fail with "Failed to fetch user
      // profile". OIDC_SKIP_USERINFO skips that call and derives identity from the
      // ID-token claims (the verify callback falls back to idProfile below).
      skipUserProfile: isExternalOidcUserinfoSkipped(),
      // When OIDC_TLS_VERIFY is disabled (self-signed local provider), pass an
      // https.Agent that skips cert verification; otherwise undefined keeps the
      // default verifying agent. Scoped to this strategy so Google/other TLS is
      // unaffected. passport-openidconnect forwards this to the oauth2 client's
      // token + userinfo requests via setAgent().
      agent: buildOidcAgent()
    },
    // 9-argument verify signature so passport-openidconnect hands us `uiProfile`,
    // whose `_json` carries the raw userinfo claims. Different providers expose the
    // display name as `name` or `preferred_username`, so we fall back across both.
    (issuer, uiProfile, idProfile, context, idToken, accessToken, refreshToken, params, done) => {
      const json = (uiProfile && uiProfile._json) || {};
      const profile = uiProfile || idProfile || {};
      return done(null, {
        username: json.name || json.preferred_username || profile.displayName || profile.username || 'OIDC User',
        email: json.email || (profile.emails && profile.emails[0] ? profile.emails[0].value : null),
        picture: json.picture || (profile.photos && profile.photos[0] ? profile.photos[0].value : null),
        provider: 'oidc-sso'
      });
    }));
  }

  // Register Google OIDC strategy if credentials are configured and Google login
  // is enabled (GOOGLE_LOGIN_ENABLED).
  if (isGoogleLoginEnabled() && process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    passport.use('google', new OIDCStrategy({
      issuer: 'https://accounts.google.com',
      authorizationURL: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenURL: 'https://oauth2.googleapis.com/token',
      userInfoURL: 'https://openidconnect.googleapis.com/v1/userinfo',
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: `${baseUrl}/auth/google/callback`,
      scope: 'openid profile email'
    },
    // 9-argument verify signature so passport-openidconnect hands us `uiProfile`,
    // which carries the raw userinfo JSON (`_json`). Google's profile picture is in
    // `_json.picture` and is NOT exposed on the parsed `profile` / `profile.photos`.
    (issuer, uiProfile, idProfile, context, idToken, accessToken, refreshToken, params, done) => {
      const json = (uiProfile && uiProfile._json) || {};
      const profile = uiProfile || idProfile || {};
      return done(null, {
        username: json.name || profile.displayName || profile.username || 'Google User',
        email: json.email || (profile.emails && profile.emails[0] ? profile.emails[0].value : null),
        picture: json.picture || null,
        provider: 'google'
      });
    }));
  }
};

/**
 * Middleware that checks if a request is authenticated.
 * Redirects unauthenticated requests to the /login page,
 * or returns a 401 JSON response for unauthenticated API requests starting with '/api/'.
 */
const ensureAuthenticated = (req, res, next) => {
  if (req.isAuthenticated()) {
    return next();
  }

  // For unauthenticated API endpoints, return a 401 JSON error instead of redirecting to login.
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({
      error: 'unauthorized',
      message: 'Authentication required'
    });
  }

  res.redirect('/login');
};

/**
 * Middleware that restricts a route to admins and super admins. Returns 401 for
 * unauthenticated requests and 403 for authenticated users lacking privileges.
 * On success it attaches the resolved role to req.userRole.
 */
const ensureAdmin = async (req, res, next) => {
  if (!req.isAuthenticated || !req.isAuthenticated()) {
    return res.status(401).json({ error: 'unauthorized', message: 'Authentication required' });
  }
  try {
    const role = await getUserRole(req.user);
    if (role === 'admin' || role === 'superadmin') {
      req.userRole = role;
      return next();
    }
  } catch (e) {
    logger.error({ err: e }, 'Role check failed');
  }
  return res.status(403).json({ error: 'forbidden', message: 'Admin privileges required' });
};

/**
 * OIDC Discovery Endpoint:
 * Serves the OpenID provider configuration. This includes metadata about the
 * issuer URL, authorization endpoint, token endpoint, and user info endpoint.
 */
app.get('/oidc/.well-known/openid-configuration', requireMockOidcEnabled, (req, res) => {
  const host = `http://localhost:${PORT}`;
  res.json({
    issuer: `${host}/oidc`,
    authorization_endpoint: `${host}/oidc/authorize`,
    token_endpoint: `${host}/oidc/token`,
    userinfo_endpoint: `${host}/oidc/userinfo`,
    jwks_uri: `${host}/oidc/jwks`,
    response_types_supported: ['code'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256']
  });
});

/**
 * OIDC JWKS Endpoint:
 * Serves the public keys used for signing token signatures.
 */
app.get('/oidc/jwks', requireMockOidcEnabled, (req, res) => {
  res.json({
    keys: [jwk]
  });
});

/**
 * OIDC Authorization Endpoint:
 * Displays a mock login form to the user. On submission, the form sends
 * user information to the login endpoint to simulate sign-in.
 * Validates the redirect_uri is local to prevent open redirect vulnerabilities,
 * and escapes form properties to prevent reflective XSS.
 */
app.get('/oidc/authorize', requireMockOidcEnabled, (req, res) => {
  const { redirect_uri, state, client_id } = req.query;

  // Open Redirect Validation: Validate that redirect_uri is defined and strictly local
  if (!redirect_uri || !isValidLocalRedirect(redirect_uri)) {
    return res.status(400).send('Invalid redirect_uri: Must be a local address.');
  }

  // Escape parameters to prevent Reflective XSS
  const safeRedirectUri = escapeHtml(redirect_uri);
  const safeState = escapeHtml(state || '');
  const safeClientId = escapeHtml(client_id || '');

  // Render a simple mock login page.
  res.send(`
    <form action="/oidc/login" method="POST">
      <input type="hidden" name="redirect_uri" value="${safeRedirectUri}">
      <input type="hidden" name="state" value="${safeState}">
      <input type="hidden" name="client_id" value="${safeClientId}">
      <h2>Mock Local OIDC Login</h2>
      <label>Username: <input type="text" name="username" required></label>
      <button type="submit">Sign In</button>
    </form>
  `);
});

/**
 * Mock Login Endpoint:
 * Processes the mock sign-in form. Generates a mock authorization code
 * by encoding the username in base64, then redirects back to the client app.
 * Validates the redirect_uri is local to prevent open redirect vulnerabilities.
 */
app.post('/oidc/login', requireMockOidcEnabled, (req, res) => {
  const { redirect_uri, state, username } = req.body;

  // Open Redirect Validation
  if (!redirect_uri || !isValidLocalRedirect(redirect_uri)) {
    return res.status(400).send('Invalid redirect_uri: Must be a local address.');
  }

  // Keep it simple: base64-encode the user information to represent the auth code.
  const mockCode = Buffer.from(JSON.stringify({ username })).toString('base64');
  
  // Safely construct redirect URL with search parameters
  const redirectUrl = new URL(redirect_uri);
  redirectUrl.searchParams.set('code', mockCode);
  if (state) {
    redirectUrl.searchParams.set('state', state);
  }
  res.redirect(redirectUrl.toString());
});

/**
 * Token Exchange Endpoint:
 * Exchanges the authorization code for access and ID tokens.
 * The id_token is returned as a valid signed JWT using RS256.
 */
app.post('/oidc/token', requireMockOidcEnabled, (req, res) => {
  const { code, client_id } = req.body;
  try {
    if (!code) {
      return res.status(400).json({ error: 'invalid_request', error_description: 'Missing code parameter.' });
    }
    // Decode the base64 code to extract user details.
    const decoded = JSON.parse(Buffer.from(code, 'base64').toString('ascii'));
    if (!decoded || !decoded.username) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'Invalid code content.' });
    }
    const accessToken = `mock-access-token-${decoded.username}`;

    const host = `http://localhost:${PORT}`;
    const now = Math.floor(Date.now() / 1000);
    const idTokenPayload = {
      iss: `${host}/oidc`,
      sub: `mock-sub-${decoded.username}`,
      aud: client_id || 'co-sheet-client-id',
      exp: now + 3600,
      iat: now,
      name: decoded.username,
      email: `${decoded.username}@localhost`
    };

    const idToken = signJwt(idTokenPayload);

    res.json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: 3600,
      id_token: idToken
    });
  } catch (e) {
    res.status(400).json({ error: 'invalid_grant', error_description: 'Failed to parse code.' });
  }
});

/**
 * User Info Endpoint:
 * Decodes the access token to return mock user profile metadata.
 * Validates that the authorization header starts with Bearer mock-access-token-.
 */
app.get('/oidc/userinfo', requireMockOidcEnabled, (req, res) => {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer mock-access-token-')) {
    return res.status(401).json({ error: 'invalid_token', error_description: 'Access token is missing or invalid.' });
  }
  const token = authHeader.replace('Bearer ', '');
  const username = token.replace('mock-access-token-', '');
  res.json({
    sub: `mock-sub-${username}`,
    name: username,
    email: `${username}@localhost`
  });
});

/**
 * Whether the built-in "Mock OIDC" sign-in option is offered on the login page.
 * The mock provider is intended for local development & tests, so it should be
 * hidden in production deployments. Controlled by MOCK_OIDC_ENABLED:
 *   - unset/blank: enabled outside production (NODE_ENV !== 'production')
 *   - "false"/"0"/"no"/"off": always disabled
 *   - any other value: always enabled
 * This governs both the visibility of the login button and whether the mock
 * provider/login routes respond at all (see requireMockOidcEnabled).
 */
function isMockOidcEnabled() {
  const v = process.env.MOCK_OIDC_ENABLED;
  if (v === undefined || v.trim() === '') {
    return process.env.NODE_ENV !== 'production';
  }
  return !/^(false|0|no|off)$/i.test(v.trim());
}

/**
 * Express middleware that gates the built-in mock OIDC routes. When mock OIDC is
 * disabled the provider/login endpoints respond as if they don't exist (404), so
 * the mock sign-in is fully unreachable in production rather than merely hidden.
 * Declared as a function so it is hoisted for routes defined earlier in the file.
 */
function requireMockOidcEnabled(req, res, next) {
  if (!isMockOidcEnabled()) {
    return res.status(404).send('Not Found');
  }
  next();
}

/**
 * Whether the "Sign in with Google" option is offered on the login page. Unlike
 * the mock provider, Google is the primary production sign-in, so it is ENABLED
 * by default and only turned off when GOOGLE_LOGIN_ENABLED is explicitly set to a
 * falsy value:
 *   - unset/blank: enabled
 *   - "false"/"0"/"no"/"off": disabled
 *   - any other value: enabled
 * This governs both the visibility of the login button and whether the
 * /auth/google routes respond at all (see requireGoogleLoginEnabled), so a
 * disabled Google option is fully unreachable rather than merely hidden.
 */
function isGoogleLoginEnabled() {
  const v = process.env.GOOGLE_LOGIN_ENABLED;
  if (v === undefined || v.trim() === '') {
    return true;
  }
  return !/^(false|0|no|off)$/i.test(v.trim());
}

/**
 * Express middleware that gates the Google sign-in routes. When Google login is
 * disabled the /auth/google endpoints respond as if they don't exist (404), so
 * the option is fully unreachable rather than merely hidden on the login page.
 * Declared as a function so it is hoisted for routes defined earlier in the file.
 */
function requireGoogleLoginEnabled(req, res, next) {
  if (!isGoogleLoginEnabled()) {
    return res.status(404).send('Not Found');
  }
  next();
}

// Cache-busting version for the client assets, computed once at startup from a
// content hash of every stamped file in public/. It is appended as `?v=<hash>` to
// every local <script>/<link> URL in the three HTML entry points, so a deploy
// always changes those URLs — defeating any browser or intermediary (CDN/proxy)
// cache that would otherwise keep serving a stale bundle. It is also what lets
// those URLs be served `immutable` (see the static handler): the hash IS the cache
// key. Any change to any hashed file bumps it; a timestamp is the fallback if the
// directory can't be hashed.
//
// STAMPED_ASSET_EXTENSIONS must cover every file type whose URL carries `?v=`. A
// stamped type missing from this list is the one dangerous combination: its URL
// would be cached for a year behind a hash that never changes when it does. It
// grew to include .css when the stylesheets were stamped.
const STAMPED_ASSET_EXTENSIONS = ['.js', '.css'];
const ASSET_VERSION = (() => {
  try {
    const dir = path.join(__dirname, 'public');
    const files = fs.readdirSync(dir)
      .filter((f) => STAMPED_ASSET_EXTENSIONS.some((ext) => f.endsWith(ext)))
      .sort();
    const hash = crypto.createHash('md5');
    for (const f of files) hash.update(fs.readFileSync(path.join(dir, f)));
    return hash.digest('hex').slice(0, 10);
  } catch (err) {
    logger.warn({ err }, 'Could not hash public assets for cache-busting; using timestamp');
    return String(Date.now());
  }
})();

/** Substitute the asset version into a page's `?v={{ASSET_VERSION}}` URLs. */
const stampAssets = (html) => html.split('{{ASSET_VERSION}}').join(ASSET_VERSION);

// The HTML entry points are read and templated once at startup rather than per
// request: the files never change while the process runs, and neither does
// ASSET_VERSION, so doing it per request was repeating identical work on the
// request path of every page. `loginPageHtml` already worked this way; the editor
// and drive pages now do too. The editor keeps one placeholder, {{FILE_NAME}},
// which genuinely varies per request.
const LOGIN_HTML_PATH = path.join(__dirname, 'public', 'login.html');
let loginPageHtml = fs.readFileSync(LOGIN_HTML_PATH, 'utf8');
if (!isMockOidcEnabled()) {
  loginPageHtml = loginPageHtml.replace(
    /\s*<!-- MOCK_OIDC_START:[\s\S]*?<!-- MOCK_OIDC_END -->/,
    ''
  );
}
if (!isGoogleLoginEnabled()) {
  loginPageHtml = loginPageHtml.replace(
    /\s*<!-- GOOGLE_LOGIN_START:[\s\S]*?<!-- GOOGLE_LOGIN_END -->/,
    ''
  );
}
loginPageHtml = stampAssets(loginPageHtml);

const drivePageHtml = stampAssets(
  fs.readFileSync(path.join(__dirname, 'private', 'drive.html'), 'utf8')
);
const editorPageTemplate = stampAssets(
  fs.readFileSync(path.join(__dirname, 'private', 'index.html'), 'utf8')
);

// Serve the login page.
app.get('/login', (req, res) => {
  res.set('Cache-Control', 'no-cache').type('html').send(loginPageHtml);
});

// Redirect direct requests for index.html to the home (drive) route, so they are subject to auth.
app.get('/index.html', (req, res) => {
  res.redirect('/');
});

// Define the root route to serve the file management interface ("drive") from the
// private directory. This is the first screen users see after signing in.
// Protected: unauthenticated users are redirected to /login.
app.get('/', ensureAuthenticated, (req, res) => {
  res.set('Cache-Control', 'no-cache').type('html').send(drivePageHtml);
});

// Serve the spreadsheet editor. The specific workbook is selected via the
// ?file=<id> query parameter (absent => the legacy 'default' workbook). The
// file's name is rendered into the HTML server-side so the header shows the
// correct title on first paint (no placeholder flicker).
// Protected: unauthenticated users are redirected to /login.
app.get('/sheet', ensureAuthenticated, async (req, res) => {
  try {
    const requested = req.query.file;
    const fileId = (typeof requested === 'string' && isValidFileId(requested)) ? requested : 'default';

    // Enforce general access: a restricted file is only openable by the owner(s),
    // admins, and explicitly-shared users. Others are sent back to the drive.
    if (!(await canViewFile(req.user, fileId))) {
      return res.redirect('/');
    }

    let name = 'Untitled spreadsheet';
    try {
      const lookedUpName = await filesRepo.getFileName(fileId);
      if (lookedUpName) name = lookedUpName;
    } catch (e) {
      // Fall back to the default name if the lookup fails.
    }

    const html = editorPageTemplate.split('{{FILE_NAME}}').join(escapeHtml(name));
    // Always revalidated, so a deploy's new asset hashes always reach the browser.
    // That is what lets the assets those hashes name be cached indefinitely.
    res.set('Cache-Control', 'no-cache').type('html').send(html);
  } catch (err) {
    logger.error({ err: err }, 'Error serving editor');
    // The templated page with a neutral name, never the raw file: sending that
    // would leak the literal {{FILE_NAME}} / {{ASSET_VERSION}} tokens to the
    // browser and, with unstamped asset URLs, quietly bypass the version hash.
    res.set('Cache-Control', 'no-cache').type('html')
      .send(editorPageTemplate.split('{{FILE_NAME}}').join('Untitled spreadsheet'));
  }
});

// Trigger the built-in mock OIDC authentication flow. Gated so it is unreachable
// when mock OIDC is disabled (e.g. production).
app.get('/auth/oidc', requireMockOidcEnabled, passport.authenticate('oidc'));

// Mock OIDC provider callback route after authentication is completed.
app.get('/auth/oidc/callback', requireMockOidcEnabled, passport.authenticate('oidc', {
  successRedirect: '/',
  failureRedirect: '/login'
}));

// Trigger the external / self-hosted OIDC sign-in flow. When the OIDC_* variables
// are not configured, the 'oidc-sso' strategy does not exist, so redirect back to
// the login page with an error flag instead of throwing.
app.get('/auth/oidc-sso', (req, res, next) => {
  if (!isExternalOidcConfigured()) {
    return res.redirect('/login?error=oidc_not_configured');
  }
  passport.authenticate('oidc-sso')(req, res, next);
});

// External OIDC provider callback route after authentication is completed.
app.get('/auth/oidc-sso/callback', (req, res, next) => {
  if (!isExternalOidcConfigured()) {
    return res.redirect('/login');
  }
  passport.authenticate('oidc-sso', {
    successRedirect: '/',
    failureRedirect: '/login'
  })(req, res, next);
});

// Route for Google OAuth redirect setup or mock login fallback. Gated so it is
// unreachable when Google login is disabled (GOOGLE_LOGIN_ENABLED).
app.get('/auth/google', requireGoogleLoginEnabled, (req, res, next) => {
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    passport.authenticate('google')(req, res, next);
  } else {
    // Serve beautiful mock Google Sign-in page
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Mock Google Sign-In</title>
        <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&display=swap" rel="stylesheet">
        <style>
          body {
            font-family: 'Roboto', sans-serif;
            background-color: #f8f9fa;
            display: flex;
            align-items: center;
            justify-content: center;
            height: 100vh;
            margin: 0;
          }
          .card {
            background-color: #ffffff;
            border: 1px solid #dadce0;
            border-radius: 8px;
            width: 450px;
            padding: 40px;
            box-sizing: border-box;
            text-align: center;
          }
          .google-logo {
            width: 75px;
            height: 24px;
            margin-bottom: 20px;
          }
          h2 {
            font-size: 24px;
            color: #202124;
            margin: 0 0 8px 0;
            font-weight: 400;
          }
          p {
            font-size: 16px;
            color: #202124;
            margin: 0 0 30px 0;
          }
          .input-group {
            margin-bottom: 20px;
            text-align: left;
          }
          input {
            width: 100%;
            padding: 16px;
            border: 1px solid #dadce0;
            border-radius: 4px;
            font-size: 16px;
            box-sizing: border-box;
            outline: none;
            transition: border-color 0.2s;
          }
          input:focus {
            border-color: #1a73e8;
          }
          .buttons {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-top: 35px;
          }
          .create-account {
            color: #1a73e8;
            font-size: 14px;
            font-weight: 500;
            text-decoration: none;
            cursor: pointer;
          }
          button {
            background-color: #1a73e8;
            color: white;
            border: none;
            border-radius: 4px;
            padding: 10px 24px;
            font-size: 14px;
            font-weight: 500;
            cursor: pointer;
            transition: background-color 0.2s;
          }
          button:hover {
            background-color: #1557b0;
          }
        </style>
      </head>
      <body>
        <div class="card">
          <svg class="google-logo" viewBox="0 0 74 24" width="75" height="24">
            <path fill="#ea4335" d="M9.2 11.2V9.3h6c.1.3.1.7.1 1.2 0 1.5-.4 2.9-1.2 3.8-.8.9-2 1.4-3.5 1.4-2.8 0-5.1-2.2-5.1-5.1S7.7 5.1 10.5 5.1c1.5 0 2.7.6 3.6 1.4L12.8 8c-.6-.6-1.4-1-2.3-1-1.7 0-3.2 1.4-3.2 3.2s1.5 3.2 3.2 3.2c1.2 0 2.1-.5 2.6-1.1.4-.4.6-1 .7-1.9H9.2z"/>
            <path fill="#4285f4" d="M25.3 11c0 2.8-2.1 4.9-4.8 4.9S15.7 13.8 15.7 11s2.1-4.9 4.8-4.9 4.8 2.1 4.8 4.9zm-1.9 0c0-1.8-1.3-3.1-2.9-3.1s-2.9 1.3-2.9 3.1 1.3 3.1 2.9 3.1 2.9-1.3 2.9-3.1z"/>
            <path fill="#fabc05" d="M36.1 11c0 2.8-2.1 4.9-4.8 4.9S26.5 13.8 26.5 11s2.1-4.9 4.8-4.9 4.8 2.1 4.8 4.9zm-1.9 0c0-1.8-1.3-3.1-2.9-3.1s-2.9 1.3-2.9 3.1 1.3 3.1 2.9 3.1 2.9-1.3 2.9-3.1z"/>
            <path fill="#34a853" d="M46.7 6.4v8.9c0 3.7-2.2 5.2-4.7 5.2-2.4 0-3.8-1.6-4.4-2.9l1.6-.7c.3.7 1 1.6 2.7 1.6 1.7 0 2.8-1 2.8-3v-.7h-.1c-.5.6-1.5 1.2-2.7 1.2-2.5 0-4.6-2.1-4.6-4.9 0-2.8 2.1-4.9 4.6-4.9 1.2 0 2.2.5 2.7 1.2h.1V6.4h1.7zm-1.8 4.7c0-1.7-1.1-3-2.6-3s-2.7 1.3-2.7 3 1.1 3 2.7 3 2.6-1.3 2.6-3z"/>
            <path fill="#4285f4" d="M49.4.9h1.8v14.4H49.4z"/>
            <path fill="#ea4335" d="M59 12.6l1.4 1c-.5.7-1.7 2.3-3.9 2.3-2.6 0-4.6-2-4.6-4.9 0-3 2.1-4.9 4.4-4.9 2.3 0 3.4 2 3.8 3.1l.2.5-5.9 2.4c.5.9 1.1 1.3 2.1 1.3s1.7-.5 2.5-1.4zm-5.3-1.8l3.9-1.6c-.2-.6-.9-1-1.6-1-1 0-2 .9-2 2.6z"/>
          </svg>
          <h2>Sign in</h2>
          <p>with your Google Account</p>
          <form action="/auth/google/mock-login" method="POST">
            <div class="input-group">
              <input type="email" name="email" placeholder="Email or phone" required>
            </div>
            <div class="input-group">
              <input type="text" name="name" placeholder="Your Name" required>
            </div>
            <div class="buttons">
              <span class="create-account">Create account</span>
              <button type="submit">Next</button>
            </div>
          </form>
        </div>
      </body>
      </html>
    `);
  }
});

// Handle mock Google login form submissions. Gated alongside the other Google
// routes (GOOGLE_LOGIN_ENABLED).
app.post('/auth/google/mock-login', requireGoogleLoginEnabled, (req, res) => {
  const { email, name } = req.body;
  req.login({ username: name || email || 'Google User', email: email || null, picture: null, provider: 'google' }, (err) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.redirect('/');
  });
});

// Callback receiver for Google OAuth OIDC redirects. Gated so it is unreachable
// when Google login is disabled (GOOGLE_LOGIN_ENABLED).
app.get('/auth/google/callback', requireGoogleLoginEnabled, (req, res, next) => {
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    passport.authenticate('google', {
      successRedirect: '/',
      failureRedirect: '/login'
    })(req, res, next);
  } else {
    res.redirect('/login');
  }
});

// Test-only authentication endpoint to allow integration tests to easily obtain a session cookie.
if (process.env.NODE_ENV === 'test') {
  app.post('/auth/test-login', (req, res) => {
    const user = { username: req.body.username || 'Test User', provider: 'test' };
    req.login(user, (err) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.json({ success: true, user });
    });
  });
}

/**
 * GET /logout
 * Logs out the user session, destroys session state, clears the cookie, and redirects to the login screen.
 */
app.get('/logout', (req, res, next) => {
  req.logout((err) => {
    if (err) {
      return next(err);
    }
    req.session.destroy((destroyErr) => {
      if (destroyErr) {
        return next(destroyErr);
      }
      res.clearCookie('connect.sid');
      res.redirect('/login');
    });
  });
});

/**
 * GET /api/me
 * Returns the currently authenticated user's profile info (username and provider).
 * Protected by ensureAuthenticated middleware.
 */
app.get('/api/me', ensureAuthenticated, async (req, res) => {
  // Record this login (so the user appears on the permissions page) and resolve
  // their effective role. Failure to touch the users table must not break /api/me.
  let role = 'user';
  try {
    role = await upsertUser(req.user);
  } catch (e) {
    logger.error({ err: e }, 'Failed to record login');
    try { role = await getUserRole(req.user); } catch (e2) { /* default 'user' */ }
  }
  res.json({
    username: req.user.username,
    email: req.user.email || null,
    picture: req.user.picture || null,
    provider: req.user.provider,
    role
  });
});

/**
 * GET /api/users
 * Lists all users who have signed in, with their roles, for the permissions page.
 * Restricted to admins and super admins. Each row carries `superAdmin` (env-locked,
 * not editable) and `self` (the requesting user) flags so the UI can lock those rows.
 */
app.get('/api/users', ensureAdmin, async (req, res) => {
  try {
    const rows = await usersRepo.listUsers();
    const selfId = userIdentity(req.user);
    const users = rows.map((r) => {
      const superAdmin = SUPER_ADMIN_IDS.has(String(r.id).toLowerCase());
      // Env super admins always display as such; a stale stored 'superadmin' that
      // is no longer in the env is shown as 'admin' (mirrors getUserRole).
      const role = superAdmin ? 'superadmin' : (r.role === 'superadmin' ? 'admin' : (r.role || 'user'));
      return {
        id: r.id,
        username: r.username,
        email: r.email,
        role,
        provider: r.provider,
        picture: r.picture || null,
        last_login: r.last_login,
        superAdmin,
        self: r.id === selfId
      };
    });
    res.json({ role: req.userRole, users });
  } catch (err) {
    logger.error({ err: err }, 'Error listing users');
    res.status(500).json({ error: 'internal_server_error', message: 'Failed to list users' });
  }
});

/**
 * PATCH /api/users/:id
 * Changes a user's role. Restricted to admins and super admins. Guardrails:
 *  - the new role must be 'user' or 'admin' (super admin is env-only, never granted here);
 *  - super admins cannot be modified;
 *  - callers cannot change their own role (prevents accidental self-lockout).
 */
app.patch('/api/users/:id', ensureAdmin, async (req, res) => {
  try {
    const id = String(req.params.id || '').toLowerCase();
    const role = req.body && req.body.role;
    if (role !== 'user' && role !== 'admin') {
      return res.status(400).json({ error: 'bad_request', message: "role must be 'user' or 'admin'" });
    }
    if (id === userIdentity(req.user)) {
      return res.status(400).json({ error: 'bad_request', message: 'You cannot change your own role' });
    }
    const target = await usersRepo.findUserById(id);
    if (!target) {
      return res.status(404).json({ error: 'not_found', message: 'User not found' });
    }
    if (SUPER_ADMIN_IDS.has(id) || target.role === 'superadmin') {
      return res.status(403).json({ error: 'forbidden', message: 'Super admins cannot be modified' });
    }
    await usersRepo.updateUserRole(id, role);
    res.json({ success: true, id, role });
  } catch (err) {
    logger.error({ err: err }, 'Error updating user role');
    res.status(500).json({ error: 'internal_server_error', message: 'Failed to update role' });
  }
});

/**
 * Loads the spreadsheet cell state from the store.json file.
 * If the file does not exist, is empty, or is corrupted, it initializes a fresh state object.
 * Uses a prototype-free cells object to avoid prototype pollution.
 * @returns {Object} The spreadsheet state containing a 'cells' object.
 */
/**
 * Helper to define the cells proxy on a spreadsheet state object.
 * Maps 'cells' getter/setter to the first visible sheet in sheetOrder.
 * @param {Object} state - The state object to modify.
 * @returns {Object} The modified state object.
 */
const setupCellsProxy = (state) => {
  Object.defineProperty(state, 'cells', {
    get() {
      const firstSheet = this.sheetOrder.find(s => !this.hiddenSheets.includes(s)) || 'Sheet1';
      return this.sheets[firstSheet] || this.sheets['Sheet1'];
    },
    set(val) {
      const firstSheet = this.sheetOrder.find(s => !this.hiddenSheets.includes(s)) || 'Sheet1';
      this.sheets[firstSheet] = val;
    },
    configurable: true,
    enumerable: false
  });
  return state;
};

/**
 * Loads the spreadsheet cell state from the store.json file.
 * If the file does not exist, is empty, or is corrupted, it initializes a fresh state object.
 * Uses a prototype-free cells object to avoid prototype pollution.
 * @returns {Promise<Object>} The spreadsheet state containing a 'cells' object.
 */
const loadState = async (key = 'default') => {
  try {
    const stored = await workbookRepo.getWorkbookState(key);
    if (stored !== undefined) {
      let parsed = stored;
      if (typeof parsed === 'string') {
        parsed = JSON.parse(parsed);
      }
      const sheets = Object.create(null);
      
      // Load sheets if present in the stored state.
      if (parsed && parsed.sheets) {
        for (const [sheetName, cellMap] of Object.entries(parsed.sheets)) {
          if (cellMap && typeof cellMap === 'object') {
            // Ensure each sheet's cell map is prototype-free to prevent prototype pollution.
            sheets[sheetName] = Object.assign(Object.create(null), cellMap);
          }
        }
      } else if (parsed && parsed.cells) {
        // Migrate legacy cells format to Sheet1.
        sheets['Sheet1'] = Object.assign(Object.create(null), parsed.cells);
      }
      
      // Ensure at least one sheet exists (new files start with a single sheet;
      // additional sheets are created on demand). Don't force a second sheet —
      // doing so re-created Sheet2 on every load.
      if (Object.keys(sheets).length === 0) sheets['Sheet1'] = Object.create(null);

      // Initialize/migrate sheetOrder, sheetColors, and hiddenSheets
      const sheetOrder = (parsed && Array.isArray(parsed.sheetOrder) && parsed.sheetOrder.length)
        ? parsed.sheetOrder
        : Object.keys(sheets);
      // Make sure every existing sheet is represented in the order array.
      for (const name of Object.keys(sheets)) {
        if (!sheetOrder.includes(name)) sheetOrder.push(name);
      }
      
      const sheetColors = (parsed && parsed.sheetColors && typeof parsed.sheetColors === 'object') ? parsed.sheetColors : Object.create(null);
      const hiddenSheets = (parsed && Array.isArray(parsed.hiddenSheets)) ? parsed.hiddenSheets : [];

      // Per-sheet column widths / row heights / column counts (added later; absent
      // on legacy docs).
      const colWidths = sanitizeDimensionMap(parsed && parsed.colWidths);
      const rowHeights = sanitizeDimensionMap(parsed && parsed.rowHeights);
      const colCounts = sanitizeColCounts(parsed && parsed.colCounts);
      const rowCounts = sanitizeRowCounts(parsed && parsed.rowCounts);
      const hiddenCols = sanitizeHiddenCols(parsed && parsed.hiddenCols);

      const state = { sheets, sheetOrder, sheetColors, hiddenSheets, colWidths, rowHeights, colCounts, rowCounts, hiddenCols };
      // Define a getter/setter proxy for legacy 'cells' compatibility pointing to the first visible sheet
      return setupCellsProxy(state);
    }
  } catch (e) {
    logger.error({ err: e }, 'Error loading state from PostgreSQL, returning default');
  }
  
  // Return fresh state if absent or query fails.
  const freshSheets = Object.create(null);
  freshSheets['Sheet1'] = Object.create(null);
  const freshState = {
    sheets: freshSheets,
    sheetOrder: ['Sheet1'],
    sheetColors: Object.create(null),
    hiddenSheets: [],
    colWidths: Object.create(null),
    rowHeights: Object.create(null),
    colCounts: Object.create(null),
    rowCounts: Object.create(null),
    hiddenCols: Object.create(null)
  };
  // Define getter/setter proxy on the fresh state object pointing to first visible sheet (Sheet1).
  return setupCellsProxy(freshState);
};

/**
 * Deep-sanitize a persisted per-sheet dimension map ({ [sheet]: { [key]: px } }).
 * Returns a prototype-free copy keeping only finite-number sizes, dropping any
 * `__proto__`/inherited keys so a tampered document can't pollute prototypes.
 * @param {*} raw
 * @returns {Object}
 */
const sanitizeDimensionMap = (raw) => {
  const out = Object.create(null);
  if (!raw || typeof raw !== 'object') return out;
  for (const [sheetName, sizes] of Object.entries(raw)) {
    if (sheetName === '__proto__' || !sizes || typeof sizes !== 'object') continue;
    const bucket = Object.create(null);
    for (const [key, val] of Object.entries(sizes)) {
      if (key === '__proto__') continue;
      if (typeof val === 'number' && Number.isFinite(val)) bucket[key] = val;
    }
    out[sheetName] = bucket;
  }
  return out;
};

/**
 * Sanitize a persisted per-sheet column-count map ({ [sheet]: number }). Returns
 * a prototype-free copy keeping only integer counts above the default and within
 * the grid's range, dropping `__proto__`/inherited keys.
 * @param {*} raw
 * @returns {Object}
 */
const sanitizeColCounts = (raw) => {
  const out = Object.create(null);
  if (!raw || typeof raw !== 'object') return out;
  for (const [sheetName, count] of Object.entries(raw)) {
    if (sheetName === '__proto__') continue;
    const n = Number(count);
    if (Number.isInteger(n) && n > dimensionService.DEFAULT_COLS && n <= dimensionService.MAX_COLS) {
      out[sheetName] = n;
    }
  }
  return out;
};

/**
 * The 1-based row number in an A1-style cell reference, or 0 if it isn't one.
 * Used by the xlsx import to learn how far down a sheet reaches while it is
 * already walking every cell.
 * @param {string} ref
 * @returns {number}
 */
const rowOfCellRef = (ref) => {
  const m = /^[A-Z]{1,2}([1-9][0-9]*)$/.exec(ref);
  return m ? Number(m[1]) : 0;
};

/**
 * Sanitize a persisted per-sheet row-count map ({ [sheet]: number }). Returns a
 * prototype-free copy keeping only integer counts above the default and within the
 * grid's range, dropping `__proto__`/inherited keys. Mirrors sanitizeColCounts.
 * @param {*} raw
 * @returns {Object}
 */
const sanitizeRowCounts = (raw) => {
  const out = Object.create(null);
  if (!raw || typeof raw !== 'object') return out;
  for (const [sheetName, count] of Object.entries(raw)) {
    if (sheetName === '__proto__') continue;
    const n = Number(count);
    if (Number.isInteger(n) && n > dimensionService.DEFAULT_ROWS && n <= dimensionService.MAX_ROWS) {
      out[sheetName] = n;
    }
  }
  return out;
};

/**
 * Sanitize a persisted per-sheet hidden-column map ({ [sheet]: string[] }).
 * Returns a prototype-free copy keeping only valid, de-duplicated column-letter
 * keys (A … ZZ), dropping `__proto__`/inherited keys and empty lists.
 * @param {*} raw
 * @returns {Object}
 */
const sanitizeHiddenCols = (raw) => {
  const out = Object.create(null);
  if (!raw || typeof raw !== 'object') return out;
  for (const [sheetName, cols] of Object.entries(raw)) {
    if (sheetName === '__proto__' || !Array.isArray(cols)) continue;
    const seen = new Set();
    const clean = [];
    for (const c of cols) {
      if (typeof c === 'string' && /^[A-Z]{1,2}$/.test(c) && !seen.has(c)) {
        seen.add(c);
        clean.push(c);
      }
    }
    if (clean.length) out[sheetName] = clean;
  }
  return out;
};

// Initialize the in-memory sheetState to null, to be populated on boot.
let sheetState = null;

// In-memory cache of non-default workbooks, keyed by file id. The 'default'
// workbook always lives in the global `sheetState` binding (so existing
// single-document behavior and tests are untouched).
//
// Entries are evicted once a file is idle — see sweepIdleWorkbooks. A cached
// workbook is not small (~4 MB of heap for 25,000 cells) and every route that
// touches a file caches it, download included, so without eviction an instance
// accumulates every file it has ever served for the life of the process (#247).
const workbooks = new Map();

// When each cached workbook was last handed to a caller by getWorkbook (i.e. last
// attached to a connection or a request), so the sweep can tell a file nobody is
// using from one between two operations. Keyed like `workbooks` and kept in step
// with it.
/** @type {Map<string, number>} */
const workbookLastUse = new Map();

/**
 * Cache a workbook under its file id and mark it in use now.
 * @param {string} fileId
 * @param {Object} state
 * @returns {Object} The state, so call sites can cache and use in one expression.
 */
const cacheWorkbook = (fileId, state) => {
  workbooks.set(fileId, state);
  workbookLastUse.set(fileId, Date.now());
  return state;
};

/**
 * Drop a workbook from this instance's cache. Safe by construction: every op
 * persists, `resolveCachedWorkbook` already returns null for a file this instance
 * is not serving (the replica path skips those ops), and the next connection
 * re-loads the file from Postgres.
 * @param {string} fileId
 */
const uncacheWorkbook = (fileId) => {
  workbooks.delete(fileId);
  workbookLastUse.delete(fileId);
};

// Accessor for the live default workbook binding, so callers that shadow the
// `sheetState` name locally can still reach the current global (which may be
// swapped out by a version restore).
const getDefaultState = () => sheetState;

// A file id is either the legacy 'default' workbook or a 24-char hex token
// minted by POST /api/files. Used to validate untrusted ?file= input.
const isValidFileId = (id) => id === 'default' || /^[a-f0-9]{24}$/.test(id);

/**
 * Express middleware factory that gates a `/api/files/:id/...` route on file
 * access. It validates the `:id` (optionally rejecting the shared 'default'
 * workbook) and then delegates to the same authorization helpers used elsewhere —
 * canViewFile for 'view' level, canModifyFile for 'edit'. On success the validated
 * id is stashed on `req.fileId`. This centralizes the id-validation + access check
 * that each file route previously repeated inline.
 *
 * @param {{ level: 'view'|'edit', param?: string, allowDefault?: boolean, forbiddenMessage: string }} opts
 * @returns {import('express').RequestHandler}
 */
const requireFileAccess = ({ level, param = 'id', allowDefault = true, forbiddenMessage }) => async (req, res, next) => {
  const fileId = req.params[param];
  if (!isValidFileId(fileId) || (!allowDefault && fileId === 'default')) {
    return res.status(400).json({ error: 'bad_request', message: 'Invalid file id' });
  }
  try {
    const allowed = level === 'edit'
      ? await canModifyFile(req.user, fileId)
      : await canViewFile(req.user, fileId);
    if (!allowed) {
      return res.status(403).json({ error: 'forbidden', message: forbiddenMessage });
    }
  } catch (err) {
    logger.error({ err: err }, 'Error checking file access');
    return res.status(500).json({ error: 'internal_server_error', message: 'Failed to check file access' });
  }
  req.fileId = fileId;
  next();
};

/**
 * Resolve the live workbook state object for a given file id, lazily loading and
 * caching non-default workbooks. Returns `sheetState` for the default workbook so
 * callers always observe the latest global state (e.g. after a version restore).
 * @param {string} fileId
 * @returns {Promise<Object>} The workbook state ({ sheets, sheetOrder, ... }).
 */
const getWorkbook = async (fileId) => {
  if (!fileId || fileId === 'default') return sheetState;
  // Every hand-out marks the file in use, so a request served while nobody holds a
  // socket on it still keeps the entry out of the sweep's reach for a window.
  if (workbooks.has(fileId)) {
    workbookLastUse.set(fileId, Date.now());
    return workbooks.get(fileId);
  }
  return cacheWorkbook(fileId, await loadState(fileId));
};

/**
 * Serialize and write a workbook's CURRENT state to its own key in
 * workbook_state. Reads the live object at call time rather than taking a
 * snapshot from the caller, which is what lets a coalesced trailing write cover
 * everything that landed while the previous write was in flight — including a
 * version restore, which swaps the object out entirely.
 * @param {string} key 'default' or a file id.
 * @returns {Promise<void>}
 */
const writeWorkbookNow = async (key) => {
  const state = key === 'default' ? getDefaultState() : workbooks.get(key);
  if (!state) return; // not loaded / not served on this instance
  if (key === 'default') {
    await workbookRepo.updateDefaultWorkbookState(JSON.stringify(state));
  } else {
    await workbookRepo.updateWorkbookState(JSON.stringify(state), key);
  }
};

// Every state-changing op persists the whole workbook, so a bulk edit — one
// message per cell today — used to queue one full serialization and one UPDATE
// per cell, of a document the burst was itself growing, on the event loop and
// against a bounded pool. Coalescing keeps that at ~2 writes per burst. The
// default workbook had a hand-rolled version of this latch and every real user
// file had none; both now go through the same path.
//
// Coalescing bounds how many writes a key has AT ONCE, not how many it has per
// second: the trailing write used to start the instant the previous one settled,
// so a file under sustained editing was written as fast as Postgres would answer —
// ~1.58 MB and ~6 ms of JSON.stringify per round trip for a 25,000-cell workbook,
// all of it queued against PG_POOL_MAX. The floor makes that a bounded write RATE
// (#248).
const WORKBOOK_WRITE_MIN_INTERVAL_MS = parseInt(process.env.WORKBOOK_WRITE_MIN_INTERVAL_MS || '250', 10);
const workbookWriter = createWriteCoalescer(writeWorkbookNow, (err, key) => {
  logger.error({ err }, `Failed to save workbook ${key}`);
}, { minIntervalMs: WORKBOOK_WRITE_MIN_INTERVAL_MS });

/**
 * Persist whichever workbook a file id refers to (default vs. a cached file),
 * coalescing against any write already in flight for it.
 * @param {string} fileId
 * @returns {Promise<void>} Settles once a write including the caller's change has
 *   completed, so a caller that needs durability before proceeding can await it.
 */
const persistWorkbook = (fileId) =>
  workbookWriter.schedule((!fileId || fileId === 'default') ? 'default' : fileId);

/**
 * GET /api/files
 * Lists all files in the management interface, newest first.
 * Protected with ensureAuthenticated middleware.
 */
app.get('/api/files', ensureAuthenticated, async (req, res) => {
  try {
    const selfId = userIdentity(req.user);
    const role = await getUserRole(req.user);
    const isAdmin = role === 'admin' || role === 'superadmin';
    // A user sees the shared legacy 'default' workbook, the files they own and the
    // files explicitly shared with them; an admin sees everything. That rule is the
    // query's WHERE clause rather than a filter over every file in the system, so
    // the cost of one drive load follows the requester's own data — and rows they
    // have no right to see are never read in the first place. Admins genuinely want
    // the unfiltered listing, so they get it.
    // The listing, the share roles and the starred set are three independent reads
    // of the requester's own data, so they go together rather than one after
    // another: one round trip for the drive instead of three.
    //
    // Each row also carries `owner` and `canModify` (owner / admin / default) so the
    // UI can show/hide edit affordances; the server enforces the same rules. The
    // share roles are still needed per row for that, beyond deciding visibility.
    // Per-user starred set, so each row can carry whether the viewer has starred it.
    const [visible, sharedRoles, starredIds] = await Promise.all([
      isAdmin ? filesRepo.listFiles() : filesRepo.listVisibleFiles(selfId),
      isAdmin ? Promise.resolve(new Map()) : getSharedRoleMap(selfId),
      getStarredFileIds(selfId)
    ]);
    res.json(visible.map(r => {
      const isCreator = !!(selfId && r.created_by && r.created_by === selfId);
      // 'system' is a sentinel for the seeded legacy 'default' workbook, not a real
      // user. Don't expose it as a creator name; flag it so the UI can show a
      // friendly "Shared sample" label instead.
      const systemOwner = r.created_by === 'system';
      const sharedRole = sharedRoles.get(r.id) || null; // 'owner' | 'editor' | 'viewer' | null
      // A file may have multiple owners: the creator plus anyone granted the 'owner'
      // share role. Owners (and editors) can modify; owners can also manage sharing.
      const owner = isCreator || sharedRole === 'owner';
      const canModify = r.id === 'default' || isAdmin || owner || sharedRole === 'editor';
      return {
        id: r.id,
        name: r.name,
        created_at: r.created_at,
        created_by: systemOwner ? null : r.created_by,
        owner,
        systemOwner,
        // The viewer's own access level on this file, for UI affordances.
        role: owner ? 'owner' : (sharedRole || (canModify ? 'editor' : 'viewer')),
        // General (link-based) access mode, for the Share dialog's "General access".
        linkAccess: r.link_access === 'anyone' ? 'anyone' : 'restricted',
        shared: !isCreator && r.id !== 'default',
        // Whether the signed-in user has starred this file (drives the Starred view).
        starred: starredIds.has(r.id),
        canModify
      };
    }));
  } catch (err) {
    logger.error({ err: err }, 'Error listing files');
    res.status(500).json({ error: 'internal_server_error', message: 'Failed to list files' });
  }
});

/**
 * POST /api/files
 * Creates a new empty workbook, mints a unique id, and returns a shareable URL.
 * Body: { name?: string, lang?: string }. `lang` is the creator's UI language and
 * only decides the localized name of the single starter sheet. Protected with
 * ensureAuthenticated middleware.
 */
app.post('/api/files', ensureAuthenticated, async (req, res) => {
  try {
    let name = (req.body && typeof req.body.name === 'string') ? req.body.name.trim() : '';
    if (!name) name = 'Untitled spreadsheet';
    if (name.length > 120) name = name.slice(0, 120);

    // Name the starter sheet in the creator's UI language: Chinese "工作表1",
    // else the legacy "Sheet1". This mirrors the client's add-sheet naming so a
    // workbook's first and later sheets read consistently. Localization is opt-in
    // via an explicit `lang: 'zh'`; any other/absent value keeps "Sheet1" so
    // callers that don't send a language stay backward-compatible.
    const firstSheetName = (req.body && req.body.lang === 'zh') ? '工作表1' : 'Sheet1';

    // The creator (owner) is identified by their stable identity key.
    const creator = userIdentity(req.user) || 'anonymous';

    // Enforce the per-role file quota (user: 1, admin: 5, super admin: unlimited).
    // The shared legacy 'default' workbook is system-owned and never counts.
    if (await wouldExceedFileQuota(req.user, creator)) {
      return res.status(403).json({
        error: 'file_limit',
        message: 'You have reached your file limit. Ask an admin for more.'
      });
    }

    // Mint a unique, URL-safe file id.
    const id = crypto.randomBytes(12).toString('hex');

    // Initialize a fresh, prototype-free workbook for this file. A new file starts
    // with a single sheet; users add more via the add-sheet control.
    const freshSheets = Object.create(null);
    freshSheets[firstSheetName] = Object.create(null);
    const freshState = {
      sheets: freshSheets,
      sheetOrder: [firstSheetName],
      sheetColors: Object.create(null),
      hiddenSheets: [],
      colWidths: Object.create(null),
      rowHeights: Object.create(null),
      colCounts: Object.create(null),
      rowCounts: Object.create(null),
      hiddenCols: Object.create(null)
    };

    await workbookRepo.insertWorkbookState(JSON.stringify(freshState), id);
    await filesRepo.insertFile(id, name, creator);
    cacheWorkbook(id, setupCellsProxy(freshState));

    const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    res.json({ id, name, url: `${baseUrl}/sheet?file=${id}` });
  } catch (err) {
    logger.error({ err: err }, 'Error creating file');
    res.status(500).json({ error: 'internal_server_error', message: 'Failed to create file' });
  }
});

/**
 * POST /api/files/:id/copy
 * Duplicates an existing file the caller can view: clones its workbook_state into
 * a brand-new file owned by the caller and returns a shareable URL.
 * Body: { name?: string, shareCollaborators?: boolean }.
 *  - name              defaults to "<source name> 的副本"-style copy name (built client-side).
 *  - shareCollaborators when true, copies the source file's share grants to the copy.
 * The per-user file quota applies just like POST /api/files. Protected with
 * ensureAuthenticated middleware.
 */
app.post('/api/files/:id/copy', ensureAuthenticated,
  requireFileAccess({ level: 'view', forbiddenMessage: 'You do not have permission to copy this file' }),
  async (req, res) => {
  try {
    const srcId = req.params.id;
    // Resolve the copy's name (fall back to the source name with a generic suffix).
    let name = (req.body && typeof req.body.name === 'string') ? req.body.name.trim() : '';
    if (!name) {
      const srcName = (await filesRepo.getFileName(srcId)) || 'Untitled spreadsheet';
      name = `Copy of ${srcName}`;
    }
    if (name.length > 120) name = name.slice(0, 120);

    const creator = userIdentity(req.user) || 'anonymous';

    // Enforce the same per-role quota as fresh creation (user: 1, admin: 5, super
    // admin: unlimited; the shared 'default' workbook never counts).
    if (await wouldExceedFileQuota(req.user, creator)) {
      return res.status(403).json({
        error: 'file_limit',
        message: 'You have reached your file limit. Ask an admin for more.'
      });
    }

    // Snapshot the source workbook (live in-memory state if loaded, else from the
    // store) and deep-clone only the persisted shape — the non-enumerable `cells`
    // accessor is intentionally dropped.
    const src = await getWorkbook(srcId);
    const clonedState = JSON.parse(JSON.stringify({
      sheets: src.sheets || { Sheet1: {} },
      sheetOrder: src.sheetOrder || ['Sheet1'],
      sheetColors: src.sheetColors || {},
      hiddenSheets: src.hiddenSheets || [],
      colWidths: src.colWidths || {},
      rowHeights: src.rowHeights || {},
      colCounts: src.colCounts || {},
      rowCounts: src.rowCounts || {},
      hiddenCols: src.hiddenCols || {}
    }));

    const id = crypto.randomBytes(12).toString('hex');
    await workbookRepo.insertWorkbookState(JSON.stringify(clonedState), id);
    await filesRepo.insertFile(id, name, creator);
    // Seed the in-memory cache with a prototype-free copy (guards against prototype
    // pollution, mirroring loadState) so the copy is live without a round-trip.
    const cachedSheets = Object.create(null);
    for (const [sheetName, cellMap] of Object.entries(clonedState.sheets)) {
      cachedSheets[sheetName] = Object.assign(Object.create(null), cellMap);
    }
    cacheWorkbook(id, setupCellsProxy({
      sheets: cachedSheets,
      sheetOrder: clonedState.sheetOrder,
      sheetColors: Object.assign(Object.create(null), clonedState.sheetColors),
      hiddenSheets: clonedState.hiddenSheets,
      colWidths: sanitizeDimensionMap(clonedState.colWidths),
      rowHeights: sanitizeDimensionMap(clonedState.rowHeights),
      colCounts: sanitizeColCounts(clonedState.colCounts),
      rowCounts: sanitizeRowCounts(clonedState.rowCounts),
      hiddenCols: sanitizeHiddenCols(clonedState.hiddenCols)
    }));

    // Optionally carry over the source's collaborators (never re-adding the new
    // owner as a share of their own copy).
    if (req.body && req.body.shareCollaborators) {
      try {
        const shares = await sharesRepo.listSharesByFile(srcId);
        for (const s of shares) {
          if (s.user_id && s.user_id !== creator) {
            await sharesRepo.insertShare(id, s.user_id, s.role || 'viewer');
          }
        }
      } catch (e) {
        // Non-fatal: the copy itself succeeded even if share-copying failed.
        logger.error({ err: e }, 'Error copying file shares');
      }
    }

    const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    res.json({ id, name, url: `${baseUrl}/sheet?file=${id}` });
  } catch (err) {
    logger.error({ err: err }, 'Error copying file');
    res.status(500).json({ error: 'internal_server_error', message: 'Failed to copy file' });
  }
});

/**
 * POST /api/files/import
 * Creates a new file from an uploaded .xlsx workbook. The raw file bytes are the
 * request body (Content-Type: application/octet-stream); the display name comes
 * from the `?name=` query. Imports cell values, formulas, formatting and sheet
 * structure (see services/xlsx-import.js). A formula's cached result is kept as the
 * cell value so it still shows when the client can't evaluate the formula itself.
 * The per-role file quota
 * is enforced *before* parsing, so an over-quota user gets a clean 403 without the
 * upload being processed. Protected with ensureAuthenticated middleware.
 */
app.post('/api/files/import',
  express.raw({ type: () => true, limit: '15mb' }),
  ensureAuthenticated,
  async (req, res) => {
  try {
    const creator = userIdentity(req.user) || 'anonymous';

    // Quota check first: reject before spending any work on a large upload.
    if (await wouldExceedFileQuota(req.user, creator)) {
      return res.status(403).json({
        error: 'file_limit',
        message: 'You have reached your file limit. Ask an admin for more.'
      });
    }

    const buf = Buffer.isBuffer(req.body) ? req.body : null;
    if (!buf || buf.length === 0) {
      return res.status(400).json({ error: 'empty', message: 'No file was uploaded.' });
    }

    let name = (req.query && typeof req.query.name === 'string') ? req.query.name.trim() : '';
    if (!name) name = 'Imported spreadsheet';
    if (name.length > 120) name = name.slice(0, 120);

    // Parse the workbook. Parser errors carry a `code` we surface to the client so
    // it can show the right localized warning.
    let parsed;
    try {
      parsed = parseXlsx(buf);
    } catch (e) {
      const code = (e && e.code) || 'corrupt';
      return res.status(400).json({ error: code, message: 'Could not import this file.' });
    }

    // Turn the parsed sheets into a co-sheet workbook state. The parser already
    // produces co-sheet's cell shape ({ formula, value, style }) and per-sheet
    // track sizes / tab colors. Filters are browser-local view state (localStorage,
    // never persisted in the document), so we hand them back to the client to seed.
    const sheets = Object.create(null);
    const sheetOrder = [];
    const sheetColors = Object.create(null);
    const colWidths = Object.create(null);
    const rowHeights = Object.create(null);
    const rowCounts = Object.create(null);
    const filters = Object.create(null);
    let totalCells = 0;
    for (const s of parsed.sheets) {
      const cellMap = Object.create(null);
      // Track how far down the sheet reaches while we are already walking every
      // cell. Rows, unlike columns, need this recorded: getColCount() raises itself
      // to the rightmost populated column, but getRowCount() has no data-derived
      // floor (it is read inside per-row render loops), so a sheet taller than the
      // default has to say so or its extra rows never render (#230).
      let maxRow = 0;
      for (const [ref, cell] of Object.entries(s.cells)) {
        cellMap[ref] = { formula: cell.formula || '', value: cell.value || '', style: cell.style || {} };
        const row = rowOfCellRef(ref);
        if (row > maxRow) maxRow = row;
        totalCells++;
      }
      if (maxRow > dimensionService.DEFAULT_ROWS) rowCounts[s.name] = maxRow;
      sheets[s.name] = cellMap;
      sheetOrder.push(s.name);
      if (s.tabColor) sheetColors[s.name] = s.tabColor;
      if (s.colWidths && Object.keys(s.colWidths).length) colWidths[s.name] = s.colWidths;
      if (s.rowHeights && Object.keys(s.rowHeights).length) rowHeights[s.name] = s.rowHeights;
      if (s.filter) filters[s.name] = s.filter;
    }
    // A workbook with no sheets at all is unusable; fall back to a single blank one.
    if (sheetOrder.length === 0) {
      sheets['Sheet1'] = Object.create(null);
      sheetOrder.push('Sheet1');
    }

    const freshState = {
      sheets,
      sheetOrder,
      sheetColors,
      hiddenSheets: [],
      colWidths: sanitizeDimensionMap(colWidths),
      rowHeights: sanitizeDimensionMap(rowHeights),
      // Imported columns past Z render via the client's data-derived floor; no
      // explicit blank-column growth to carry over.
      colCounts: Object.create(null),
      // Rows have no such floor, so an import that reached past the default row
      // count carries the extent it reached (see the loop above).
      rowCounts: sanitizeRowCounts(rowCounts),
      // Imported workbooks start with no hidden columns.
      hiddenCols: Object.create(null)
    };

    const id = crypto.randomBytes(12).toString('hex');
    await workbookRepo.insertWorkbookState(JSON.stringify(freshState), id);
    await filesRepo.insertFile(id, name, creator);
    cacheWorkbook(id, setupCellsProxy(freshState));

    logger.info({ fileId: id, sheets: sheetOrder.length, cells: totalCells }, 'Imported xlsx workbook');
    const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    // `filters` is only non-empty when the workbook had auto-filters; the client
    // seeds them into localStorage for the new file before opening it.
    res.json({ id, name, url: `${baseUrl}/sheet?file=${id}`, filters });
  } catch (err) {
    logger.error({ err: err }, 'Error importing file');
    res.status(500).json({ error: 'internal_server_error', message: 'Failed to import file' });
  }
});

/**
 * GET /api/files/:id/details
 * Returns metadata for the file-details dialog: name, owner, created and last-modified
 * timestamps. The caller must be able to view the file. Protected with
 * ensureAuthenticated middleware.
 */
app.get('/api/files/:id/details', ensureAuthenticated,
  requireFileAccess({ level: 'view', forbiddenMessage: 'You do not have permission to view this file' }),
  async (req, res) => {
  try {
    const id = req.params.id;
    const row = await filesRepo.getFileRow(id);
    if (!row) {
      return res.status(404).json({ error: 'not_found', message: 'File not found' });
    }
    const updatedAt = (await workbookRepo.getWorkbookUpdatedAt(id)) || row.created_at || null;
    const selfId = userIdentity(req.user);
    const ownerIsSelf = !!(selfId && row.created_by && row.created_by === selfId);
    const systemOwner = row.created_by === 'system';
    res.json({
      id,
      name: row.name,
      owner: systemOwner ? null : (row.created_by || null),
      ownerIsSelf,
      createdAt: row.created_at || null,
      updatedAt
    });
  } catch (err) {
    logger.error({ err: err }, 'Error reading file details');
    res.status(500).json({ error: 'internal_server_error', message: 'Failed to read file details' });
  }
});

/**
 * GET /api/files/:id/workbook
 * Returns the full workbook (name + ordered sheets, each a map of cells) so the
 * drive page can build an .xlsx for download client-side using the shared exporter.
 * Each cell's stored `value` already holds the last evaluated result, so no formula
 * engine is needed here. The caller must be able to view the file.
 */
app.get('/api/files/:id/workbook', ensureAuthenticated,
  requireFileAccess({ level: 'view', forbiddenMessage: 'You do not have permission to download this file' }),
  async (req, res) => {
  try {
    const id = req.params.id;
    const wb = await getWorkbook(id);
    const name = (await filesRepo.getFileName(id)) || 'spreadsheet';
    // Preserve the workbook's own sheet order (fall back to whatever sheets exist).
    const order = (Array.isArray(wb.sheetOrder) && wb.sheetOrder.length)
      ? wb.sheetOrder
      : Object.keys(wb.sheets || {});
    res.json({ name, sheetOrder: order, sheets: wb.sheets || {} });
  } catch (err) {
    logger.error({ err: err }, 'Error reading workbook for download');
    res.status(500).json({ error: 'internal_server_error', message: 'Failed to load workbook' });
  }
});

/**
 * PATCH /api/files/:id
 * Renames a file. Body: { name: string }. Protected with ensureAuthenticated middleware.
 */
app.patch('/api/files/:id', ensureAuthenticated,
  requireFileAccess({ level: 'edit', forbiddenMessage: 'You do not have permission to modify this file' }),
  async (req, res) => {
  try {
    const id = req.params.id;
    const name = (req.body && typeof req.body.name === 'string') ? req.body.name.trim() : '';
    if (!name || name.length > 120) {
      return res.status(400).json({ error: 'bad_request', message: 'name must be 1-120 characters' });
    }
    const result = await filesRepo.renameFile(id, name);
    if (result.rows && result.rows.length === 0 && result.rowCount === 0) {
      // PG UPDATE returns rowCount; the test mock returns rows. Treat empty as not found.
    }
    res.json({ success: true, id, name });
  } catch (err) {
    logger.error({ err: err }, 'Error renaming file');
    res.status(500).json({ error: 'internal_server_error', message: 'Failed to rename file' });
  }
});

/**
 * DELETE /api/files/:id
 * Deletes a file and its workbook data. The legacy 'default' file cannot be deleted.
 * Protected with ensureAuthenticated middleware.
 */
app.delete('/api/files/:id', ensureAuthenticated,
  requireFileAccess({ level: 'edit', forbiddenMessage: 'You do not have permission to delete this file' }),
  async (req, res) => {
  try {
    const id = req.params.id;
    await filesRepo.deleteFile(id);
    await workbookRepo.deleteWorkbookState(id);
    await sharesRepo.deleteSharesByFile(id);
    await starsRepo.deleteStarsByFile(id);
    // Forget the file everywhere this process tracks it, not just in the workbook
    // cache: a leftover autosave entry would send the engine to snapshot a file
    // that no longer exists, re-loading it from a row that has just been deleted.
    uncacheWorkbook(id);
    autosaveByFile.delete(id);
    workbookWriter.forget(id);
    res.json({ success: true });
  } catch (err) {
    logger.error({ err: err }, 'Error deleting file');
    res.status(500).json({ error: 'internal_server_error', message: 'Failed to delete file' });
  }
});

/**
 * GET /api/users/search?q=&file=<id>
 * Searches signed-in users so a file's owner (or an admin) can share with them.
 * Requires modify permission on the target file. Excludes the owner/sharer and
 * users who already have access; returns a short list of { id, username, email }.
 */
app.get('/api/users/search', ensureAuthenticated, async (req, res) => {
  try {
    const fileId = req.query.file;
    if (!fileId || !isValidFileId(fileId) || fileId === 'default') {
      return res.status(400).json({ error: 'bad_request', message: 'A valid non-default file is required' });
    }
    if (!(await canModifyFile(req.user, fileId))) {
      return res.status(403).json({ error: 'forbidden', message: 'You do not have permission to share this file' });
    }
    const q = String(req.query.q || '').trim().toLowerCase();
    const selfId = userIdentity(req.user);
    const owner = await getFileOwner(fileId);
    const alreadyShared = new Set(await getSharedUserIds(fileId));
    const all = await usersRepo.listUsersForSearch();
    const matches = all
      .filter((u) => {
        if (!u.id || u.id === selfId || u.id === owner) return false;
        if (alreadyShared.has(u.id)) return false;
        if (!q) return true;
        return `${u.username || ''} ${u.email || ''} ${u.id}`.toLowerCase().includes(q);
      })
      .slice(0, 10)
      .map((u) => ({ id: u.id, username: u.username, email: u.email }));
    res.json(matches);
  } catch (err) {
    logger.error({ err: err }, 'Error searching users');
    res.status(500).json({ error: 'internal_server_error', message: 'Failed to search users' });
  }
});

/**
 * GET /api/files/:id/shares
 * Lists the users a file is shared with. Requires modify permission on the file.
 */
app.get('/api/files/:id/shares', ensureAuthenticated,
  requireFileAccess({ level: 'edit', allowDefault: false, forbiddenMessage: 'You do not have permission to view shares' }),
  async (req, res) => {
  try {
    const id = req.params.id;
    const shareRows = await sharesRepo.listSharesByFile(id);
    let users = [];
    if (shareRows.length) {
      const all = await usersRepo.listUsersBasic();
      const byId = new Map(all.map((u) => [u.id, u]));
      users = shareRows.map((s) => {
        const u = byId.get(s.user_id) || {};
        return { id: s.user_id, username: u.username || s.user_id, email: u.email || null, role: s.role || 'viewer' };
      });
    }
    res.json(users);
  } catch (err) {
    logger.error({ err: err }, 'Error listing shares');
    res.status(500).json({ error: 'internal_server_error', message: 'Failed to list shares' });
  }
});

/**
 * POST /api/files/:id/shares  { userIds: string[] }
 * Shares a file with one or more existing users (view access). Requires modify
 * permission on the file. Unknown ids and the owner/sharer are skipped.
 */
app.post('/api/files/:id/shares', ensureAuthenticated,
  requireFileAccess({ level: 'edit', allowDefault: false, forbiddenMessage: 'You do not have permission to share this file' }),
  async (req, res) => {
  try {
    const id = req.params.id;
    const userIds = (req.body && Array.isArray(req.body.userIds)) ? req.body.userIds : [];
    const cleaned = userIds.map((u) => String(u || '').trim().toLowerCase()).filter(Boolean);
    if (cleaned.length === 0) {
      return res.status(400).json({ error: 'bad_request', message: 'userIds must be a non-empty array' });
    }
    // New shares default to 'editor' (can modify); the sharer may request 'viewer'.
    const role = req.body && req.body.role === 'viewer' ? 'viewer' : 'editor';
    const owner = await getFileOwner(id);
    const selfId = userIdentity(req.user);
    const all = await usersRepo.listUserIds();
    const known = new Set(all.map((u) => u.id));
    let added = 0;
    for (const uid of cleaned) {
      if (uid === owner || uid === selfId || !known.has(uid)) continue;
      await sharesRepo.upsertShare(id, uid, role);
      added++;
    }
    res.json({ success: true, added, role });
  } catch (err) {
    logger.error({ err: err }, 'Error sharing file');
    res.status(500).json({ error: 'internal_server_error', message: 'Failed to share file' });
  }
});

/**
 * PATCH /api/files/:id/shares/:userId  { role: 'owner' | 'editor' | 'viewer' }
 * Changes an existing collaborator's role. 'owner' grants co-ownership (a file may
 * have multiple owners). Requires modify permission on the file.
 */
app.patch('/api/files/:id/shares/:userId', ensureAuthenticated,
  requireFileAccess({ level: 'edit', allowDefault: false, forbiddenMessage: 'You do not have permission to change shares' }),
  async (req, res) => {
  try {
    const id = req.params.id;
    const role = ['owner', 'editor', 'viewer'].includes(req.body && req.body.role) ? req.body.role : null;
    if (!role) {
      return res.status(400).json({ error: 'bad_request', message: "role must be 'owner', 'editor', or 'viewer'" });
    }
    const userId = String(req.params.userId || '').trim().toLowerCase();
    const result = await sharesRepo.updateShareRole(id, userId, role);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'not_found', message: 'Share not found' });
    }
    res.json({ success: true, role });
  } catch (err) {
    logger.error({ err: err }, 'Error updating share');
    res.status(500).json({ error: 'internal_server_error', message: 'Failed to update share' });
  }
});

/**
 * DELETE /api/files/:id/shares/:userId
 * Revokes a collaborator's access. Requires modify permission on the file.
 */
app.delete('/api/files/:id/shares/:userId', ensureAuthenticated,
  requireFileAccess({ level: 'edit', allowDefault: false, forbiddenMessage: 'You do not have permission to change shares' }),
  async (req, res) => {
  try {
    const id = req.params.id;
    const userId = String(req.params.userId || '').trim().toLowerCase();
    await sharesRepo.deleteShare(id, userId);
    res.json({ success: true });
  } catch (err) {
    logger.error({ err: err }, 'Error removing share');
    res.status(500).json({ error: 'internal_server_error', message: 'Failed to remove share' });
  }
});

/**
 * PATCH /api/files/:id/access  { linkAccess: 'restricted' | 'anyone' }
 * Sets a file's general (link-based) access mode. 'anyone' lets any signed-in user
 * with the link open it view-only; 'restricted' limits it to owner(s)/admins/shared
 * users. Requires modify permission on the file.
 */
app.patch('/api/files/:id/access', ensureAuthenticated,
  requireFileAccess({ level: 'edit', allowDefault: false, forbiddenMessage: 'You do not have permission to change access' }),
  async (req, res) => {
  try {
    const id = req.params.id;
    const linkAccess = ['restricted', 'anyone'].includes(req.body && req.body.linkAccess) ? req.body.linkAccess : null;
    if (!linkAccess) {
      return res.status(400).json({ error: 'bad_request', message: "linkAccess must be 'restricted' or 'anyone'" });
    }
    await filesRepo.updateFileLinkAccess(id, linkAccess);
    res.json({ success: true, linkAccess });
  } catch (err) {
    logger.error({ err: err }, 'Error updating file access');
    res.status(500).json({ error: 'internal_server_error', message: 'Failed to update access' });
  }
});

/**
 * PUT /api/files/:id/star  { starred: boolean }
 * Adds or removes the file from the signed-in user's Starred list. Starring is a
 * personal, per-user favourite, so it only requires view access to the file (any
 * file the user can open, including the shared 'default' workbook).
 */
app.put('/api/files/:id/star', ensureAuthenticated,
  requireFileAccess({ level: 'view', forbiddenMessage: 'You do not have access to this file' }),
  async (req, res) => {
  try {
    const id = req.params.id;
    const userId = userIdentity(req.user);
    if (!userId) {
      return res.status(403).json({ error: 'forbidden', message: 'No user identity' });
    }
    const starred = !!(req.body && req.body.starred);
    if (starred) {
      await starsRepo.addStar(id, userId);
    } else {
      await starsRepo.removeStar(id, userId);
    }
    res.json({ success: true, starred });
  } catch (err) {
    logger.error({ err: err }, 'Error updating star');
    res.status(500).json({ error: 'internal_server_error', message: 'Failed to update star' });
  }
});

/**
 * GET /api/cells
 * Returns the current spreadsheet cell state.
 * Protected with ensureAuthenticated middleware.
 */
app.get('/api/cells', ensureAuthenticated, async (req, res) => {
  const fileId = (req.query.file && isValidFileId(req.query.file)) ? req.query.file : 'default';
  // Reads are gated by general access: restricted files are only readable by the
  // owner(s)/admins/shared users; 'anyone' makes them readable by any signed-in user.
  if (!(await canViewFile(req.user, fileId))) {
    return res.status(403).json({ error: 'forbidden', message: 'You do not have access to this file' });
  }
  const wb = await getWorkbook(fileId);
  res.json(wb.cells || {});
});

/**
 * POST /api/cells
 * Updates or sets a cell state and triggers persistence.
 * Protected with ensureAuthenticated middleware.
 * Includes validation for cellId structure and guards against prototype pollution.
 */
app.post('/api/cells', ensureAuthenticated, async (req, res) => {
  const { cellId, formula, value, style } = req.body;

  // Validate up front so an invalid payload is rejected (400) before the access
  // check, preserving the existing response ordering.
  const validation = cellService.validateCellPayload(cellId, formula, value, style);
  if (!validation.valid) {
    return res.status(400).json({ error: 'bad_request', message: validation.message });
  }

  const fileId = (req.query.file && isValidFileId(req.query.file))
    ? req.query.file
    : ((req.body.file && isValidFileId(req.body.file)) ? req.body.file : 'default');

  // The owner, admins/super admins, and users shared as 'editor' may edit a file
  // (the shared 'default' workbook is exempt). Reads are unrestricted; writes are
  // gated here. Viewers are rejected.
  if (!(await canModifyFile(req.user, fileId))) {
    return res.status(403).json({ error: 'forbidden', message: 'You do not have permission to edit this file' });
  }

  const wb = await getWorkbook(fileId);
  // No sheetName → writes through the workbook's `cells` accessor (first visible sheet).
  cellService.writeCellValue(wb, { cellId, formula, value, style });
  persistWorkbook(fileId);
  res.json({ success: true, cells: wb.cells });
});

/**
 * GET /api/versions
 * Retrieves version history metadata for a workbook, newest first, bounded by
 * versionsRepo.VERSION_LIST_LIMIT. Only returns id, created_at, and created_by.
 * Protected with ensureAuthenticated middleware.
 */
app.get('/api/versions', ensureAuthenticated, async (req, res) => {
  try {
    // Scope to the requested workbook (?file=<id>); absent/invalid => the legacy
    // 'default' workbook. The caller must be able to view that file.
    const fileId = (typeof req.query.file === 'string' && isValidFileId(req.query.file)) ? req.query.file : 'default';
    if (!(await canViewFile(req.user, fileId))) {
      return res.status(403).json({ error: 'forbidden', message: 'You do not have permission to view this file' });
    }
    const rows = await versionsRepo.listVersions(fileId);
    const versions = rows.map(row => ({
      id: row.id,
      created_at: row.created_at,
      created_by: row.created_by
    }));
    res.json(versions);
  } catch (err) {
    logger.error({ err: err }, 'Error fetching version history list');
    res.status(500).json({ error: 'internal_server_error', message: 'Failed to retrieve versions list' });
  }
});

/**
 * GET /api/versions/:id
 * Retrieves the full spreadsheet state snapshot for the specified version ID.
 * Protected with ensureAuthenticated middleware.
 */
app.get('/api/versions/:id', ensureAuthenticated, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ error: 'bad_request', message: 'Invalid version ID' });
    }
    const fileId = (typeof req.query.file === 'string' && isValidFileId(req.query.file)) ? req.query.file : 'default';
    if (!(await canViewFile(req.user, fileId))) {
      return res.status(403).json({ error: 'forbidden', message: 'You do not have permission to view this file' });
    }
    const versionState = await versionsRepo.getVersionState(id, fileId);
    if (versionState === undefined) {
      return res.status(404).json({ error: 'not_found', message: 'Version not found' });
    }

    let parsedState = versionState;
    if (typeof parsedState === 'string') {
      parsedState = JSON.parse(parsedState);
    }
    res.json(parsedState);
  } catch (err) {
    logger.error({ err: err }, 'Error retrieving version snapshot');
    res.status(500).json({ error: 'internal_server_error', message: 'Failed to retrieve version state' });
  }
});

/**
 * POST /api/versions/:id/restore
 * Restores the spreadsheet state to the specified version's snapshot.
 * Overwrites workbook_state, saves it, records a new version indicating the restoration,
 * and broadcasts the WebSocket 'init' state update to all active connected clients.
 * Protected with ensureAuthenticated middleware.
 */
app.post('/api/versions/:id/restore', ensureAuthenticated, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ error: 'bad_request', message: 'Invalid version ID' });
    }
    // Scope to the requested workbook (?file=<id>); restoring is an edit, so the
    // caller must have modify access to that file.
    const fileId = (typeof req.query.file === 'string' && isValidFileId(req.query.file)) ? req.query.file : 'default';
    if (!(await canModifyFile(req.user, fileId))) {
      return res.status(403).json({ error: 'forbidden', message: 'You do not have permission to edit this file' });
    }
    const versionState = await versionsRepo.getVersionState(id, fileId);
    if (versionState === undefined) {
      return res.status(404).json({ error: 'not_found', message: 'Version not found' });
    }

    let targetState = versionState;
    if (typeof targetState === 'string') {
      targetState = JSON.parse(targetState);
    }

    // Safely reconstruct the state mapping to avoid prototype pollution issues
    const sheets = Object.create(null);
    if (targetState.sheets) {
      for (const [sheetName, cellMap] of Object.entries(targetState.sheets)) {
        if (cellMap && typeof cellMap === 'object') {
          sheets[sheetName] = Object.assign(Object.create(null), cellMap);
        }
      }
    }

    // Rebuild the restored workbook state.
    const restored = setupCellsProxy({
      sheets,
      sheetOrder: Array.isArray(targetState.sheetOrder) ? targetState.sheetOrder : Object.keys(sheets),
      sheetColors: (targetState.sheetColors && typeof targetState.sheetColors === 'object') ? targetState.sheetColors : Object.create(null),
      hiddenSheets: Array.isArray(targetState.hiddenSheets) ? targetState.hiddenSheets : [],
      colWidths: sanitizeDimensionMap(targetState.colWidths),
      rowHeights: sanitizeDimensionMap(targetState.rowHeights),
      colCounts: sanitizeColCounts(targetState.colCounts),
      rowCounts: sanitizeRowCounts(targetState.rowCounts),
      hiddenCols: sanitizeHiddenCols(targetState.hiddenCols)
    });

    // Install it into the correct workbook binding and persist to that file's key.
    // The default workbook lives in the global `sheetState`; other files are cached
    // in the `workbooks` map.
    if (fileId === 'default') {
      sheetState = restored;
    } else {
      cacheWorkbook(fileId, restored);
    }
    // Awaited: the restore is only announced once it is durable.
    await persistWorkbook(fileId);

    // Log the restoration event in this file's version history.
    const creator = req.user ? req.user.username : 'anonymous';
    await versionsRepo.insertVersion(JSON.stringify(restored), creator, fileId);

    // Broadcast the restored init state to the clients viewing THIS file only.
    const initPayload = {
      type: 'init',
      payload: {
        sheets: restored.sheets,
        sheetOrder: restored.sheetOrder,
        sheetColors: restored.sheetColors,
        hiddenSheets: restored.hiddenSheets,
        colWidths: restored.colWidths,
        rowHeights: restored.rowHeights,
        colCounts: restored.colCounts,
        rowCounts: restored.rowCounts,
        hiddenCols: restored.hiddenCols,
        users: presenceForFile(fileId)
      }
    };
    localBroadcast(fileId, initPayload);

    res.json({ success: true });
  } catch (err) {
    logger.error({ err: err }, 'Error restoring version');
    res.status(500).json({ error: 'internal_server_error', message: 'Failed to restore version' });
  }
});

// Static client assets. Caching is decided per request by whether the URL carries
// the content-hash version query (`?v=<hash>`, see ASSET_VERSION):
//
//   with ?v=   the hash IS the cache key — any change to any file in public/ mints
//              a new one, and the HTML naming it is itself revalidated — so the
//              response can be cached indefinitely and never revalidated. This is
//              the editor's path: /sheet stamps all 13 of its modules, ~861 KB of
//              JS+CSS that a returning user then re-fetches zero bytes of.
//   without    nothing proves the URL is current (drive.html and login.html still
//              reference their scripts unstamped), so the browser must revalidate.
//              express.static's ETag/Last-Modified turn that into a 304 with no
//              body — still far cheaper than the `no-store` this replaced, which
//              re-sent every byte on every load even though the ?v= hash had
//              already made that unnecessary.
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, _filePath) => {
    const versioned = typeof res.req.query.v === 'string' && res.req.query.v !== '';
    res.setHeader(
      'Cache-Control',
      versioned ? 'public, max-age=31536000, immutable' : 'no-cache'
    );
  }
}));

// Server instance declaration for HTTP/WebSocket handling.
let server;

// Separate HTTP server exposing Prometheus /metrics on METRICS_PORT (null unless enabled).
let metricsServer = null;

/**
 * Unsigns a signed cookie value using the provided secret key.
 * Used to securely verify session ID from the WebSocket upgrade request.
 * @param {string} val - The signed cookie string (excluding the 's:' prefix).
 * @param {string} secret - The secret key used to sign the cookie.
 * @returns {string|boolean} The unsigned session ID if valid, or false otherwise.
 */
const unsign = (val, secret) => {
  const lastDot = val.lastIndexOf('.');
  if (lastDot === -1) return false;
  const str = val.slice(0, lastDot);
  const mac = val.slice(lastDot + 1);
  const expectedMac = crypto
    .createHmac('sha256', secret)
    .update(str)
    .digest('base64')
    .replace(/=/g, '');

  const macBuffer = Buffer.from(mac);
  const expectedBuffer = Buffer.from(expectedMac);
  if (macBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(macBuffer, expectedBuffer) ? str : false;
};

// Initialize WebSocket server instance.
//
// permessage-deflate is off by default in ws, which left the one genuinely large
// frame this protocol sends — `init`, the entire workbook — going out raw on every
// connect, every reconnect, and to every client after a version restore. It
// compresses by 94-96%, more than the static bundle does, and unlike the bundle it
// cannot be cached because it differs every time.
//
// Configured rather than merely enabled: ws's own documentation warns that the
// default deflate settings are memory-hungry per connection, and this server holds
// a socket per editing user. These are the settings from that warning's tuning
// example — a small window and no context takeover, so nothing large is retained
// between messages, plus a concurrency cap on zlib. On a representative workbook
// they cost nothing measurable against the memory-hungry settings.
//
// `threshold` leaves the small, frequent frames (cell-edit, cursor-move) alone:
// they are latency-sensitive and too small to gain. The win is the one big message.
const wss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: {
    zlibDeflateOptions: { chunkSize: 1024, memLevel: 7, level: 3 },
    zlibInflateOptions: { chunkSize: 10 * 1024 },
    clientNoContextTakeover: true,
    serverNoContextTakeover: true,
    serverMaxWindowBits: 10,
    concurrencyLimit: 10,
    threshold: 1024
  }
});

// Heartbeat: the `ws` library does not detect a half-open / abruptly-dropped TCP
// connection on its own, so a client that vanishes (network blip, laptop sleep,
// Cloud Run instance recycle) can linger in `activeUsers` long after it has already
// reconnected under a fresh wsId — leaving every other user staring at a stale,
// duplicate presence tag for the same person. Periodically ping every socket and
// terminate any that didn't answer the previous round. terminate() fires `close`,
// which removes the entry and broadcasts `user-leave`, clearing the stale tag for
// everyone (locally and across instances via the bus).
const HEARTBEAT_INTERVAL_MS = Number(process.env.WS_HEARTBEAT_MS) || 30000;
const heartbeatInterval = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) { /* socket already closing */ }
  }
}, HEARTBEAT_INTERVAL_MS);
// Don't let the heartbeat keep the event loop alive during tests/shutdown.
heartbeatInterval.unref();

// Cross-instance message bus. In single-instance / local mode (no REDIS_URL) this
// is a no-op and the server behaves exactly as before. init() runs in `ready`.
// REALTIME_CHANNEL keeps deployments that share a Redis server from hearing each
// other. Unset in production, where one channel per Redis is exactly right; the
// integration suite sets it per test file (#211).
const bus = createRealtimeBus({
  redisUrl: process.env.REDIS_URL,
  cluster: REDIS_CLUSTER,
  channel: process.env.REALTIME_CHANNEL
});

// Run database initialization and start the HTTP server with WebSocket upgrade
// support. `ready` resolves once the server is actually listening, so importers
// (e.g. tests that load the module in-process) can await startup and then close
// the server deterministically instead of racing the detached startup.
const ready = (async () => {
  try {
    // Perform database initialization and table provisioning on startup.
    await initDatabase();
    sheetState = await loadState();

    // Connect the cross-instance realtime bus (no-op without REDIS_URL).
    await bus.init();

    // Create the HTTP server and attach handlers before it begins listening.
    server = app.listen(PORT);

    // Clean up background timers and resources when the server is closed.
    server.on('close', () => {
      if (typeof autosaveInterval !== 'undefined') {
        clearInterval(autosaveInterval);
      }
      clearInterval(heartbeatInterval);
      bus.close().catch(() => { /* best-effort */ });
      if (metricsServer) {
        metricsServer.close();
        metricsServer = null;
      }
    });

    // Attach Upgrade handler to the HTTP server for WebSocket handshakes.
    server.on('upgrade', (request, socket, head) => {
      // Extract and parse session cookie for security
      const cookieHeader = request.headers.cookie;

      if (cookieHeader) {
        // Search for the connect.sid session cookie
        const match = cookieHeader.match(/connect\.sid=([^;]+)/);
        if (match) {
          const cookieVal = decodeURIComponent(match[1]);
          if (cookieVal.startsWith('s:')) {
            const signedVal = cookieVal.slice(2);
            // Unsign the session cookie using the session secret
            const sessionId = unsign(signedVal, SESSION_SECRET);
            if (sessionId) {
              // Look up session data in the shared sessionStore
              sessionStore.get(sessionId, (err, sessionData) => {
                if (!err && sessionData && sessionData.passport && sessionData.passport.user) {
                  request.sessionUser = sessionData.passport.user;
                }
                // Proceed to complete the WebSocket upgrade
                wss.handleUpgrade(request, socket, head, (ws) => {
                  wss.emit('connection', ws, request);
                });
              });
              return;
            }
          }
        }
      }

      // If no valid session is found, proceed to upgrade using guest/fallback credentials.
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    });

    // Resolve `ready` only once the server is actually listening, then register the
    // passport strategies (which need the now-active port for OAuth callbacks).
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    logger.info(`Server running on port ${PORT}`);
    registerStrategies();

    // Start the Prometheus metrics server (no-op unless METRICS_PORT is set). The
    // runtime gauges are sampled lazily at scrape time via these providers, so they
    // always reflect current WS/presence/dependency state without a background timer.
    metricsServer = startMetricsServer({
      getWsConnectionCount: () => wss.clients.size,
      getActiveUserCount: () => activeUsers.size,
      getCachedWorkbookCount: () => workbooks.size,
      checkDb: async () => {
        try { await pool.query('SELECT 1'); return true; } catch (e) { return false; }
      },
      checkRedis: async () => {
        try { return await bus.ping(); } catch (e) { return false; }
      },
    });

    // Startup is fully done: schema provisioned, state loaded, bus connected,
    // server listening, strategies registered. Probes can now report ready.
    startupComplete = true;
    return server;
  } catch (err) {
    logger.error({ err }, 'Database initialization or server startup failed');
    process.exit(1);
  }
})();

// Map to maintain details of active connected users: wsId -> { ws, username, color, activeCell }
// This holds only sockets connected to THIS instance (each entry has a live `ws`).
const activeUsers = new Map();

// Mirror of users connected to OTHER instances (multi-instance mode), kept in sync
// via the realtime bus. No `ws` — used only to build the presence list in `init`.
// wsId -> { username, color, activeCell, activeSheet, fileId }
const remoteUsers = new Map();

// Which user ids are on which file, for `activeUsers` and `remoteUsers`
// respectively. Both maps are keyed by user id, so finding everyone on one file
// meant walking every user the instance knows about — on every op, and again on
// every presence event, which is the one place per-op cost multiplies by the number
// of connected users. These indexes make that O(recipients) (#256).
//
// Strictly derived state: every write to the two maps above goes through the
// add/remove helpers below, and an empty set is deleted rather than left behind so
// the index does not become its own leak.
/** @type {Map<string, Set<string>>} */
const localUsersByFile = new Map();
/** @type {Map<string, Set<string>>} */
const remoteUsersByFile = new Map();

/**
 * Record that `userId` is on `fileId` in the given index.
 * @param {Map<string, Set<string>>} index
 * @param {string} fileId
 * @param {string} userId
 */
const indexUser = (index, fileId, userId) => {
  let set = index.get(fileId);
  if (!set) { set = new Set(); index.set(fileId, set); }
  set.add(userId);
};

/**
 * Remove `userId` from `fileId` in the given index, dropping the file's entry once
 * nobody is left on it.
 * @param {Map<string, Set<string>>} index
 * @param {string} fileId
 * @param {string} userId
 */
const unindexUser = (index, fileId, userId) => {
  const set = index.get(fileId);
  if (!set) return;
  set.delete(userId);
  if (set.size === 0) index.delete(fileId);
};

/** Shared empty result, so a lookup for a file with nobody on it allocates nothing. */
const NO_USERS = new Set();

/**
 * The user ids on `fileId` in the given index.
 * @param {Map<string, Set<string>>} index
 * @param {string} fileId
 * @returns {Set<string>} Empty when nobody is on the file.
 */
const usersOnFile = (index, fileId) => index.get(fileId) || NO_USERS;

// Autosave bookkeeping, tracked per workbook (file id). Each edited file gets an
// entry; the periodic engine snapshots whichever files have pending changes once a
// threshold is met. The legacy 'default' workbook is tracked under 'default' like
// any other file.
/** @type {Map<string, { pending: boolean, editors: Set<string>, lastEditTime: number, lastVersionTime: number }>} */
const autosaveByFile = new Map();

/**
 * Mark a file dirty for the autosave engine, creating its tracking entry on the
 * first edit.
 * @param {string} fileId
 * @param {string} editor
 */
const trackEdit = (fileId, editor) => {
  const now = Date.now();
  let entry = autosaveByFile.get(fileId);
  if (!entry) {
    entry = { pending: false, editors: new Set(), lastEditTime: now, lastVersionTime: now };
    autosaveByFile.set(fileId, entry);
  }
  entry.pending = true;
  entry.editors.add(editor);
  entry.lastEditTime = now;
};

// Configuration thresholds loaded from environment variables with defaults.
const AUTOSAVE_CHECK_INTERVAL = parseInt(process.env.AUTOSAVE_CHECK_INTERVAL || '10000', 10);
const AUTOSAVE_INACTIVITY_LIMIT = parseInt(process.env.AUTOSAVE_INACTIVITY_LIMIT || '15000', 10);
const AUTOSAVE_ACTIVE_LIMIT = parseInt(process.env.AUTOSAVE_ACTIVE_LIMIT || '300000', 10);

// How long a cached workbook must go unused before the sweep may drop it. Long
// enough that a reload, or a second request in a burst, finds the file still
// cached; short enough that a file nobody is on does not outlive its session by
// much. Only files with no local socket are candidates at all.
const WORKBOOK_IDLE_EVICT_MS = parseInt(process.env.WORKBOOK_IDLE_EVICT_MS || '60000', 10);

/**
 * Whether any socket on THIS instance is currently on `fileId`. Users on other
 * instances are deliberately not counted: each instance caches for its own
 * sockets, and an instance with none has nothing to keep the workbook for.
 * @param {string} fileId
 * @returns {boolean}
 */
const fileHasLocalSockets = (fileId) => usersOnFile(localUsersByFile, fileId).size > 0;

/**
 * Drop cached workbooks nobody is using, so an instance's memory follows the files
 * being worked on rather than every file it has ever touched (#247).
 *
 * A file is only dropped when all four hold:
 *  - no socket on this instance is on it;
 *  - it has not been handed out by getWorkbook for WORKBOOK_IDLE_EVICT_MS, which
 *    covers a request that is between its load and its write;
 *  - no write is in flight for it and none is armed behind the write floor — with
 *    neither, every op so far is already persisted, so there is nothing to flush
 *    before dropping the state;
 *  - the autosave engine owes it no snapshot, which would otherwise re-load the
 *    workbook from Postgres just to copy it.
 */
const sweepIdleWorkbooks = () => {
  const now = Date.now();
  for (const fileId of [...workbooks.keys()]) {
    if (fileHasLocalSockets(fileId)) continue;
    if (now - (workbookLastUse.get(fileId) || 0) < WORKBOOK_IDLE_EVICT_MS) continue;
    const autosave = autosaveByFile.get(fileId);
    if (autosave && autosave.pending) continue;
    if (!workbookWriter.forget(fileId)) continue; // a write is in flight or armed
    uncacheWorkbook(fileId);
    autosaveByFile.delete(fileId);
    autosaveLog.debug(`Evicted idle workbook ${fileId} from the cache`);
  }
};

// Setup the periodic check interval for the autosave engine.
// On each tick, snapshot every file with pending changes whose inactivity or
// active-work threshold has been reached, then drop the workbooks nobody is using.
const autosaveInterval = setInterval(async () => {
  const now = Date.now();
  for (const [fileId, entry] of autosaveByFile) {
    if (!entry.pending) continue;

    // Verify if either inactivity or active work time threshold is reached.
    const isInactive = now - entry.lastEditTime >= AUTOSAVE_INACTIVITY_LIMIT;
    const isActiveLimitReached = now - entry.lastVersionTime >= AUTOSAVE_ACTIVE_LIMIT;
    if (!isInactive && !isActiveLimitReached) continue;

    try {
      // Construct the editors string using comma and space separator.
      const editorsString = entry.editors.size > 0 ? Array.from(entry.editors).join(', ') : 'anonymous';

      // In multi-instance mode every instance that saw a local edit would
      // otherwise snapshot independently, producing duplicate version-history
      // entries. A short-lived distributed lock (keyed per file) lets a single
      // instance win the snapshot for this window (always granted in local mode).
      const gotLock = await bus.acquireLock(`autosave:${fileId}`, Math.max(1000, AUTOSAVE_CHECK_INTERVAL - 500));
      if (!gotLock) {
        // Another instance is snapshotting this file; clear our local pending flag
        // so we don't spin, and let its snapshot stand.
        entry.pending = false;
        entry.editors.clear();
        entry.lastVersionTime = now;
        continue;
      }

      // Snapshot this file's current live state under its own id.
      const workbook = await getWorkbook(fileId);
      await versionsRepo.insertVersion(JSON.stringify(workbook), editorsString, fileId);

      autosaveLog.info(`Created version snapshot for ${fileId}. Editors: ${editorsString}`);

      // Reset tracking for this file upon successful snapshot creation.
      entry.pending = false;
      entry.editors.clear();
      entry.lastVersionTime = now;
    } catch (err) {
      autosaveLog.error({ err }, `Error creating version snapshot for ${fileId}`);
    }
  }

  // After the snapshots, so a file whose last editor just left is written to
  // version history on this same tick and only becomes evictable on the next one.
  sweepIdleWorkbooks();
}, AUTOSAVE_CHECK_INTERVAL);

// Prevent the interval from keeping the Node.js event loop active during tests/shutdown.
if (typeof autosaveInterval.unref === 'function') {
  autosaveInterval.unref();
}

// Color palette for user cursor highlights (from co-sheet design layout specs).
const userColors = ['#1471e6', '#1e8e3e', '#d93025', '#e37400', '#a142f4', '#f06292'];

/**
 * Send a message to every local socket editing `fileId`, optionally excluding one
 * connection (the sender, for "broadcast to others" semantics). This only reaches
 * sockets held by THIS instance; cross-instance fan-out is layered on top via the
 * realtime bus.
 * @param {string} fileId
 * @param {object} msg
 * @param {string|null} [excludeWsId]
 */
const localBroadcast = (fileId, msg, excludeWsId = null) => {
  const ids = usersOnFile(localUsersByFile, fileId);
  if (ids.size === 0) return; // nobody here; don't serialize a message for no one
  const data = JSON.stringify(msg);
  for (const id of ids) {
    if (id === excludeWsId) continue;
    const info = activeUsers.get(id);
    if (info && info.ws.readyState === WebSocket.OPEN) info.ws.send(data);
  }
};

/**
 * Resolve the in-memory workbook for a file id WITHOUT loading it. The default
 * workbook always lives in `sheetState`; other workbooks are only returned if
 * already cached on this instance. Returns null when not cached — used by the
 * replica path to skip ops for files this instance isn't currently serving (a
 * later connection re-loads fresh state from Postgres).
 * @param {string} fileId
 * @returns {Object|null}
 */
const resolveCachedWorkbook = (fileId) => {
  if (fileId === 'default') return getDefaultState();
  return workbooks.get(fileId) || null;
};

// Largest cell-edit-bulk a single message may carry. Mirrored by the client's
// CELL_EDIT_BULK_MAX, which chunks longer bursts.
const MAX_BULK_CELL_EDITS = 500;

/**
 * Apply a state-changing op to `workbook` and return the client messages to emit.
 * This is the single source of truth for how each op mutates state, run identically
 * on the originating instance and on every replica (so all in-memory caches stay
 * coherent). It does NOT persist or network — the caller decides that.
 *
 * @param {Object} workbook  The target workbook state.
 * @param {string} type      Op type (one of stateChangingTypes).
 * @param {Object} payload   Op payload.
 * @returns {Array<{ all: boolean, msg: object }>} Messages to deliver locally;
 *   `all` true => include the sender, false => exclude the sender.
 */
const applyStateOp = (workbook, type, payload) => {
  /** @type {Array<{ all: boolean, msg: object }>} */
  const out = [];

  if (type === 'cell-edit') {
    const { cellId, formula, value, style, sheetName } = payload;
    const sheet = sheetName || 'Sheet1';
    const result = cellService.writeCellValue(workbook, { cellId, formula, value, style, sheetName: sheet });
    if (result.ok) {
      out.push({ all: false, msg: { type: 'cell-update', payload: { cellId, formula, value, style, sheetName: result.sheet } } });
    }
  } else if (type === 'cell-edit-bulk') {
    // One message for a whole bulk edit (a paste, a format applied over a
    // selection). Each entry is validated exactly as a lone cell-edit is, and the
    // whole batch produces ONE cell-update-bulk — so the caller persists once and
    // fans out once instead of doing both per cell.
    const cells = Array.isArray(payload && payload.cells) ? payload.cells : [];
    // A client never exceeds its own chunk size; a hand-rolled message might, and
    // WebSocket traffic is not covered by the HTTP rate limiters, so cap the work
    // one message can ask for rather than trusting the sender. Rejected whole
    // rather than clamped, so a client can never quietly lose half a paste.
    if (cells.length > MAX_BULK_CELL_EDITS) {
      wsLog.warn(`Rejected cell-edit-bulk of ${cells.length} cells (cap ${MAX_BULK_CELL_EDITS})`);
      return out;
    }
    const updates = [];
    for (const cell of cells) {
      if (!cell || typeof cell !== 'object') continue;
      const { cellId, formula, value, style } = cell;
      const sheet = cell.sheetName || payload.sheetName || 'Sheet1';
      const result = cellService.writeCellValue(workbook, { cellId, formula, value, style, sheetName: sheet });
      // An invalid entry is skipped, not fatal: one bad cell must not discard the
      // rest of a paste the user already sees applied locally.
      if (result.ok) updates.push({ cellId, formula, value, style, sheetName: result.sheet });
    }
    if (updates.length) {
      out.push({ all: false, msg: { type: 'cell-update-bulk', payload: { cells: updates } } });
    }
  } else if (type === 'add-sheet') {
    const result = sheetService.addSheet(workbook, payload);
    if (result.ok) {
      out.push({ all: true, msg: { type: 'add-sheet', payload: { sheetName: result.sheetName, sheetOrder: result.sheetOrder } } });
    }
  } else if (type === 'delete-sheet') {
    const result = sheetService.deleteSheet(workbook, payload);
    if (result.ok) {
      // Switch local users on the deleted sheet to another visible sheet (presence).
      for (const [, info] of activeUsers) {
        if (info.activeSheet === result.sheetName) {
          info.activeSheet = workbook.sheetOrder.find(s => !workbook.hiddenSheets.includes(s)) || 'Sheet1';
          info.activeCell = null;
        }
      }
      out.push({ all: true, msg: { type: 'delete-sheet', payload: { sheetName: result.sheetName } } });
    }
  } else if (type === 'copy-sheet') {
    const result = sheetService.copySheet(workbook, payload);
    if (result.ok) {
      out.push({ all: true, msg: { type: 'add-sheet', payload: { sheetName: result.sheetName, sheetOrder: result.sheetOrder, cells: result.cells } } });
    }
  } else if (type === 'rename-sheet') {
    const result = sheetService.renameSheet(workbook, payload);
    if (result.ok) {
      // Update local users on the renamed sheet (presence).
      for (const [, info] of activeUsers) {
        if (info.activeSheet === result.oldName) info.activeSheet = result.newName;
      }
      out.push({ all: true, msg: { type: 'rename-sheet', payload: { oldName: result.oldName, newName: result.newName } } });
    }
  } else if (type === 'color-sheet') {
    const result = sheetService.colorSheet(workbook, payload);
    if (result.ok) {
      out.push({ all: true, msg: { type: 'color-sheet', payload: { sheetName: result.sheetName, color: result.color } } });
    }
  } else if (type === 'hide-sheet') {
    const result = sheetService.hideSheet(workbook, payload);
    if (result.ok) {
      // Move local users on the hidden sheet to another visible sheet (presence).
      for (const [, info] of activeUsers) {
        if (info.activeSheet === result.sheetName) {
          info.activeSheet = workbook.sheetOrder.find(s => !workbook.hiddenSheets.includes(s)) || 'Sheet1';
          info.activeCell = null;
        }
      }
      out.push({ all: true, msg: { type: 'hide-sheet', payload: { sheetName: result.sheetName } } });
    }
  } else if (type === 'unhide-sheet') {
    const result = sheetService.unhideSheet(workbook, payload);
    if (result.ok) {
      out.push({ all: true, msg: { type: 'unhide-sheet', payload: { sheetName: result.sheetName } } });
    }
  } else if (type === 'reorder-sheets') {
    const result = sheetService.reorderSheets(workbook, payload);
    if (result.ok) {
      out.push({ all: true, msg: { type: 'reorder-sheets', payload: { sheetOrder: result.sheetOrder } } });
    }
  } else if (type === 'resize') {
    const dimension = payload && payload.dimension;
    const result = dimension === 'col'
      ? dimensionService.resizeColumn(workbook, payload)
      : dimension === 'row'
        ? dimensionService.resizeRow(workbook, payload)
        : /** @type {{ ok: false }} */ ({ ok: false });
    if (result.ok) {
      out.push({ all: true, msg: { type: 'resize-update', payload: { dimension, sheetName: result.sheetName, col: result.col, row: result.row, size: result.size } } });
    }
  } else if (type === 'set-col-count') {
    const result = dimensionService.setColCount(workbook, payload);
    if (result.ok) {
      out.push({ all: true, msg: { type: 'col-count-update', payload: { sheetName: result.sheetName, count: result.count } } });
    }
  } else if (type === 'set-row-count') {
    const result = dimensionService.setRowCount(workbook, payload);
    if (result.ok) {
      out.push({ all: true, msg: { type: 'row-count-update', payload: { sheetName: result.sheetName, count: result.count } } });
    }
  } else if (type === 'set-hidden-cols') {
    const result = dimensionService.setHiddenCols(workbook, payload);
    if (result.ok) {
      out.push({ all: true, msg: { type: 'hidden-cols-update', payload: { sheetName: result.sheetName, cols: result.cols } } });
    }
  }

  return out;
};

/**
 * Run a state op end-to-end on this instance: mutate the cached workbook, emit the
 * resulting messages to local sockets, and (origin only) persist. Returns true if
 * the op changed state.
 * @param {{ fileId: string, type: string, payload: object, excludeWsId?: string|null, persist: boolean }} args
 * @returns {boolean}
 */
const processStateOp = ({ fileId, type, payload, excludeWsId = null, persist }) => {
  const workbook = resolveCachedWorkbook(fileId);
  if (!workbook) return false; // not served on this instance
  const broadcasts = applyStateOp(workbook, type, payload);
  if (!broadcasts.length) return false;
  if (persist) persistWorkbook(fileId);
  for (const b of broadcasts) {
    localBroadcast(fileId, b.msg, b.all ? null : excludeWsId);
  }
  return true;
};

/**
 * Build the presence list for a file: local sockets plus mirrored remote users.
 * @param {string} fileId
 * @returns {Array<{ userId: string, username: string, color: string, activeCell: any, activeSheet: string }>}
 */
const presenceForFile = (fileId) => {
  const list = [];
  const add = (index, users) => {
    for (const id of usersOnFile(index, fileId)) {
      const info = users.get(id);
      if (!info) continue;
      list.push({ userId: id, username: info.username, color: info.color, activeCell: info.activeCell, activeSheet: info.activeSheet || 'Sheet1' });
    }
  };
  add(localUsersByFile, activeUsers);
  add(remoteUsersByFile, remoteUsers);
  return list;
};

/**
 * Handle a message received from ANOTHER instance via the realtime bus. State ops
 * are re-applied to the local cache and fanned out to local sockets; presence
 * events update the remote-user mirror and notify local sockets.
 * @param {object} msg
 */
const handleBusMessage = (msg) => {
  try {
    if (!msg || typeof msg !== 'object') return;
    if (msg.kind === 'op') {
      // Replica apply: no persist (the origin already persisted), no sender to exclude.
      processStateOp({ fileId: msg.fileId, type: msg.type, payload: msg.payload, excludeWsId: null, persist: false });
      return;
    }
    if (msg.kind === 'presence') {
      const { event, fileId } = msg;
      if (event === 'join' || event === 'update') {
        const u = msg.user;
        // A re-announced user may have moved to another file, so the index follows
        // the entry it is replacing rather than assuming the file is the same.
        const previous = remoteUsers.get(u.userId);
        if (previous && previous.fileId !== fileId) unindexUser(remoteUsersByFile, previous.fileId, u.userId);
        remoteUsers.set(u.userId, { username: u.username, color: u.color, activeCell: u.activeCell, activeSheet: u.activeSheet, fileId });
        indexUser(remoteUsersByFile, fileId, u.userId);
        localBroadcast(fileId, { type: 'cursor-update', payload: { userId: u.userId, username: u.username, color: u.color, activeCell: u.activeCell, activeSheet: u.activeSheet } });
      } else if (event === 'leave') {
        // The stored entry is authoritative about which file the user was on.
        const leaving = remoteUsers.get(msg.userId);
        unindexUser(remoteUsersByFile, (leaving && leaving.fileId) || fileId, msg.userId);
        remoteUsers.delete(msg.userId);
        localBroadcast(fileId, { type: 'user-leave', payload: { userId: msg.userId } });
      } else if (event === 'sync-request') {
        // A peer (re)joined and wants the current roster — re-announce our local
        // users for that file so the requester's clients can render them.
        for (const id of usersOnFile(localUsersByFile, fileId)) {
          const info = activeUsers.get(id);
          if (!info) continue;
          bus.publish({ kind: 'presence', event: 'join', fileId, user: { userId: id, username: info.username, color: info.color, activeCell: info.activeCell, activeSheet: info.activeSheet || 'Sheet1' } });
        }
      }
    }
  } catch (e) {
    realtimeLog.error({ err: e }, 'error handling bus message');
  }
};

bus.onMessage(handleBusMessage);

// Handle incoming WebSocket connection requests.
wss.on('connection', async (ws, req) => {
  // Generate a unique identifier for the connection socket. Use a CSPRNG
  // (crypto.randomBytes) rather than Math.random(): this id is surfaced to other
  // clients as a presence/user handle and used to key connection state, so it must
  // not be predictable. Matches the id scheme used elsewhere for file ids.
  const wsId = crypto.randomBytes(9).toString('hex');

  // Determine username: Use the authenticated passport session user if present, or fallback to mock name.
  const sessionUser = req.sessionUser;
  const username = sessionUser && sessionUser.username ? sessionUser.username : `User-${wsId}`;

  // Resolve which workbook this connection edits from the ?file=<id> query parameter.
  // Absent or invalid => the legacy 'default' workbook (preserves single-document behavior).
  let fileId = 'default';
  try {
    const reqUrl = new URL(req.url, 'http://localhost');
    const f = reqUrl.searchParams.get('file');
    if (f && isValidFileId(f)) fileId = f;
  } catch (e) { /* malformed URL => default workbook */ }

  // Enforce general access before serving any state: a restricted file is only
  // viewable by the owner(s)/admins/shared users (defense-in-depth; the /sheet route
  // normally redirects unauthorized users before they reach the editor).
  if (!(await canViewFile(sessionUser, fileId))) {
    try { ws.close(1008, 'forbidden'); } catch (e) { /* already closed */ }
    return;
  }

  // Load (and cache) this connection's workbook. For 'default' this is the global sheetState.
  const connWorkbook = await getWorkbook(fileId);

  // Resolve whether this connection may make changes. The shared 'default' workbook
  // stays editable by anyone; for other files only the owner / admins / super admins
  // can edit. Unauthorized clients still connect (read-only + presence) but their
  // state-changing messages are ignored. Computed once at connect time.
  const canEdit = await canModifyFile(sessionUser, fileId);

  wsLog.info(`Connected: ${username} (${wsId}) on file ${fileId} (canEdit=${canEdit})`);

  // Assign a custom cursor color dynamically using modulo on user count.
  const color = userColors[activeUsers.size % userColors.length];

  // Store user connection state details in our memory map (scoped by file id).
  activeUsers.set(wsId, { ws, username, color, activeCell: null, fileId });
  indexUser(localUsersByFile, fileId, wsId);

  // Heartbeat liveness: mark alive now and on every pong. The interval above pings
  // each socket and terminates any still marked dead from the previous round, so a
  // silently-dropped connection is reaped instead of leaving a stale presence tag.
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  // 1. Send the initialization payload ('init') for THIS connection's workbook only.
  // Sheet by sheet, and once: the payload used to carry a `cells` field too, an
  // alias of the first visible sheet, which for a single-sheet workbook meant the
  // whole document went out twice (#246).
  ws.send(JSON.stringify({
    type: 'init',
    payload: {
      sheets: connWorkbook.sheets,
      sheetOrder: connWorkbook.sheetOrder,
      sheetColors: connWorkbook.sheetColors,
      hiddenSheets: connWorkbook.hiddenSheets,
      colWidths: connWorkbook.colWidths,
      rowHeights: connWorkbook.rowHeights,
      colCounts: connWorkbook.colCounts,
      rowCounts: connWorkbook.rowCounts,
      hiddenCols: connWorkbook.hiddenCols,
      canEdit, // whether THIS client is permitted to modify the workbook
      // This connection's own presence identity, so the client can filter its
      // own cursor out of the roster below (a refresh/reconnect can briefly leave
      // a stale presence of the previous connection for the same username).
      self: { userId: wsId, username },
      // Presence list merges this instance's sockets with users mirrored from
      // other instances (empty in single-instance mode).
      users: presenceForFile(fileId)
    }
  }));

  // 2. Announce this user's presence: to local clients directly, and to other
  // instances over the bus. Also ask peers to re-announce their rosters so this
  // client learns about users already connected elsewhere.
  const joinUser = { userId: wsId, username, color, activeCell: null, activeSheet: 'Sheet1' };
  localBroadcast(fileId, { type: 'cursor-update', payload: joinUser }, wsId);
  bus.publish({ kind: 'presence', event: 'join', fileId, user: joinUser });
  bus.publish({ kind: 'presence', event: 'sync-request', fileId });

  // State-changing op types (everything except presence/cursor). Used for the
  // write-permission gate, autosave bookkeeping, and cross-instance fan-out.
  const stateChangingTypes = [
    'cell-edit',
    'cell-edit-bulk',
    'add-sheet',
    'delete-sheet',
    'copy-sheet',
    'rename-sheet',
    'color-sheet',
    'hide-sheet',
    'unhide-sheet',
    'reorder-sheets',
    'resize',
    'set-col-count',
    'set-row-count',
    'set-hidden-cols'
  ];

  // Handle incoming WebSocket message events.
  ws.on('message', (message) => {
    wsLog.debug(`Message from ${username} (${wsId}): ${message}`);
    try {
      const { type, payload } = JSON.parse(message);

      // Live workbook for cursor validation (default => global binding).
      const workbook = (fileId === 'default') ? getDefaultState() : connWorkbook;

      // Handle client cell cursor navigation (presence — no state mutation).
      if (type === 'cursor-move') {
        const info = activeUsers.get(wsId);
        if (info) {
          // Verify that the sheetName is a string matching the sheet-name regex and exists before assigning it.
          const sheetName = payload.sheetName;
          if (typeof sheetName === 'string' && /^[\p{L}\p{N} ]{2,30}$/u.test(sheetName) && workbook.sheets && workbook.sheets[sheetName]) {
            info.activeSheet = sheetName;
          } else {
            info.activeSheet = 'Sheet1';
          }

          // Check that cellId is either null or matches the standard cell ID regex before updating.
          const cellId = payload.cellId;
          if (cellId === null || (typeof cellId === 'string' && /^[A-Z]{1,2}[1-9][0-9]{0,2}$/.test(cellId))) {
            info.activeCell = cellId;
          }

          const cu = { userId: wsId, username: info.username, color: info.color, activeCell: info.activeCell, activeSheet: info.activeSheet };
          // Notify local peers and mirror to other instances.
          localBroadcast(fileId, { type: 'cursor-update', payload: cu }, wsId);
          bus.publish({ kind: 'presence', event: 'update', fileId, user: cu });
        }
        return;
      }

      // All remaining handled types are state-changing.
      if (!stateChangingTypes.includes(type)) return;

      // Enforce file-level write access: clients without edit permission on this
      // file may still move their cursor (presence) but cannot change state.
      if (!canEdit) return;

      // Mark this workbook dirty for the autosave engine. Every editable file is
      // version-tracked under its own id (not just the legacy 'default' workbook).
      trackEdit(fileId, username);

      // Apply locally (mutate cache + persist + fan out to local sockets). When it
      // actually changed state, relay the op so every other instance applies the
      // same mutation to its cache and notifies its own clients.
      const changed = processStateOp({ fileId, type, payload, excludeWsId: wsId, persist: true });
      if (changed) {
        bus.publish({ kind: 'op', fileId, type, payload });
      }
    } catch (e) {
      wsLog.error({ err: e }, 'WebSocket message parsing error');
    }
  });

  // Handle connection termination / socket closure.
  ws.on('close', () => {
    wsLog.info(`Closed: ${username} (${wsId})`);
    // Remove user entry from active users registry.
    activeUsers.delete(wsId);
    unindexUser(localUsersByFile, fileId, wsId);

    // Notify local clients and other instances that this user left. Safe after the
    // un-index: this socket is the one excluded from the broadcast anyway.
    localBroadcast(fileId, { type: 'user-leave', payload: { userId: wsId } }, wsId);
    bus.publish({ kind: 'presence', event: 'leave', fileId, userId: wsId });
  });
});

// Export database pool, initialization function, and server instance for integration tests.
export { pool, initDatabase, server, ready };
