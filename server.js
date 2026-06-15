import 'dotenv/config';
import pg from 'pg';

/**
 * @file server.js
 * @description Main entry point for the co-sheet collaborative spreadsheet application.
 * Configures the Express server to serve static assets and handles routing.
 */

import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import session from 'express-session';
import passport from 'passport';
import { Strategy as OIDCStrategy } from 'passport-openidconnect';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';

// Calculate the directory name of the current ES module to handle relative path resolution.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize the Express application instance.
const app = express();

// Determine the port number: default to 3000 unless overridden by the PORT environment variable.
const PORT = process.env.PORT || 3000;

// Generate RSA key pair for signing mock JWTs at server startup
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});

// Export the public key in JWK format for the JWKS endpoint
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

  const existingRes = await pool.query('SELECT id, role FROM users WHERE id = $1', [id]);
  const existing = existingRes.rows && existingRes.rows[0];

  let role;
  if (existing) {
    if (envSuper) role = 'superadmin';
    else role = (existing.role === 'superadmin') ? 'admin' : (existing.role || 'user');
    await pool.query(
      'UPDATE users SET username = $1, email = $2, provider = $3, role = $4, last_login = CURRENT_TIMESTAMP WHERE id = $5',
      [username, email, provider, role, id]
    );
  } else {
    role = envSuper ? 'superadmin' : 'user';
    await pool.query(
      'INSERT INTO users (id, username, email, role, provider, last_login) VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)',
      [id, username, email, role, provider]
    );
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
    const res = await pool.query('SELECT role FROM users WHERE id = $1', [id]);
    const row = res.rows && res.rows[0];
    if (!row) return 'user';
    return (row.role === 'superadmin') ? 'admin' : (row.role || 'user');
  } catch (e) {
    return 'user';
  }
}

/**
 * Reads the owner (created_by identity) of a file.
 * @param {string} fileId
 * @returns {Promise<string|null>} The owner identity, or null if unknown.
 */
async function getFileOwner(fileId) {
  try {
    const r = await pool.query('SELECT created_by FROM files WHERE id = $1', [fileId]);
    const row = r.rows && r.rows[0];
    return row ? (row.created_by || null) : null;
  } catch (e) {
    return null;
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
  const owner = await getFileOwner(fileId);
  const id = userIdentity(user);
  if (id && owner && id === owner) return true;
  // A user shared as 'editor' or co-'owner' may modify the file; 'viewer' may not.
  return ['editor', 'owner'].includes(await getShareRole(fileId, id));
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
    const r = await pool.query('SELECT role FROM file_shares WHERE file_id = $1 AND user_id = $2', [fileId, userId]);
    const row = r.rows && r.rows[0];
    return row ? (row.role || 'viewer') : null;
  } catch (e) {
    return null;
  }
}

/**
 * The general (link-based) access mode for a file.
 * @param {string} fileId
 * @returns {Promise<'restricted'|'anyone'>} Defaults to 'restricted'.
 */
async function getFileAccess(fileId) {
  try {
    const r = await pool.query('SELECT link_access FROM files WHERE id = $1', [fileId]);
    const row = r.rows && r.rows[0];
    return row && row.link_access === 'anyone' ? 'anyone' : 'restricted';
  } catch (e) {
    return 'restricted';
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
  const owner = await getFileOwner(fileId);
  const id = userIdentity(user);
  if (id && owner && id === owner) return true;
  if (id && (await getShareRole(fileId, id)) !== null) return true;
  return (await getFileAccess(fileId)) === 'anyone';
}

/**
 * Identity keys of the users a file has been explicitly shared with.
 * @param {string} fileId
 * @returns {Promise<string[]>}
 */
async function getSharedUserIds(fileId) {
  try {
    const r = await pool.query('SELECT user_id FROM file_shares WHERE file_id = $1', [fileId]);
    return (r.rows || []).map((x) => x.user_id);
  } catch (e) {
    return [];
  }
}

/**
 * Set of file ids that have been shared with a given user.
 * @param {string|null} userId
 * @returns {Promise<Set<string>>}
 */
async function getSharedFileIds(userId) {
  if (!userId) return new Set();
  try {
    const r = await pool.query('SELECT file_id FROM file_shares WHERE user_id = $1', [userId]);
    return new Set((r.rows || []).map((x) => x.file_id));
  } catch (e) {
    return new Set();
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
    const r = await pool.query('SELECT file_id, role FROM file_shares WHERE user_id = $1', [userId]);
    return new Map((r.rows || []).map((x) => [x.file_id, x.role || 'viewer']));
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
    const r = await pool.query('SELECT file_id FROM file_stars WHERE user_id = $1', [userId]);
    return new Set((r.rows || []).map((x) => x.file_id));
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

// Middleware to parse incoming request bodies as JSON.
app.use(express.json());

// Middleware to parse urlencoded bodies, typical of form submissions.
app.use(express.urlencoded({ extended: true }));

// Instantiate a shared in-memory session store so that it can be queried during WebSocket upgrades.
const sessionStore = new session.MemoryStore();

// Configure express-session middleware with secure false cookie configuration.
app.use(session({
  secret: 'co-sheet-secret-key-123',
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
      scope: process.env.OIDC_SCOPE || 'openid profile email'
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

  // Register Google OIDC strategy if credentials are configured in the environment.
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
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
    console.error('Role check failed:', e.message);
  }
  return res.status(403).json({ error: 'forbidden', message: 'Admin privileges required' });
};

/**
 * OIDC Discovery Endpoint:
 * Serves the OpenID provider configuration. This includes metadata about the
 * issuer URL, authorization endpoint, token endpoint, and user info endpoint.
 */
app.get('/oidc/.well-known/openid-configuration', (req, res) => {
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
app.get('/oidc/jwks', (req, res) => {
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
app.get('/oidc/authorize', (req, res) => {
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
app.post('/oidc/login', (req, res) => {
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
app.post('/oidc/token', (req, res) => {
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
app.get('/oidc/userinfo', (req, res) => {
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

// Serve the login page.
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Redirect direct requests for index.html to the home (drive) route, so they are subject to auth.
app.get('/index.html', (req, res) => {
  res.redirect('/');
});

// Define the root route to serve the file management interface ("drive") from the
// private directory. This is the first screen users see after signing in.
// Protected: unauthenticated users are redirected to /login.
app.get('/', ensureAuthenticated, (req, res) => {
  res.sendFile(path.join(__dirname, 'private', 'drive.html'));
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
      const result = await pool.query('SELECT name FROM files WHERE id = $1', [fileId]);
      if (result.rows && result.rows[0] && result.rows[0].name) name = result.rows[0].name;
    } catch (e) {
      // Fall back to the default name if the lookup fails.
    }

    const template = await fs.promises.readFile(path.join(__dirname, 'private', 'index.html'), 'utf8');
    const html = template.split('{{FILE_NAME}}').join(escapeHtml(name));
    res.type('html').send(html);
  } catch (err) {
    console.error('Error serving editor:', err.message);
    res.sendFile(path.join(__dirname, 'private', 'index.html'));
  }
});

// Trigger the OIDC authentication flow.
app.get('/auth/oidc', passport.authenticate('oidc'));

// OIDC Provider callback route after authentication is completed.
app.get('/auth/oidc/callback', passport.authenticate('oidc', {
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

// Route for Google OAuth redirect setup or mock login fallback.
app.get('/auth/google', (req, res, next) => {
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

// Handle mock Google login form submissions.
app.post('/auth/google/mock-login', (req, res) => {
  const { email, name } = req.body;
  req.login({ username: name || email || 'Google User', email: email || null, picture: null, provider: 'google' }, (err) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.redirect('/');
  });
});

// Callback receiver for Google OAuth OIDC redirects.
app.get('/auth/google/callback', (req, res, next) => {
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
    console.error('Failed to record login:', e.message);
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
    const result = await pool.query(
      'SELECT id, username, email, role, provider, last_login FROM users ORDER BY last_login DESC'
    );
    const selfId = userIdentity(req.user);
    const users = result.rows.map((r) => {
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
        last_login: r.last_login,
        superAdmin,
        self: r.id === selfId
      };
    });
    res.json({ role: req.userRole, users });
  } catch (err) {
    console.error('Error listing users:', err.message);
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
    const found = await pool.query('SELECT id, role FROM users WHERE id = $1', [id]);
    const target = found.rows && found.rows[0];
    if (!target) {
      return res.status(404).json({ error: 'not_found', message: 'User not found' });
    }
    if (SUPER_ADMIN_IDS.has(id) || target.role === 'superadmin') {
      return res.status(403).json({ error: 'forbidden', message: 'Super admins cannot be modified' });
    }
    await pool.query('UPDATE users SET role = $1 WHERE id = $2', [role, id]);
    res.json({ success: true, id, role });
  } catch (err) {
    console.error('Error updating user role:', err.message);
    res.status(500).json({ error: 'internal_server_error', message: 'Failed to update role' });
  }
});

// Define the path to the store.json file where spreadsheet cell state is persisted.
const STORE_PATH = process.env.STORE_PATH || path.join(__dirname, 'store.json');

// Initialize database connection pool. If running in 'test' mode, mock it to use STORE_PATH.
let pool;
if (process.env.NODE_ENV === 'test' || process.env.npm_lifecycle_event === 'test') {
  // Ensure NODE_ENV is set to 'test' so other modules/tests know we are in test mode.
  process.env.NODE_ENV = 'test';
  pool = {
    // Intercept query calls to read/write from/to the local file specified by STORE_PATH,
    // so that integration tests can run without a real PostgreSQL server.
    async query(text, params) {
      const sql = text.trim();

      // Map a workbook key to its backing file. The legacy 'default' workbook lives
      // at STORE_PATH (preserving existing test expectations); every other file id
      // gets an isolated sidecar so per-file workbooks do not collide in test mode.
      const pathForKey = (key) => {
        if (!key || key === 'default') return STORE_PATH;
        const safe = String(key).replace(/[^a-zA-Z0-9_-]/g, '_');
        return `${STORE_PATH}.wb.${safe}.json`;
      };
      // Sidecar JSON file holding the file-manager registry (list of files).
      const filesRegistryPath = `${STORE_PATH}.files.json`;
      const readFilesRegistry = () => {
        if (fs.existsSync(filesRegistryPath)) {
          try { return JSON.parse(fs.readFileSync(filesRegistryPath, 'utf8')); } catch (e) { return []; }
        }
        return [];
      };
      const writeFilesRegistry = (list) => {
        fs.writeFileSync(filesRegistryPath, JSON.stringify(list, null, 2), 'utf8');
      };

      // ----- files registry table mocks -----
      if (/INSERT\s+INTO\s+["']?files["']?/i.test(sql)) {
        const list = readFilesRegistry();
        const row = {
          id: params && params[0],
          name: (params && params[1]) || 'Untitled spreadsheet',
          created_at: new Date().toISOString(),
          created_by: (params && params[2]) || 'anonymous',
          link_access: 'restricted'
        };
        list.push(row);
        writeFilesRegistry(list);
        return { rows: [row] };
      }
      if (/UPDATE\s+["']?files["']?\s+SET\s+name/i.test(sql)) {
        const list = readFilesRegistry();
        const target = params && params[1];
        const row = list.find(f => f.id === target);
        if (row) { row.name = params[0]; writeFilesRegistry(list); }
        return { rows: row ? [row] : [] };
      }
      if (/UPDATE\s+["']?files["']?\s+SET\s+link_access/i.test(sql)) {
        const list = readFilesRegistry();
        const target = params && params[1];
        const row = list.find(f => f.id === target);
        if (row) { row.link_access = params[0]; writeFilesRegistry(list); }
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      if (/DELETE\s+FROM\s+["']?files["']?/i.test(sql)) {
        let list = readFilesRegistry();
        const target = params && params[0];
        const before = list.length;
        list = list.filter(f => f.id !== target);
        writeFilesRegistry(list);
        // Also drop the workbook sidecar for that file.
        const wbPath = pathForKey(target);
        if (wbPath !== STORE_PATH && fs.existsSync(wbPath)) fs.unlinkSync(wbPath);
        return { rows: [], rowCount: before - list.length };
      }
      if (/SELECT\s+.*\s+FROM\s+["']?files["']?/i.test(sql)) {
        let list = readFilesRegistry();
        if (/WHERE\s+id\s*=\s*\$1/i.test(sql) && params && params.length > 0) {
          list = list.filter(f => f.id === params[0]);
        } else if (/WHERE\s+created_by\s*=\s*\$1/i.test(sql) && params && params.length > 0) {
          list = list.filter(f => f.created_by === params[0]);
        } else if (/ORDER\s+BY\s+created_at\s+DESC/i.test(sql)) {
          list = [...list].reverse();
        }
        // Default link_access for rows persisted before the column existed.
        return { rows: list.map((f) => ({ link_access: 'restricted', ...f })) };
      }

      // ----- users table mocks (permissions page) -----
      const usersRegistryPath = `${STORE_PATH}.users.json`;
      const readUsers = () => {
        if (fs.existsSync(usersRegistryPath)) {
          try { return JSON.parse(fs.readFileSync(usersRegistryPath, 'utf8')); } catch (e) { return []; }
        }
        return [];
      };
      const writeUsers = (list) => {
        fs.writeFileSync(usersRegistryPath, JSON.stringify(list, null, 2), 'utf8');
      };

      if (/CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?["']?users["']?/i.test(sql)) {
        return { rows: [] };
      }
      if (/INSERT\s+INTO\s+["']?users["']?/i.test(sql)) {
        const list = readUsers();
        const now = new Date().toISOString();
        const row = {
          id: params && params[0],
          username: (params && params[1]) || null,
          email: (params && params[2]) || null,
          role: (params && params[3]) || 'user',
          provider: (params && params[4]) || null,
          created_at: now,
          last_login: now
        };
        if (!list.find((u) => u.id === row.id)) list.push(row);
        writeUsers(list);
        return { rows: [row] };
      }
      // Role-only update (PATCH /api/users/:id): UPDATE users SET role = $1 WHERE id = $2
      if (/UPDATE\s+["']?users["']?\s+SET\s+role\s*=\s*\$1/i.test(sql)) {
        const list = readUsers();
        const row = list.find((u) => u.id === (params && params[1]));
        if (row) { row.role = params[0]; writeUsers(list); }
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      // Login touch update: UPDATE users SET username,email,provider,role,last_login WHERE id = $5
      if (/UPDATE\s+["']?users["']?\s+SET/i.test(sql)) {
        const list = readUsers();
        const row = list.find((u) => u.id === (params && params[4]));
        if (row) {
          row.username = params[0];
          row.email = params[1];
          row.provider = params[2];
          row.role = params[3];
          row.last_login = new Date().toISOString();
          writeUsers(list);
        }
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      if (/SELECT\s+.*\s+FROM\s+["']?users["']?/i.test(sql)) {
        let list = readUsers();
        if (/WHERE\s+id\s*=\s*\$1/i.test(sql) && params && params.length > 0) {
          list = list.filter((u) => u.id === params[0]);
        } else if (/ORDER\s+BY\s+last_login\s+DESC/i.test(sql)) {
          list = [...list].sort((a, b) => String(b.last_login).localeCompare(String(a.last_login)));
        }
        return { rows: list };
      }

      // ----- file_shares table mocks (file sharing) -----
      const sharesRegistryPath = `${STORE_PATH}.shares.json`;
      const readShares = () => {
        if (fs.existsSync(sharesRegistryPath)) {
          try { return JSON.parse(fs.readFileSync(sharesRegistryPath, 'utf8')); } catch (e) { return []; }
        }
        return [];
      };
      const writeShares = (list) => {
        fs.writeFileSync(sharesRegistryPath, JSON.stringify(list, null, 2), 'utf8');
      };

      if (/CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?["']?file_shares["']?/i.test(sql)) {
        return { rows: [] };
      }
      if (/INSERT\s+INTO\s+["']?file_shares["']?/i.test(sql)) {
        const list = readShares();
        const role = (params && params[2]) || 'viewer';
        const existing = list.find((s) => s.file_id === (params && params[0]) && s.user_id === (params && params[1]));
        let row;
        if (existing) {
          // Mirror ON CONFLICT (file_id, user_id) DO UPDATE SET role = EXCLUDED.role.
          existing.role = role;
          row = existing;
        } else {
          row = { file_id: params && params[0], user_id: params && params[1], role, created_at: new Date().toISOString() };
          list.push(row);
        }
        writeShares(list);
        return { rows: [row] };
      }
      if (/UPDATE\s+["']?file_shares["']?\s+SET\s+role/i.test(sql)) {
        const list = readShares();
        const row = list.find((s) => s.file_id === (params && params[0]) && s.user_id === (params && params[1]));
        if (row) { row.role = params[2]; writeShares(list); }
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      if (/DELETE\s+FROM\s+["']?file_shares["']?/i.test(sql)) {
        let list = readShares();
        const before = list.length;
        if (/user_id\s*=\s*\$2/i.test(sql) && params && params.length > 1) {
          list = list.filter((s) => !(s.file_id === params[0] && s.user_id === params[1]));
        } else if (params && params.length > 0) {
          list = list.filter((s) => s.file_id !== params[0]);
        }
        writeShares(list);
        return { rows: [], rowCount: before - list.length };
      }
      if (/SELECT\s+.*\s+FROM\s+["']?file_shares["']?/i.test(sql)) {
        let list = readShares();
        // Combined filter (file_id AND user_id) must be checked first.
        if (/file_id\s*=\s*\$1/i.test(sql) && /user_id\s*=\s*\$2/i.test(sql) && params && params.length > 1) {
          list = list.filter((s) => s.file_id === params[0] && s.user_id === params[1]);
        } else if (/WHERE\s+file_id\s*=\s*\$1/i.test(sql) && params && params.length > 0) {
          list = list.filter((s) => s.file_id === params[0]);
        } else if (/WHERE\s+user_id\s*=\s*\$1/i.test(sql) && params && params.length > 0) {
          list = list.filter((s) => s.user_id === params[0]);
        }
        // Ensure a role is always present for older rows persisted before roles existed.
        return { rows: list.map((s) => ({ role: 'viewer', ...s })) };
      }

      // ----- file_stars table mocks (per-user starred files) -----
      const starsRegistryPath = `${STORE_PATH}.stars.json`;
      const readStars = () => {
        if (fs.existsSync(starsRegistryPath)) {
          try { return JSON.parse(fs.readFileSync(starsRegistryPath, 'utf8')); } catch (e) { return []; }
        }
        return [];
      };
      const writeStars = (list) => {
        fs.writeFileSync(starsRegistryPath, JSON.stringify(list, null, 2), 'utf8');
      };

      if (/CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?["']?file_stars["']?/i.test(sql)) {
        return { rows: [] };
      }
      if (/INSERT\s+INTO\s+["']?file_stars["']?/i.test(sql)) {
        const list = readStars();
        const fileId = params && params[0];
        const userId = params && params[1];
        // Mirror ON CONFLICT (file_id, user_id) DO NOTHING.
        if (!list.find((s) => s.file_id === fileId && s.user_id === userId)) {
          list.push({ file_id: fileId, user_id: userId, created_at: new Date().toISOString() });
          writeStars(list);
        }
        return { rows: [], rowCount: 1 };
      }
      if (/DELETE\s+FROM\s+["']?file_stars["']?/i.test(sql)) {
        let list = readStars();
        const before = list.length;
        if (/user_id\s*=\s*\$2/i.test(sql) && params && params.length > 1) {
          list = list.filter((s) => !(s.file_id === params[0] && s.user_id === params[1]));
        } else if (/WHERE\s+user_id\s*=\s*\$1/i.test(sql) && params && params.length > 0) {
          list = list.filter((s) => s.user_id !== params[0]);
        } else if (params && params.length > 0) {
          list = list.filter((s) => s.file_id !== params[0]);
        }
        writeStars(list);
        return { rows: [], rowCount: before - list.length };
      }
      if (/SELECT\s+.*\s+FROM\s+["']?file_stars["']?/i.test(sql)) {
        let list = readStars();
        if (/file_id\s*=\s*\$1/i.test(sql) && /user_id\s*=\s*\$2/i.test(sql) && params && params.length > 1) {
          list = list.filter((s) => s.file_id === params[0] && s.user_id === params[1]);
        } else if (/WHERE\s+user_id\s*=\s*\$1/i.test(sql) && params && params.length > 0) {
          list = list.filter((s) => s.user_id === params[0]);
        } else if (/WHERE\s+file_id\s*=\s*\$1/i.test(sql) && params && params.length > 0) {
          list = list.filter((s) => s.file_id === params[0]);
        }
        return { rows: list };
      }

      // Handle workbook_versions table creation query mock.
      if (/CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?["']?workbook_versions["']?/i.test(sql)) {
        return { rows: [] };
      }

      // Handle workbook_versions database insertion mock.
      // Stores versions in a separate JSON file named like '${STORE_PATH}.versions.json'.
      if (/INSERT\s+INTO\s+["']?workbook_versions["']?/i.test(sql)) {
        let versions = [];
        const versionsPath = STORE_PATH + '.versions.json';
        if (fs.existsSync(versionsPath)) {
          try {
            versions = JSON.parse(fs.readFileSync(versionsPath, 'utf8'));
          } catch (e) {
            versions = [];
          }
        }
        const newId = versions.length + 1;
        const rawState = params && params[0];
        let parsedState = rawState;
        if (typeof rawState === 'string') {
          try {
            parsedState = JSON.parse(rawState);
          } catch (e) {
            // Keep as is if not valid JSON string
          }
        }
        const newVersion = {
          id: newId,
          state: parsedState,
          created_at: new Date().toISOString(),
          created_by: (params && params[1]) || 'anonymous'
        };
        versions.push(newVersion);
        fs.writeFileSync(versionsPath, JSON.stringify(versions, null, 2), 'utf8');
        return { rows: [newVersion] };
      }

      // Handle workbook_versions query mock selection.
      // Parses version logs, handles filtering by ID, and optionally reverses them for DESC sorting.
      if (/SELECT\s+.*\s+FROM\s+["']?workbook_versions["']?/i.test(sql)) {
        let versions = [];
        const versionsPath = STORE_PATH + '.versions.json';
        if (fs.existsSync(versionsPath)) {
          try {
            versions = JSON.parse(fs.readFileSync(versionsPath, 'utf8'));
          } catch (e) {
            versions = [];
          }
        }
        const mappedVersions = versions.map(v => {
          let parsedState = v.state;
          if (typeof parsedState === 'string') {
            try {
              parsedState = JSON.parse(parsedState);
            } catch (e) {
              // Keep as is if not valid JSON string
            }
          }
          return {
            ...v,
            state: parsedState
          };
        });
        let resultRows = mappedVersions;
        if (/WHERE\s+id\s*=\s*\$1/i.test(sql) && params && params.length > 0) {
          const targetId = parseInt(params[0], 10);
          resultRows = mappedVersions.filter(v => v.id === targetId);
        } else if (/ORDER\s+BY\s+(created_at|id)\s+DESC/i.test(sql)) {
          resultRows = [...mappedVersions].reverse();
        }
        return { rows: resultRows };
      }

      // CREATE TABLE / INSERT INTO workbook_state: return empty rows, and for INSERT
      // write the state JSON (params[0]) to the path for its key (params[1], default 'default').
      if (/CREATE\s+TABLE/i.test(sql) || /INSERT\s+INTO\s+["']?workbook_state["']?/i.test(sql)) {
        if (/INSERT\s+INTO\s+["']?workbook_state["']?/i.test(sql) && params && params[0]) {
          fs.writeFileSync(pathForKey(params[1]), params[0], 'utf8');
        }
        return { rows: [] };
      }

      // SELECT key FROM workbook_state: report existence of the backing file for the requested key.
      if (/SELECT\s+key\s+FROM\s+["']?workbook_state["']?/i.test(sql)) {
        const key = (params && params[0]) || 'default';
        if (fs.existsSync(pathForKey(key))) {
          return { rows: [{ key }] };
        }
        return { rows: [] };
      }

      // SELECT state FROM workbook_state: read state for the requested key (params[0], default 'default').
      if (/SELECT\s+state\s+FROM\s+["']?workbook_state["']?/i.test(sql)) {
        const key = (params && params[0]) || 'default';
        const p = pathForKey(key);
        if (fs.existsSync(p)) {
          const data = fs.readFileSync(p, 'utf8');
          const parsed = JSON.parse(data);
          return { rows: [{ state: parsed }] };
        }
        return { rows: [] };
      }

      // UPDATE workbook_state SET state = $1 WHERE key = $2: write state (params[0]) to the key's path.
      if (/UPDATE\s+["']?workbook_state["']?\s+SET\s+state\s*=/i.test(sql)) {
        if (params && params[0]) {
          fs.writeFileSync(pathForKey(params[1]), params[0], 'utf8');
        }
        return { rows: [] };
      }

      // DELETE FROM workbook_state WHERE key = $1: remove the key's backing sidecar (never the default store here).
      if (/DELETE\s+FROM\s+["']?workbook_state["']?/i.test(sql)) {
        const p = pathForKey(params && params[0]);
        if (p !== STORE_PATH && fs.existsSync(p)) fs.unlinkSync(p);
        return { rows: [] };
      }

      return { rows: [] };
    },
    async end() {
      // Noop in mock mode.
    }
  };
} else {
  // Use real pg connection pool with DATABASE_URL in production/development.
  pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL
  });
}

/**
 * Provisions the workbook_state table and seeds the initial default state
 * if the key 'default' is absent.
 * @returns {Promise<void>}
 */
async function initDatabase() {
  // Provision workbook_state table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS workbook_state (
      key VARCHAR(50) PRIMARY KEY,
      state JSONB,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Provision workbook_versions table for version history tracking
  await pool.query(`
    CREATE TABLE IF NOT EXISTS workbook_versions (
      id SERIAL PRIMARY KEY,
      state JSONB NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      created_by TEXT NOT NULL
    )
  `);

  // Provision files table backing the file-management interface. Each row is a
  // workbook whose cell data lives in workbook_state under the same key as files.id.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS files (
      id VARCHAR(64) PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      created_by TEXT,
      link_access TEXT NOT NULL DEFAULT 'restricted'
    )
  `);
  // Idempotent migration for databases provisioned before link_access existed.
  // 'restricted' = only owner/admin/shared users may open the file; 'anyone' = any
  // signed-in user with the link may open it (view-only).
  await pool.query(`ALTER TABLE files ADD COLUMN IF NOT EXISTS link_access TEXT NOT NULL DEFAULT 'restricted'`);

  // Provision the users table backing the permissions page. Each row is a user
  // who has signed in at least once; `role` is one of 'user' | 'admin' |
  // 'superadmin'. Super admins are initialized from the environment (see
  // SUPER_ADMIN_EMAILS) on login rather than seeded here.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT,
      email TEXT,
      role TEXT NOT NULL DEFAULT 'user',
      provider TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_login TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Provision the file_shares table: each row grants a user access to a file owned
  // by someone else, surfacing that file in the user's drive listing. `role` is
  // 'editor' (can modify) or 'viewer' (read-only). New shares default to 'editor'
  // at the API; the column default is 'viewer' so any pre-existing rows (created
  // before roles existed) stay read-only.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS file_shares (
      file_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'viewer',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (file_id, user_id)
    )
  `);
  // Idempotent migration for databases provisioned before the role column existed.
  await pool.query(`ALTER TABLE file_shares ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'viewer'`);

  // Provision the file_stars table: each row marks a file as "starred" (a personal
  // favourite) by a user. Starring is per-user — the same file may be starred by
  // some users and not others — so the drive's Starred view lists only the
  // signed-in user's own starred files.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS file_stars (
      file_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (file_id, user_id)
    )
  `);

  // On a first run (no files at all), surface the legacy 'default' workbook as a
  // file so the drive isn't empty and existing data is reachable. Once the user
  // has any files, we don't re-create 'default' — so deleting it sticks.
  const filesRes = await pool.query('SELECT id FROM files');
  if (filesRes.rows.length === 0) {
    await pool.query(
      'INSERT INTO files (id, name, created_by) VALUES ($1, $2, $3)',
      ['default', 'Untitled spreadsheet', 'system']
    );
  }

  // Check if default key exists in workbook_state
  const res = await pool.query(`
    SELECT key FROM workbook_state WHERE key = $1
  `, ['default']);

  // If absent, initialize and seed with default sheets and metadata
  if (res.rows.length === 0) {
    const freshSheets = Object.create(null);
    freshSheets['Sheet1'] = Object.create(null);
    freshSheets['Sheet2'] = Object.create(null);
    const defaultState = {
      sheets: freshSheets,
      sheetOrder: ['Sheet1', 'Sheet2'],
      sheetColors: Object.create(null),
      hiddenSheets: []
    };

    await pool.query(`
      INSERT INTO workbook_state (state, key) VALUES ($1, $2)
    `, [JSON.stringify(defaultState), 'default']);
  }
}

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
 * @returns {Object} The spreadsheet state containing a 'cells' object.
 */
const loadState = async (key = 'default') => {
  try {
    const result = await pool.query(
      'SELECT state FROM workbook_state WHERE key = $1',
      [key]
    );
    if (result.rows.length > 0) {
      let parsed = result.rows[0].state;
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
      
      // Ensure default sheets exist
      if (!sheets['Sheet1']) sheets['Sheet1'] = Object.create(null);
      if (!sheets['Sheet2']) sheets['Sheet2'] = Object.create(null);
      
      // Initialize/migrate sheetOrder, sheetColors, and hiddenSheets
      const sheetOrder = (parsed && Array.isArray(parsed.sheetOrder)) ? parsed.sheetOrder : Object.keys(sheets);
      // Ensure default sheets are in the order array
      if (!sheetOrder.includes('Sheet1')) sheetOrder.push('Sheet1');
      if (!sheetOrder.includes('Sheet2')) sheetOrder.push('Sheet2');
      
      const sheetColors = (parsed && parsed.sheetColors && typeof parsed.sheetColors === 'object') ? parsed.sheetColors : Object.create(null);
      const hiddenSheets = (parsed && Array.isArray(parsed.hiddenSheets)) ? parsed.hiddenSheets : [];
      
      const state = { sheets, sheetOrder, sheetColors, hiddenSheets };
      // Define a getter/setter proxy for legacy 'cells' compatibility pointing to the first visible sheet
      return setupCellsProxy(state);
    }
  } catch (e) {
    console.error('Error loading state from PostgreSQL, returning default:', e.message);
  }
  
  // Return fresh state if absent or query fails.
  const freshSheets = Object.create(null);
  freshSheets['Sheet1'] = Object.create(null);
  freshSheets['Sheet2'] = Object.create(null);
  const freshState = {
    sheets: freshSheets,
    sheetOrder: ['Sheet1', 'Sheet2'],
    sheetColors: Object.create(null),
    hiddenSheets: []
  };
  // Define getter/setter proxy on the fresh state object pointing to first visible sheet (Sheet1).
  return setupCellsProxy(freshState);
};

// Initialize the in-memory sheetState to null, to be populated on boot.
let sheetState = null;

// State locks and write queue variables to prevent file write race conditions and corruption.
let isSaving = false;
let pendingSave = false;

/**
 * Saves the in-memory spreadsheet cell state back to the PostgreSQL database.
 * This function persists updates asynchronously and atomically to prevent data corruption.
 */
const saveState = async () => {
  // If a save operation is already in progress, queue another one to run next.
  if (isSaving) {
    pendingSave = true;
    return;
  }
  isSaving = true;

  try {
    await pool.query(
      "UPDATE workbook_state SET state = $1, updated_at = CURRENT_TIMESTAMP WHERE key = 'default'",
      [JSON.stringify(sheetState)]
    );
  } catch (err) {
    console.error('Failed to save state to PostgreSQL:', err.message);
  } finally {
    isSaving = false;
    if (pendingSave) {
      pendingSave = false;
      saveState();
    }
  }
};

// In-memory cache of non-default workbooks, keyed by file id. The 'default'
// workbook always lives in the global `sheetState` binding (so existing
// single-document behavior and tests are untouched).
const workbooks = new Map();

// Accessor for the live default workbook binding, so callers that shadow the
// `sheetState` name locally can still reach the current global (which may be
// swapped out by a version restore).
const getDefaultState = () => sheetState;

// A file id is either the legacy 'default' workbook or a 24-char hex token
// minted by POST /api/files. Used to validate untrusted ?file= input.
const isValidFileId = (id) => id === 'default' || /^[a-f0-9]{24}$/.test(id);

/**
 * Resolve the live workbook state object for a given file id, lazily loading and
 * caching non-default workbooks. Returns `sheetState` for the default workbook so
 * callers always observe the latest global state (e.g. after a version restore).
 * @param {string} fileId
 * @returns {Promise<Object>} The workbook state ({ sheets, sheetOrder, ... }).
 */
const getWorkbook = async (fileId) => {
  if (!fileId || fileId === 'default') return sheetState;
  if (workbooks.has(fileId)) return workbooks.get(fileId);
  const st = await loadState(fileId);
  workbooks.set(fileId, st);
  return st;
};

/**
 * Persist a non-default workbook's state to its own key in workbook_state.
 * The default workbook is persisted through saveState() instead.
 * @param {string} fileId
 * @param {Object} state
 */
const saveWorkbook = async (fileId, state) => {
  try {
    await pool.query(
      'UPDATE workbook_state SET state = $1, updated_at = CURRENT_TIMESTAMP WHERE key = $2',
      [JSON.stringify(state), fileId]
    );
  } catch (err) {
    console.error(`Failed to save workbook ${fileId}:`, err.message);
  }
};

/**
 * Persist whichever workbook a file id refers to (default vs. a cached file).
 * @param {string} fileId
 */
const persistWorkbook = (fileId) => {
  if (!fileId || fileId === 'default') return saveState();
  const state = workbooks.get(fileId);
  if (state) return saveWorkbook(fileId, state);
};

/**
 * GET /api/files
 * Lists all files in the management interface, newest first.
 * Protected with ensureAuthenticated middleware.
 */
app.get('/api/files', ensureAuthenticated, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, created_at, created_by, link_access FROM files ORDER BY created_at DESC'
    );
    const selfId = userIdentity(req.user);
    const role = await getUserRole(req.user);
    const isAdmin = role === 'admin' || role === 'superadmin';
    // A user sees the shared legacy 'default' workbook, the files they own, files
    // explicitly shared with them, and (for admins) everything. Each row carries
    // `owner` and `canModify` (owner / admin / default) so the UI can show/hide
    // edit affordances; the server enforces the same rules.
    const sharedRoles = isAdmin ? new Map() : await getSharedRoleMap(selfId);
    // Per-user starred set, so each row can carry whether the viewer has starred it.
    const starredIds = await getStarredFileIds(selfId);
    const visible = result.rows.filter((r) => {
      if (isAdmin || r.id === 'default') return true;
      if (selfId && r.created_by === selfId) return true;
      return sharedRoles.has(r.id);
    });
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
    console.error('Error listing files:', err.message);
    res.status(500).json({ error: 'internal_server_error', message: 'Failed to list files' });
  }
});

/**
 * POST /api/files
 * Creates a new empty workbook, mints a unique id, and returns a shareable URL.
 * Body: { name?: string }. Protected with ensureAuthenticated middleware.
 */
app.post('/api/files', ensureAuthenticated, async (req, res) => {
  try {
    let name = (req.body && typeof req.body.name === 'string') ? req.body.name.trim() : '';
    if (!name) name = 'Untitled spreadsheet';
    if (name.length > 120) name = name.slice(0, 120);

    // The creator (owner) is identified by their stable identity key.
    const creator = userIdentity(req.user) || 'anonymous';

    // Enforce the per-user file quota: a regular 'user' may own at most one file;
    // admins and super admins are unlimited. The shared legacy 'default' workbook
    // is system-owned and never counts against a user.
    const role = await getUserRole(req.user);
    if (role !== 'admin' && role !== 'superadmin') {
      const owned = await pool.query('SELECT id FROM files WHERE created_by = $1', [creator]);
      const ownedCount = (owned.rows || []).filter(r => r.id !== 'default').length;
      if (ownedCount >= 1) {
        return res.status(403).json({
          error: 'file_limit',
          message: 'Your account can create only one file. Ask an admin for more.'
        });
      }
    }

    // Mint a unique, URL-safe file id.
    const id = crypto.randomBytes(12).toString('hex');

    // Initialize a fresh, prototype-free workbook for this file.
    const freshSheets = Object.create(null);
    freshSheets['Sheet1'] = Object.create(null);
    freshSheets['Sheet2'] = Object.create(null);
    const freshState = {
      sheets: freshSheets,
      sheetOrder: ['Sheet1', 'Sheet2'],
      sheetColors: Object.create(null),
      hiddenSheets: []
    };

    await pool.query(
      'INSERT INTO workbook_state (state, key) VALUES ($1, $2)',
      [JSON.stringify(freshState), id]
    );
    await pool.query(
      'INSERT INTO files (id, name, created_by) VALUES ($1, $2, $3)',
      [id, name, creator]
    );
    workbooks.set(id, setupCellsProxy(freshState));

    const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    res.json({ id, name, url: `${baseUrl}/sheet?file=${id}` });
  } catch (err) {
    console.error('Error creating file:', err.message);
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
app.post('/api/files/:id/copy', ensureAuthenticated, async (req, res) => {
  try {
    const srcId = req.params.id;
    if (!isValidFileId(srcId)) {
      return res.status(400).json({ error: 'bad_request', message: 'Invalid file id' });
    }
    // The caller must be able to open the source to copy it.
    if (!(await canViewFile(req.user, srcId))) {
      return res.status(403).json({ error: 'forbidden', message: 'You do not have permission to copy this file' });
    }

    // Resolve the copy's name (fall back to the source name with a generic suffix).
    let name = (req.body && typeof req.body.name === 'string') ? req.body.name.trim() : '';
    if (!name) {
      const srcRow = await pool.query('SELECT name FROM files WHERE id = $1', [srcId]);
      const srcName = (srcRow.rows && srcRow.rows[0] && srcRow.rows[0].name) || 'Untitled spreadsheet';
      name = `Copy of ${srcName}`;
    }
    if (name.length > 120) name = name.slice(0, 120);

    const creator = userIdentity(req.user) || 'anonymous';

    // Enforce the same per-user quota as fresh creation (admins/super admins are
    // unlimited; a regular user may own at most one file besides 'default').
    const role = await getUserRole(req.user);
    if (role !== 'admin' && role !== 'superadmin') {
      const owned = await pool.query('SELECT id FROM files WHERE created_by = $1', [creator]);
      const ownedCount = (owned.rows || []).filter(r => r.id !== 'default').length;
      if (ownedCount >= 1) {
        return res.status(403).json({
          error: 'file_limit',
          message: 'Your account can create only one file. Ask an admin for more.'
        });
      }
    }

    // Snapshot the source workbook (live in-memory state if loaded, else from the
    // store) and deep-clone only the persisted shape — the non-enumerable `cells`
    // accessor is intentionally dropped.
    const src = await getWorkbook(srcId);
    const clonedState = JSON.parse(JSON.stringify({
      sheets: src.sheets || { Sheet1: {}, Sheet2: {} },
      sheetOrder: src.sheetOrder || ['Sheet1', 'Sheet2'],
      sheetColors: src.sheetColors || {},
      hiddenSheets: src.hiddenSheets || []
    }));

    const id = crypto.randomBytes(12).toString('hex');
    await pool.query(
      'INSERT INTO workbook_state (state, key) VALUES ($1, $2)',
      [JSON.stringify(clonedState), id]
    );
    await pool.query(
      'INSERT INTO files (id, name, created_by) VALUES ($1, $2, $3)',
      [id, name, creator]
    );
    // Seed the in-memory cache with a prototype-free copy (guards against prototype
    // pollution, mirroring loadState) so the copy is live without a round-trip.
    const cachedSheets = Object.create(null);
    for (const [sheetName, cellMap] of Object.entries(clonedState.sheets)) {
      cachedSheets[sheetName] = Object.assign(Object.create(null), cellMap);
    }
    workbooks.set(id, setupCellsProxy({
      sheets: cachedSheets,
      sheetOrder: clonedState.sheetOrder,
      sheetColors: Object.assign(Object.create(null), clonedState.sheetColors),
      hiddenSheets: clonedState.hiddenSheets
    }));

    // Optionally carry over the source's collaborators (never re-adding the new
    // owner as a share of their own copy).
    if (req.body && req.body.shareCollaborators) {
      try {
        const shares = await pool.query('SELECT user_id, role FROM file_shares WHERE file_id = $1', [srcId]);
        for (const s of (shares.rows || [])) {
          if (s.user_id && s.user_id !== creator) {
            await pool.query(
              'INSERT INTO file_shares (file_id, user_id, role) VALUES ($1, $2, $3)',
              [id, s.user_id, s.role || 'viewer']
            );
          }
        }
      } catch (e) {
        // Non-fatal: the copy itself succeeded even if share-copying failed.
        console.error('Error copying file shares:', e.message);
      }
    }

    const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    res.json({ id, name, url: `${baseUrl}/sheet?file=${id}` });
  } catch (err) {
    console.error('Error copying file:', err.message);
    res.status(500).json({ error: 'internal_server_error', message: 'Failed to copy file' });
  }
});

/**
 * GET /api/files/:id/details
 * Returns metadata for the file-details dialog: name, owner, created and last-modified
 * timestamps. The caller must be able to view the file. Protected with
 * ensureAuthenticated middleware.
 */
app.get('/api/files/:id/details', ensureAuthenticated, async (req, res) => {
  try {
    const id = req.params.id;
    if (!isValidFileId(id)) {
      return res.status(400).json({ error: 'bad_request', message: 'Invalid file id' });
    }
    if (!(await canViewFile(req.user, id))) {
      return res.status(403).json({ error: 'forbidden', message: 'You do not have permission to view this file' });
    }
    const fileRow = await pool.query('SELECT name, created_at, created_by FROM files WHERE id = $1', [id]);
    const row = fileRow.rows && fileRow.rows[0];
    if (!row) {
      return res.status(404).json({ error: 'not_found', message: 'File not found' });
    }
    const stateRow = await pool.query('SELECT updated_at FROM workbook_state WHERE key = $1', [id]);
    const updatedAt = (stateRow.rows && stateRow.rows[0] && stateRow.rows[0].updated_at) || row.created_at || null;
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
    console.error('Error reading file details:', err.message);
    res.status(500).json({ error: 'internal_server_error', message: 'Failed to read file details' });
  }
});

/**
 * PATCH /api/files/:id
 * Renames a file. Body: { name: string }. Protected with ensureAuthenticated middleware.
 */
app.patch('/api/files/:id', ensureAuthenticated, async (req, res) => {
  try {
    const id = req.params.id;
    if (!isValidFileId(id)) {
      return res.status(400).json({ error: 'bad_request', message: 'Invalid file id' });
    }
    if (!(await canModifyFile(req.user, id))) {
      return res.status(403).json({ error: 'forbidden', message: 'You do not have permission to modify this file' });
    }
    const name = (req.body && typeof req.body.name === 'string') ? req.body.name.trim() : '';
    if (!name || name.length > 120) {
      return res.status(400).json({ error: 'bad_request', message: 'name must be 1-120 characters' });
    }
    const result = await pool.query(
      'UPDATE files SET name = $1 WHERE id = $2',
      [name, id]
    );
    if (result.rows && result.rows.length === 0 && result.rowCount === 0) {
      // PG UPDATE returns rowCount; the test mock returns rows. Treat empty as not found.
    }
    res.json({ success: true, id, name });
  } catch (err) {
    console.error('Error renaming file:', err.message);
    res.status(500).json({ error: 'internal_server_error', message: 'Failed to rename file' });
  }
});

/**
 * DELETE /api/files/:id
 * Deletes a file and its workbook data. The legacy 'default' file cannot be deleted.
 * Protected with ensureAuthenticated middleware.
 */
app.delete('/api/files/:id', ensureAuthenticated, async (req, res) => {
  try {
    const id = req.params.id;
    if (!isValidFileId(id)) {
      return res.status(400).json({ error: 'bad_request', message: 'Invalid file id' });
    }
    if (!(await canModifyFile(req.user, id))) {
      return res.status(403).json({ error: 'forbidden', message: 'You do not have permission to delete this file' });
    }
    await pool.query('DELETE FROM files WHERE id = $1', [id]);
    await pool.query('DELETE FROM workbook_state WHERE key = $1', [id]);
    await pool.query('DELETE FROM file_shares WHERE file_id = $1', [id]);
    await pool.query('DELETE FROM file_stars WHERE file_id = $1', [id]);
    workbooks.delete(id);
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting file:', err.message);
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
    const all = await pool.query('SELECT id, username, email, role FROM users');
    const matches = (all.rows || [])
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
    console.error('Error searching users:', err.message);
    res.status(500).json({ error: 'internal_server_error', message: 'Failed to search users' });
  }
});

/**
 * GET /api/files/:id/shares
 * Lists the users a file is shared with. Requires modify permission on the file.
 */
app.get('/api/files/:id/shares', ensureAuthenticated, async (req, res) => {
  try {
    const id = req.params.id;
    if (!isValidFileId(id) || id === 'default') {
      return res.status(400).json({ error: 'bad_request', message: 'Invalid file id' });
    }
    if (!(await canModifyFile(req.user, id))) {
      return res.status(403).json({ error: 'forbidden', message: 'You do not have permission to view shares' });
    }
    const shareRows = await pool.query('SELECT user_id, role FROM file_shares WHERE file_id = $1', [id]);
    let users = [];
    if (shareRows.rows && shareRows.rows.length) {
      const all = await pool.query('SELECT id, username, email FROM users');
      const byId = new Map((all.rows || []).map((u) => [u.id, u]));
      users = shareRows.rows.map((s) => {
        const u = byId.get(s.user_id) || {};
        return { id: s.user_id, username: u.username || s.user_id, email: u.email || null, role: s.role || 'viewer' };
      });
    }
    res.json(users);
  } catch (err) {
    console.error('Error listing shares:', err.message);
    res.status(500).json({ error: 'internal_server_error', message: 'Failed to list shares' });
  }
});

/**
 * POST /api/files/:id/shares  { userIds: string[] }
 * Shares a file with one or more existing users (view access). Requires modify
 * permission on the file. Unknown ids and the owner/sharer are skipped.
 */
app.post('/api/files/:id/shares', ensureAuthenticated, async (req, res) => {
  try {
    const id = req.params.id;
    if (!isValidFileId(id) || id === 'default') {
      return res.status(400).json({ error: 'bad_request', message: 'Invalid file id' });
    }
    if (!(await canModifyFile(req.user, id))) {
      return res.status(403).json({ error: 'forbidden', message: 'You do not have permission to share this file' });
    }
    const userIds = (req.body && Array.isArray(req.body.userIds)) ? req.body.userIds : [];
    const cleaned = userIds.map((u) => String(u || '').trim().toLowerCase()).filter(Boolean);
    if (cleaned.length === 0) {
      return res.status(400).json({ error: 'bad_request', message: 'userIds must be a non-empty array' });
    }
    // New shares default to 'editor' (can modify); the sharer may request 'viewer'.
    const role = req.body && req.body.role === 'viewer' ? 'viewer' : 'editor';
    const owner = await getFileOwner(id);
    const selfId = userIdentity(req.user);
    const all = await pool.query('SELECT id FROM users');
    const known = new Set((all.rows || []).map((u) => u.id));
    let added = 0;
    for (const uid of cleaned) {
      if (uid === owner || uid === selfId || !known.has(uid)) continue;
      await pool.query(
        'INSERT INTO file_shares (file_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (file_id, user_id) DO UPDATE SET role = EXCLUDED.role',
        [id, uid, role]
      );
      added++;
    }
    res.json({ success: true, added, role });
  } catch (err) {
    console.error('Error sharing file:', err.message);
    res.status(500).json({ error: 'internal_server_error', message: 'Failed to share file' });
  }
});

/**
 * PATCH /api/files/:id/shares/:userId  { role: 'owner' | 'editor' | 'viewer' }
 * Changes an existing collaborator's role. 'owner' grants co-ownership (a file may
 * have multiple owners). Requires modify permission on the file.
 */
app.patch('/api/files/:id/shares/:userId', ensureAuthenticated, async (req, res) => {
  try {
    const id = req.params.id;
    if (!isValidFileId(id) || id === 'default') {
      return res.status(400).json({ error: 'bad_request', message: 'Invalid file id' });
    }
    if (!(await canModifyFile(req.user, id))) {
      return res.status(403).json({ error: 'forbidden', message: 'You do not have permission to change shares' });
    }
    const role = ['owner', 'editor', 'viewer'].includes(req.body && req.body.role) ? req.body.role : null;
    if (!role) {
      return res.status(400).json({ error: 'bad_request', message: "role must be 'owner', 'editor', or 'viewer'" });
    }
    const userId = String(req.params.userId || '').trim().toLowerCase();
    const result = await pool.query('UPDATE file_shares SET role = $3 WHERE file_id = $1 AND user_id = $2', [id, userId, role]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'not_found', message: 'Share not found' });
    }
    res.json({ success: true, role });
  } catch (err) {
    console.error('Error updating share:', err.message);
    res.status(500).json({ error: 'internal_server_error', message: 'Failed to update share' });
  }
});

/**
 * DELETE /api/files/:id/shares/:userId
 * Revokes a collaborator's access. Requires modify permission on the file.
 */
app.delete('/api/files/:id/shares/:userId', ensureAuthenticated, async (req, res) => {
  try {
    const id = req.params.id;
    if (!isValidFileId(id) || id === 'default') {
      return res.status(400).json({ error: 'bad_request', message: 'Invalid file id' });
    }
    if (!(await canModifyFile(req.user, id))) {
      return res.status(403).json({ error: 'forbidden', message: 'You do not have permission to change shares' });
    }
    const userId = String(req.params.userId || '').trim().toLowerCase();
    await pool.query('DELETE FROM file_shares WHERE file_id = $1 AND user_id = $2', [id, userId]);
    res.json({ success: true });
  } catch (err) {
    console.error('Error removing share:', err.message);
    res.status(500).json({ error: 'internal_server_error', message: 'Failed to remove share' });
  }
});

/**
 * PATCH /api/files/:id/access  { linkAccess: 'restricted' | 'anyone' }
 * Sets a file's general (link-based) access mode. 'anyone' lets any signed-in user
 * with the link open it view-only; 'restricted' limits it to owner(s)/admins/shared
 * users. Requires modify permission on the file.
 */
app.patch('/api/files/:id/access', ensureAuthenticated, async (req, res) => {
  try {
    const id = req.params.id;
    if (!isValidFileId(id) || id === 'default') {
      return res.status(400).json({ error: 'bad_request', message: 'Invalid file id' });
    }
    if (!(await canModifyFile(req.user, id))) {
      return res.status(403).json({ error: 'forbidden', message: 'You do not have permission to change access' });
    }
    const linkAccess = ['restricted', 'anyone'].includes(req.body && req.body.linkAccess) ? req.body.linkAccess : null;
    if (!linkAccess) {
      return res.status(400).json({ error: 'bad_request', message: "linkAccess must be 'restricted' or 'anyone'" });
    }
    await pool.query('UPDATE files SET link_access = $1 WHERE id = $2', [linkAccess, id]);
    res.json({ success: true, linkAccess });
  } catch (err) {
    console.error('Error updating file access:', err.message);
    res.status(500).json({ error: 'internal_server_error', message: 'Failed to update access' });
  }
});

/**
 * PUT /api/files/:id/star  { starred: boolean }
 * Adds or removes the file from the signed-in user's Starred list. Starring is a
 * personal, per-user favourite, so it only requires view access to the file (any
 * file the user can open, including the shared 'default' workbook).
 */
app.put('/api/files/:id/star', ensureAuthenticated, async (req, res) => {
  try {
    const id = req.params.id;
    if (!isValidFileId(id)) {
      return res.status(400).json({ error: 'bad_request', message: 'Invalid file id' });
    }
    if (!(await canViewFile(req.user, id))) {
      return res.status(403).json({ error: 'forbidden', message: 'You do not have access to this file' });
    }
    const userId = userIdentity(req.user);
    if (!userId) {
      return res.status(403).json({ error: 'forbidden', message: 'No user identity' });
    }
    const starred = !!(req.body && req.body.starred);
    if (starred) {
      await pool.query(
        'INSERT INTO file_stars (file_id, user_id) VALUES ($1, $2) ON CONFLICT (file_id, user_id) DO NOTHING',
        [id, userId]
      );
    } else {
      await pool.query('DELETE FROM file_stars WHERE file_id = $1 AND user_id = $2', [id, userId]);
    }
    res.json({ success: true, starred });
  } catch (err) {
    console.error('Error updating star:', err.message);
    res.status(500).json({ error: 'internal_server_error', message: 'Failed to update star' });
  }
});

/**
 * Shared helper function to validate a cell edit payload.
 * Verifies types, formats, string lengths, and style structures.
 * @param {*} cellId - The identifier of the cell (e.g. 'A1').
 * @param {*} formula - The cell's formula string.
 * @param {*} value - The cell's evaluated string value.
 * @param {*} style - The cell's formatting style options.
 * @returns {Object} An object containing { valid: boolean, message?: string }
 */
const validateCellPayload = (cellId, formula, value, style) => {
  // Validate that cellId is a non-empty string.
  if (typeof cellId !== 'string' || !cellId) {
    return { valid: false, message: 'cellId must be a valid non-empty string' };
  }

  // Explicitly prevent prototype pollution attacks by rejecting reserved property names.
  if (cellId === '__proto__' || cellId === 'constructor') {
    return { valid: false, message: 'Invalid cellId: Reserved property name' };
  }

  // Enforce cell ID schema format (columns A-ZZ, rows 1-999).
  const cellIdRegex = /^[A-Z]{1,2}[1-9][0-9]{0,2}$/;
  if (!cellIdRegex.test(cellId)) {
    return { valid: false, message: 'Invalid cellId format' };
  }

  // Validate formula if provided
  if (formula !== undefined) {
    if (typeof formula !== 'string' || formula.length > 200) {
      return { valid: false, message: 'formula must be a string up to 200 characters' };
    }
  }

  // Validate value if provided
  if (value !== undefined) {
    if (typeof value !== 'string' || value.length > 200) {
      return { valid: false, message: 'value must be a string up to 200 characters' };
    }
  }

  // Validate style if provided
  if (style !== undefined) {
    if (typeof style !== 'object' || style === null || Array.isArray(style)) {
      return { valid: false, message: 'style must be an object' };
    }
    const allowedKeys = ['bold', 'italic', 'underline', 'color', 'strikethrough', 'textColor', 'border', 'borders', 'align', 'link', 'verticalAlign', 'fontFamily', 'fontSize', 'numberFormat', 'textWrap'];
    const borderSides = ['top', 'right', 'bottom', 'left'];
    const borderStyles = ['thin', 'medium', 'thick', 'dashed', 'dotted', 'double'];
    const numberFormats = ['number', 'percent', 'scientific', 'accounting', 'financial', 'currency', 'currencyRounded'];
    const textWrapModes = ['overflow', 'wrap', 'clip'];
    for (const key of Object.keys(style)) {
      if (!allowedKeys.includes(key)) {
        return { valid: false, message: `Invalid style property: ${key}` };
      }
      // Validate boolean properties
      if (key === 'bold' || key === 'italic' || key === 'underline' || key === 'strikethrough' || key === 'border') {
        if (typeof style[key] !== 'boolean') {
          return { valid: false, message: `${key} must be a boolean` };
        }
      }
      // Validate number format key (null/absent means "automatic").
      if (key === 'numberFormat') {
        if (style[key] !== null && (typeof style[key] !== 'string' || !numberFormats.includes(style[key]))) {
          return { valid: false, message: 'numberFormat is invalid' };
        }
      }
      // Validate text-wrapping mode.
      if (key === 'textWrap') {
        if (typeof style[key] !== 'string' || !textWrapModes.includes(style[key])) {
          return { valid: false, message: "textWrap must be 'overflow', 'wrap', or 'clip'" };
        }
      }
      // Validate color HEX properties
      if (key === 'color' || key === 'textColor') {
        if (typeof style[key] !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(style[key])) {
          return { valid: false, message: `${key} must be a valid 6-character hex string starting with #` };
        }
      }
      // Validate structured per-side borders object. Each side is either null
      // (no border) or { color: '#rrggbb', style: <one of borderStyles> }.
      if (key === 'borders') {
        const borders = style[key];
        if (typeof borders !== 'object' || borders === null || Array.isArray(borders)) {
          return { valid: false, message: 'borders must be an object' };
        }
        for (const side of Object.keys(borders)) {
          if (!borderSides.includes(side)) {
            return { valid: false, message: `Invalid border side: ${side}` };
          }
          const spec = borders[side];
          if (spec === null) continue;
          if (typeof spec !== 'object' || Array.isArray(spec)) {
            return { valid: false, message: `border ${side} must be null or an object` };
          }
          for (const specKey of Object.keys(spec)) {
            if (specKey !== 'color' && specKey !== 'style') {
              return { valid: false, message: `Invalid border property: ${specKey}` };
            }
          }
          if (typeof spec.color !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(spec.color)) {
            return { valid: false, message: `border ${side} color must be a valid 6-character hex string` };
          }
          if (typeof spec.style !== 'string' || !borderStyles.includes(spec.style)) {
            return { valid: false, message: `border ${side} style is invalid` };
          }
        }
      }
      // Validate alignment property (left, center, or right)
      if (key === 'align') {
        if (typeof style[key] !== 'string' || !['left', 'center', 'right'].includes(style[key])) {
          return { valid: false, message: `align must be 'left', 'center', or 'right'` };
        }
      }
      // Validate hyperlink URL string (limit up to 200 chars)
      if (key === 'link') {
        if (typeof style[key] !== 'string' || style[key].length > 200) {
          return { valid: false, message: 'link must be a string up to 200 characters' };
        }
      }
      // Validate vertical alignment property (top, center, or bottom)
      if (key === 'verticalAlign') {
        if (typeof style[key] !== 'string' || !['top', 'center', 'bottom'].includes(style[key])) {
          return { valid: false, message: "verticalAlign must be 'top', 'center', or 'bottom'" };
        }
      }
      // Validate font family name (non-empty string up to 100 chars)
      if (key === 'fontFamily') {
        if (typeof style[key] !== 'string' || style[key].length === 0 || style[key].length > 100) {
          return { valid: false, message: 'fontFamily must be a string up to 100 characters' };
        }
      }
      // Validate font size (integer point value between 1 and 400)
      if (key === 'fontSize') {
        if (typeof style[key] !== 'number' || !Number.isInteger(style[key]) || style[key] < 1 || style[key] > 400) {
          return { valid: false, message: 'fontSize must be an integer between 1 and 400' };
        }
      }
    }
  }

  return { valid: true };
};

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

  // Run shared validation helper.
  const validation = validateCellPayload(cellId, formula, value, style);
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
  if (!wb.cells) {
    wb.cells = Object.create(null);
  }
  wb.cells[cellId] = { formula, value, style };
  persistWorkbook(fileId);
  res.json({ success: true, cells: wb.cells });
});

/**
 * GET /api/versions
 * Retrieves a list of all version history metadata, sorted by id DESC.
 * Only returns id, created_at, and created_by.
 * Protected with ensureAuthenticated middleware.
 */
app.get('/api/versions', ensureAuthenticated, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, created_at, created_by FROM workbook_versions ORDER BY id DESC'
    );
    const versions = result.rows.map(row => ({
      id: row.id,
      created_at: row.created_at,
      created_by: row.created_by
    }));
    res.json(versions);
  } catch (err) {
    console.error('Error fetching version history list:', err.message);
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
    const result = await pool.query(
      'SELECT state FROM workbook_versions WHERE id = $1',
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'not_found', message: 'Version not found' });
    }

    const versionState = result.rows[0].state;
    let parsedState = versionState;
    if (typeof parsedState === 'string') {
      parsedState = JSON.parse(parsedState);
    }
    res.json(parsedState);
  } catch (err) {
    console.error('Error retrieving version snapshot:', err.message);
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
    const result = await pool.query(
      'SELECT state FROM workbook_versions WHERE id = $1',
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'not_found', message: 'Version not found' });
    }

    const versionState = result.rows[0].state;
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

    // Overwrite the active spreadsheet state in memory
    sheetState = setupCellsProxy({
      sheets,
      sheetOrder: Array.isArray(targetState.sheetOrder) ? targetState.sheetOrder : Object.keys(sheets),
      sheetColors: (targetState.sheetColors && typeof targetState.sheetColors === 'object') ? targetState.sheetColors : Object.create(null),
      hiddenSheets: Array.isArray(targetState.hiddenSheets) ? targetState.hiddenSheets : []
    });

    // Save the updated state to the active workbook_state database
    await saveState();

    // Log the restoration event in the version history table
    const creator = req.user ? req.user.username : 'anonymous';
    await pool.query(
      'INSERT INTO workbook_versions (state, created_by) VALUES ($1, $2)',
      [JSON.stringify(sheetState), creator]
    );

    // Broadcast the restored init state to all active connected WebSocket clients
    const initPayload = {
      type: 'init',
      payload: {
        sheets: sheetState.sheets,
        sheetOrder: sheetState.sheetOrder,
        sheetColors: sheetState.sheetColors,
        hiddenSheets: sheetState.hiddenSheets,
        cells: sheetState.cells,
        users: Array.from(activeUsers.entries()).map(([uid, info]) => ({
          userId: uid,
          username: info.username,
          color: info.color,
          activeCell: info.activeCell,
          activeSheet: info.activeSheet || 'Sheet1'
        }))
      }
    };

    for (const [uid, info] of activeUsers) {
      if (info.ws.readyState === WebSocket.OPEN) {
        info.ws.send(JSON.stringify(initPayload));
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Error restoring version:', err.message);
    res.status(500).json({ error: 'internal_server_error', message: 'Failed to restore version' });
  }
});

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    // Disable caching to guarantee immediate client updates during testing/development.
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
}));

// Server instance declaration for HTTP/WebSocket handling.
let server;

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
const wss = new WebSocketServer({ noServer: true });

// Run database initialization and start the HTTP server with WebSocket upgrade
// support. `ready` resolves once the server is actually listening, so importers
// (e.g. tests that load the module in-process) can await startup and then close
// the server deterministically instead of racing the detached startup.
const ready = (async () => {
  try {
    // Perform database initialization and table provisioning on startup.
    await initDatabase();
    sheetState = await loadState();

    // Create the HTTP server and attach handlers before it begins listening.
    server = app.listen(PORT);

    // Clean up background timers and resources when the server is closed.
    server.on('close', () => {
      if (typeof autosaveInterval !== 'undefined') {
        clearInterval(autosaveInterval);
      }
    });

    // Attach Upgrade handler to the HTTP server for WebSocket handshakes.
    server.on('upgrade', (request, socket, head) => {
      // Extract and parse session cookie for security
      let sessionUser = null;
      const cookieHeader = request.headers.cookie;

      if (cookieHeader) {
        // Search for the connect.sid session cookie
        const match = cookieHeader.match(/connect\.sid=([^;]+)/);
        if (match) {
          const cookieVal = decodeURIComponent(match[1]);
          if (cookieVal.startsWith('s:')) {
            const signedVal = cookieVal.slice(2);
            // Unsign the session cookie using the session secret
            const sessionId = unsign(signedVal, 'co-sheet-secret-key-123');
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
    console.log(`Server running on port ${PORT}`);
    registerStrategies();
    return server;
  } catch (err) {
    console.error('Database initialization or server startup failed:', err);
    process.exit(1);
  }
})();

// Map to maintain details of active connected users: wsId -> { ws, username, color, activeCell }
const activeUsers = new Map();

// Autosave state tracking variables for periodic workbook version snapshots.
let pendingChanges = false;
const currentEditors = new Set();
let lastEditTime = Date.now();
let lastVersionTime = Date.now();

// Configuration thresholds loaded from environment variables with defaults.
const AUTOSAVE_CHECK_INTERVAL = parseInt(process.env.AUTOSAVE_CHECK_INTERVAL || '10000', 10);
const AUTOSAVE_INACTIVITY_LIMIT = parseInt(process.env.AUTOSAVE_INACTIVITY_LIMIT || '60000', 10);
const AUTOSAVE_ACTIVE_LIMIT = parseInt(process.env.AUTOSAVE_ACTIVE_LIMIT || '300000', 10);

// Setup the periodic check interval for the autosave engine.
// In each tick, if there are pending changes, we check if the inactivity limit or active limit is met.
const autosaveInterval = setInterval(async () => {
  if (pendingChanges) {
    const now = Date.now();

    // Verify if either inactivity or active work time threshold is reached.
    const isInactive = now - lastEditTime >= AUTOSAVE_INACTIVITY_LIMIT;
    const isActiveLimitReached = now - lastVersionTime >= AUTOSAVE_ACTIVE_LIMIT;

    if (isInactive || isActiveLimitReached) {
      try {
        // Construct the editors string using comma and space separator.
        const editorsString = currentEditors.size > 0 ? Array.from(currentEditors).join(', ') : 'anonymous';
        
        // Create a new version snapshot in workbook_versions database table.
        await pool.query(
          'INSERT INTO workbook_versions (state, created_by) VALUES ($1, $2)',
          [JSON.stringify(sheetState), editorsString]
        );
        
        console.log(`[Autosave] Created version snapshot. Editors: ${editorsString}`);

        // Reset tracking variables upon successful snapshot creation.
        pendingChanges = false;
        currentEditors.clear();
        lastVersionTime = now;
      } catch (err) {
        console.error('[Autosave] Error creating version snapshot:', err);
      }
    }
  }
}, AUTOSAVE_CHECK_INTERVAL);

// Prevent the interval from keeping the Node.js event loop active during tests/shutdown.
if (typeof autosaveInterval.unref === 'function') {
  autosaveInterval.unref();
}

// Color palette for user cursor highlights (from co-sheet design layout specs).
const userColors = ['#1471e6', '#1e8e3e', '#d93025', '#e37400', '#a142f4', '#f06292'];

// Handle incoming WebSocket connection requests.
wss.on('connection', async (ws, req) => {
  // Generate a unique identifier for the connection socket.
  const wsId = Math.random().toString(36).substring(2, 9);

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
  // Persist whichever workbook this connection edits.
  const persist = () => persistWorkbook(fileId);

  // Resolve whether this connection may make changes. The shared 'default' workbook
  // stays editable by anyone; for other files only the owner / admins / super admins
  // can edit. Unauthorized clients still connect (read-only + presence) but their
  // state-changing messages are ignored. Computed once at connect time.
  const canEdit = await canModifyFile(sessionUser, fileId);

  console.log(`[WS Server] Connected: ${username} (${wsId}) on file ${fileId} (canEdit=${canEdit})`);

  // Assign a custom cursor color dynamically using modulo on user count.
  const color = userColors[activeUsers.size % userColors.length];

  // Store user connection state details in our memory map (scoped by file id).
  activeUsers.set(wsId, { ws, username, color, activeCell: null, fileId });

  // 1. Send the initialization payload ('init') for THIS connection's workbook only.
  ws.send(JSON.stringify({
    type: 'init',
    payload: {
      sheets: connWorkbook.sheets,
      sheetOrder: connWorkbook.sheetOrder,
      sheetColors: connWorkbook.sheetColors,
      hiddenSheets: connWorkbook.hiddenSheets,
      cells: connWorkbook.cells, // Maintain for client compatibility
      canEdit, // whether THIS client is permitted to modify the workbook
      users: Array.from(activeUsers.entries())
        .filter(([id, info]) => info.fileId === fileId)
        .map(([id, info]) => ({
          userId: id,
          username: info.username,
          color: info.color,
          activeCell: info.activeCell,
          activeSheet: info.activeSheet || 'Sheet1'
        }))
    }
  }));

  /**
   * Broadcast a message to all OTHER clients editing the SAME file.
   * @param {Object} msg - The JSON message to broadcast.
   */
  const broadcast = (msg) => {
    for (const [id, info] of activeUsers) {
      if (id !== wsId && info.fileId === fileId && info.ws.readyState === WebSocket.OPEN) {
        info.ws.send(JSON.stringify(msg));
      }
    }
  };

  /**
   * Broadcast a message to all clients editing the SAME file (including sender).
   * @param {Object} msg - The JSON message to broadcast.
   */
  const broadcastToAll = (msg) => {
    for (const [id, info] of activeUsers) {
      if (info.fileId === fileId && info.ws.readyState === WebSocket.OPEN) {
        info.ws.send(JSON.stringify(msg));
      }
    }
  };

  // 2. Broadcast a cursor-update message notifying other clients of this user's presence.
  broadcast({
    type: 'cursor-update',
    payload: { userId: wsId, username, color, activeCell: null, activeSheet: 'Sheet1' }
  });

  // Handle incoming WebSocket message events.
  ws.on('message', (message) => {
    console.log(`[WS Server] Message from ${username} (${wsId}): ${message}`);
    try {
      const { type, payload } = JSON.parse(message);

      // Bind this connection's workbook to the `sheetState` name for the remainder of
      // the handler so the existing logic operates on the correct file. For 'default'
      // this is the live global workbook; otherwise it is this file's cached workbook.
      // Likewise route `saveState()` calls to persist the right workbook.
      const sheetState = (fileId === 'default') ? getDefaultState() : connWorkbook;
      const saveState = persist;

      // Track client edits and workbook state modifications for the autosave engine.
      // Autosave/version snapshots currently apply to the default workbook only.
      const stateChangingTypes = [
        'cell-edit',
        'add-sheet',
        'delete-sheet',
        'copy-sheet',
        'rename-sheet',
        'color-sheet',
        'hide-sheet',
        'unhide-sheet',
        'reorder-sheets'
      ];
      // Enforce file-level write access: clients without edit permission on this
      // file may still move their cursor (presence) but cannot change state.
      if (!canEdit && stateChangingTypes.includes(type)) {
        return;
      }

      if (fileId === 'default' && stateChangingTypes.includes(type)) {
        pendingChanges = true;
        currentEditors.add(username);
        lastEditTime = Date.now();
      }
      
      // Handle client cell cursor navigation.
      if (type === 'cursor-move') {
        const info = activeUsers.get(wsId);
        if (info) {
          // Verify that the sheetName is a string matching /^[a-zA-Z0-9 ]{2,30}$/ and exists in sheetState.sheets before assigning it.
          const sheetName = payload.sheetName;
          if (typeof sheetName === 'string' && /^[\p{L}\p{N} ]{2,30}$/u.test(sheetName) && sheetState.sheets && sheetState.sheets[sheetName]) {
            info.activeSheet = sheetName;
          } else {
            info.activeSheet = 'Sheet1';
          }

          // Check that cellId is either null or matches the standard cell ID regex /^[A-Z]{1,2}[1-9][0-9]{0,2}$/ before updating.
          const cellId = payload.cellId;
          if (cellId === null || (typeof cellId === 'string' && /^[A-Z]{1,2}[1-9][0-9]{0,2}$/.test(cellId))) {
            info.activeCell = cellId;
          }
          
          // Broadcast cursor position and active sheet changes to all other connected clients.
          broadcast({
            type: 'cursor-update',
            payload: {
              userId: wsId,
              username: info.username,
              color: info.color,
              activeCell: info.activeCell,
              activeSheet: info.activeSheet
            }
          });
        }
      }
      
      // Handle client cell text/formula updates.
      if (type === 'cell-edit') {
        // Set pending changes flag, record the editor, and update edit time for the autosave engine
        // (default workbook only; per-file autosave snapshots are out of scope this pass).
        if (fileId === 'default') {
          pendingChanges = true;
          currentEditors.add(username);
          lastEditTime = Date.now();
        }

        const { cellId, formula, value, style, sheetName } = payload;
        const sheet = sheetName || 'Sheet1';
        
        // Validate sheetName matches regex /^[a-zA-Z0-9 ]{2,30}$/ and exists in sheetState.sheets.
        if (typeof sheet === 'string' && /^[\p{L}\p{N} ]{2,30}$/u.test(sheet) && sheetState.sheets && sheetState.sheets[sheet]) {
          // Perform full payload validation using shared helper.
          const validation = validateCellPayload(cellId, formula, value, style);
          if (validation.valid) {
            sheetState.sheets[sheet][cellId] = { formula, value, style };
            
            // Save updated state asynchronously and atomically to file store.
            saveState();
            
            // Broadcast cell state changes to all other connected clients.
            broadcast({
              type: 'cell-update',
              payload: { cellId, formula, value, style, sheetName: sheet }
            });
          }
        }
      }

      // Handle sheet creation event.
      if (type === 'add-sheet') {
        const { sheetName } = payload;
        
        // Validate sheetName is a string, and is alphanumeric (2 to 30 characters).
        if (typeof sheetName === 'string' && /^[\p{L}\p{N} ]{2,30}$/u.test(sheetName)) {
          if (!sheetState.sheets[sheetName]) {
            // Initialize sheetState.sheets[sheetName] to a prototype-free object to prevent prototype pollution.
            sheetState.sheets[sheetName] = Object.create(null);
            
            // Update sheet order list
            if (!sheetState.sheetOrder.includes(sheetName)) {
              sheetState.sheetOrder.push(sheetName);
            }
            
            // Save updated state asynchronously and atomically to file store.
            saveState();
            
            // Broadcast add-sheet event containing the new sheetName and sheetOrder to all clients.
            broadcastToAll({
              type: 'add-sheet',
              payload: { sheetName, sheetOrder: sheetState.sheetOrder }
            });
          }
        }
      }

      // Handle sheet deletion event.
      if (type === 'delete-sheet') {
        const { sheetName } = payload;
        
        // Validate sheet exists and we keep at least one visible sheet.
        if (sheetState.sheets[sheetName] && sheetState.sheetOrder.length > 1) {
          // Remove the sheet from memory and state lists
          delete sheetState.sheets[sheetName];
          sheetState.sheetOrder = sheetState.sheetOrder.filter(s => s !== sheetName);
          if (sheetState.sheetColors[sheetName]) {
            delete sheetState.sheetColors[sheetName];
          }
          sheetState.hiddenSheets = sheetState.hiddenSheets.filter(s => s !== sheetName);
          
          // Save updated state asynchronously and atomically to file store.
          saveState();
          
          // Switch users on deleted sheet to another visible sheet
          for (const [id, info] of activeUsers) {
            if (info.activeSheet === sheetName) {
              const nextSheet = sheetState.sheetOrder.find(s => !sheetState.hiddenSheets.includes(s)) || 'Sheet1';
              info.activeSheet = nextSheet;
              info.activeCell = null;
            }
          }
          
          // Broadcast the sheet deletion event to all clients.
          broadcastToAll({ type: 'delete-sheet', payload: { sheetName } });
        }
      }

      // Handle sheet copy event.
      if (type === 'copy-sheet') {
        const { sheetName } = payload;
        
        // Check if the source sheet exists.
        if (sheetState.sheets[sheetName]) {
          // Generate a unique copy name (e.g. "Sheet1 (Copy)" or "Sheet1 (Copy) 2")
          let copyName = `${sheetName} (Copy)`;
          let suffix = 2;
          while (sheetState.sheets[copyName]) {
            copyName = `${sheetName} (Copy) ${suffix}`;
            suffix++;
          }
          
          // Clone cells map securely
          sheetState.sheets[copyName] = JSON.parse(JSON.stringify(sheetState.sheets[sheetName]));
          
          // Insert the copied sheet directly after the parent in the order list.
          const originalIndex = sheetState.sheetOrder.indexOf(sheetName);
          sheetState.sheetOrder.splice(originalIndex + 1, 0, copyName);
          
          // Save updated state asynchronously and atomically to file store.
          saveState();
          
          // Broadcast add-sheet event with new sheetName, sheetOrder, and cloned cells to all clients.
          broadcastToAll({
            type: 'add-sheet',
            payload: { 
              sheetName: copyName, 
              sheetOrder: sheetState.sheetOrder,
              cells: sheetState.sheets[copyName]
            }
          });
        }
      }

      // Handle sheet rename event.
      if (type === 'rename-sheet') {
        const { oldName, newName } = payload;
        
        // Validate oldName exists, newName is alphanumeric (2 to 30 characters), and newName is not already used.
        if (sheetState.sheets[oldName] && typeof newName === 'string' && /^[\p{L}\p{N} ]{2,30}$/u.test(newName) && !sheetState.sheets[newName]) {
          // Rename the sheet entry key
          sheetState.sheets[newName] = sheetState.sheets[oldName];
          delete sheetState.sheets[oldName];
          
          // Update order and hidden list mapping
          sheetState.sheetOrder = sheetState.sheetOrder.map(s => s === oldName ? newName : s);
          if (sheetState.sheetColors[oldName]) {
            sheetState.sheetColors[newName] = sheetState.sheetColors[oldName];
            delete sheetState.sheetColors[oldName];
          }
          sheetState.hiddenSheets = sheetState.hiddenSheets.map(s => s === oldName ? newName : s);
          
          // Save updated state asynchronously and atomically to file store.
          saveState();
          
          // Update active users
          for (const [id, info] of activeUsers) {
            if (info.activeSheet === oldName) {
              info.activeSheet = newName;
            }
          }
          
          // Broadcast rename-sheet event to all clients.
          broadcastToAll({ type: 'rename-sheet', payload: { oldName, newName } });
        }
      }

      // Handle sheet tab color event.
      if (type === 'color-sheet') {
        const { sheetName, color } = payload;
        
        // Verify sheet exists
        if (sheetState.sheets[sheetName]) {
          // Validate color is either null (reset) or a valid hex color format.
          if (color === null || (typeof color === 'string' && /^#[0-9A-Fa-f]{6}$/.test(color))) {
            if (color === null) {
              delete sheetState.sheetColors[sheetName];
            } else {
              sheetState.sheetColors[sheetName] = color;
            }
            
            // Save updated state asynchronously and atomically to file store.
            saveState();
            
            // Broadcast color-sheet event to all clients.
            broadcastToAll({ type: 'color-sheet', payload: { sheetName, color } });
          }
        }
      }

      // Handle sheet hide event.
      if (type === 'hide-sheet') {
        const { sheetName } = payload;
        
        // Ensure sheet exists and is not already hidden
        if (sheetState.sheets[sheetName] && !sheetState.hiddenSheets.includes(sheetName)) {
          const visibleCount = sheetState.sheetOrder.filter(s => !sheetState.hiddenSheets.includes(s)).length;
          // Ensure we don't hide the last visible sheet
          if (visibleCount > 1) {
            sheetState.hiddenSheets.push(sheetName);
            
            // Save updated state asynchronously and atomically to file store.
            saveState();
            
            // Move active users on hidden sheet to another visible sheet
            for (const [id, info] of activeUsers) {
              if (info.activeSheet === sheetName) {
                const nextSheet = sheetState.sheetOrder.find(s => !sheetState.hiddenSheets.includes(s)) || 'Sheet1';
                info.activeSheet = nextSheet;
                info.activeCell = null;
              }
            }
            
            // Broadcast hide-sheet event to all clients.
            broadcastToAll({ type: 'hide-sheet', payload: { sheetName } });
          }
        }
      }

      // Handle sheet unhide event.
      if (type === 'unhide-sheet') {
        const { sheetName } = payload;
        
        // Verify sheet is currently hidden
        if (sheetState.hiddenSheets.includes(sheetName)) {
          sheetState.hiddenSheets = sheetState.hiddenSheets.filter(s => s !== sheetName);
          
          // Save updated state asynchronously and atomically to file store.
          saveState();
          
          // Broadcast unhide-sheet event to all clients.
          broadcastToAll({ type: 'unhide-sheet', payload: { sheetName } });
        }
      }

      // Handle sheet reordering event.
      if (type === 'reorder-sheets') {
        const { sheetOrder } = payload;
        
        // Validate new sheet order structure and containing elements
        if (Array.isArray(sheetOrder) && sheetOrder.length === sheetState.sheetOrder.length &&
            sheetOrder.every(s => sheetState.sheetOrder.includes(s))) {
          sheetState.sheetOrder = sheetOrder;
          
          // Save updated state asynchronously and atomically to file store.
          saveState();
          
          // Broadcast reorder-sheets event with the new order list to all clients.
          broadcastToAll({ type: 'reorder-sheets', payload: { sheetOrder } });
        }
      }
    } catch (e) {
      console.error('WebSocket message parsing error:', e.message);
    }
  });

  // Handle connection termination / socket closure.
  ws.on('close', () => {
    console.log(`[WS Server] Closed: ${username} (${wsId})`);
    // Remove user entry from active users registry.
    activeUsers.delete(wsId);
    
    // Broadcast user leaving event to alert other connected clients.
    broadcast({
      type: 'user-leave',
      payload: { userId: wsId }
    });
  });
});

// Export database pool, initialization function, and server instance for integration tests.
export { pool, initDatabase, server, ready };
