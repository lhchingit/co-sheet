// @ts-check
/**
 * @file services/rate-limit.js
 * @description express-rate-limit limiters for the authentication and state-changing
 * API routes.
 *
 * The counters are backed by a shared Redis store when REDIS_URL is configured, so a
 * limit is enforced GLOBALLY across every app instance. An in-memory store would give
 * each replica its own counter, multiplying the effective limit by the replica count
 * and letting the load balancer's routing decide which limit a request hits — useless
 * for brute-force protection. Without Redis (single instance / local / tests) it falls
 * back to the library's in-memory store, mirroring how the session store and realtime
 * bus already degrade.
 */
import { rateLimit } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';

/**
 * Adapt a node-redis client to the flat `sendCommand(...args)` shim rate-limit-redis
 * expects. A single-node client takes the command as one array argument; a cluster
 * client instead takes `(firstKey, isReadonly, args)` so it can route the command to
 * the node that owns the key's hash slot.
 *
 * @param {any} client       connected node-redis client (single or cluster)
 * @param {boolean} cluster  whether `client` is a cluster client
 * @returns {(...args: string[]) => Promise<any>}
 */
function makeSendCommand(client, cluster) {
  if (!cluster) return (...args) => client.sendCommand(args);
  return (...args) => {
    // rate-limit-redis issues: `SCRIPT LOAD <src>`, `EVALSHA <sha> 1 <key> ...`,
    // `EVAL <src> 1 <key> ...`, and simple keyed commands (`GET`/`DEL <key>`). Route
    // by the real key so the node owning its slot runs the script. A keyless
    // `SCRIPT LOAD` may land on any node, which is harmless: rate-limit-redis falls
    // back to `EVAL` (which carries the key) when `EVALSHA` returns NOSCRIPT.
    const cmd = String(args[0]).toUpperCase();
    let firstKey;
    if (cmd === 'EVAL' || cmd === 'EVALSHA') firstKey = args[3];
    else if (cmd === 'SCRIPT') firstKey = 'rate-limit';
    else firstKey = args[1];
    return client.sendCommand(firstKey, false, args);
  };
}

/**
 * Build the store for a limiter: a Redis-backed store when a client is supplied,
 * otherwise `undefined` so express-rate-limit uses its default in-memory store.
 *
 * @param {{ redisClient: any, cluster: boolean, prefix: string }} opts
 */
function buildStore({ redisClient, cluster, prefix }) {
  if (!redisClient) return undefined;
  return new RedisStore({ prefix, sendCommand: makeSendCommand(redisClient, cluster) });
}

/**
 * Create the auth and write limiters. Both share one Redis client; distinct key
 * prefixes keep their counters separate.
 *
 * When `enabled` is false the limiters are inert (they `skip` every request) but are
 * still real middleware in the chain — so they can be mounted unconditionally while
 * only actually throttling where wanted (production by default). This keeps local
 * development and the test suite free of rate limiting.
 *
 * @param {{ redisClient?: any, cluster?: boolean, enabled?: boolean }} [opts]
 * @returns {{ authLimiter: import('express').RequestHandler, writeLimiter: import('express').RequestHandler }}
 */
export function createRateLimiters({ redisClient = null, cluster = false, enabled = true } = {}) {
  const common = {
    windowMs: 15 * 60 * 1000,
    standardHeaders: 'draft-7',
    legacyHeaders: false
  };

  // Brute-force protection for the login / OIDC / OAuth-callback endpoints. Keyed by
  // client IP (there is no authenticated user yet), so a correct `req.ip` behind a
  // proxy depends on `trust proxy` being configured (see TRUST_PROXY in server.js).
  const authLimiter = rateLimit({
    ...common,
    limit: 30, // per IP per 15 min
    message: { error: 'Too many authentication attempts, please try again later.' },
    skip: () => !enabled,
    store: buildStore({ redisClient, cluster, prefix: 'cosheet:rl:auth:' })
  });

  // Throttle state-changing API calls. Reads are not limited (scope chosen
  // deliberately). Authenticated writes are keyed by the stable username so users
  // sharing a NAT/IP are not throttled collectively; anonymous callers fall back to IP.
  const writeLimiter = rateLimit({
    ...common,
    windowMs: 60 * 1000,
    limit: 120, // per user (or IP) per minute
    message: { error: 'Too many requests, please slow down.' },
    skip: (req) => !enabled || req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS',
    keyGenerator: (req) => (req.user && req.user.username) ? `u:${req.user.username}` : req.ip,
    store: buildStore({ redisClient, cluster, prefix: 'cosheet:rl:write:' })
  });

  return { authLimiter, writeLimiter };
}
