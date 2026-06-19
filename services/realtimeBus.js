// @ts-check

/**
 * @file realtimeBus.js
 * @description Cross-instance message bus for the collaborative editor.
 *
 * Single-instance deployments need nothing here: the WebSocket server fans out
 * edits to the sockets it holds in-process. Once more than one app instance runs
 * behind a load balancer, each instance only holds *its own* sockets, so edits
 * and presence made on instance A never reach the clients connected to instance
 * B. This bus closes that gap with Redis pub/sub: every instance publishes its
 * outbound messages to a shared channel and applies the messages it receives
 * from the *other* instances to its own local sockets.
 *
 * The bus is intentionally transport-only. It does not understand spreadsheet
 * ops or presence; server.js owns that and uses publish()/onMessage() to relay.
 *
 * When no REDIS_URL is configured the bus stays in "local mode": publish() is a
 * no-op and nothing is ever received, so behavior is byte-for-byte identical to
 * the original single-instance server.
 */

import crypto from 'crypto';

/** Channel all instances publish/subscribe on for realtime fan-out. */
const RT_CHANNEL = 'cosheet:rt';

/**
 * Normalize Redis connection config from env-style inputs. Returns null when no
 * URL is configured (single-instance / local mode).
 *
 * `redisUrl` may be a single URL or a comma-separated list of seed node URLs
 * (useful for a cluster). TLS (`rediss://`) and credentials are taken from the URL.
 *
 * @param {{ redisUrl?: string, cluster?: boolean }} opts
 * @returns {{ cluster: boolean, nodes: string[] } | null}
 */
export function resolveRedisOptions({ redisUrl, cluster } = {}) {
  if (!redisUrl) return null;
  const nodes = redisUrl.split(',').map((s) => s.trim()).filter(Boolean);
  if (nodes.length === 0) return null;
  return { cluster: !!cluster, nodes };
}

/**
 * Create (but do not connect) a node-redis client for the given config. Returns a
 * cluster client when `config.cluster` is set, otherwise a single-node client.
 * Shared by the realtime bus and the session store so cluster handling lives in
 * one place.
 *
 * @param {{ cluster: boolean, nodes: string[] }} config
 * @returns {Promise<any>}
 */
export async function createRedisClient(config) {
  const { createClient, createCluster } = await import('redis');
  if (config.cluster) {
    // A cluster client routes keyed commands by hash slot and follows MOVED/ASK
    // redirects; a single-node client cannot, so this is required for a true
    // (cluster-mode-enabled) Redis Cluster. Seeds bootstrap topology via CLUSTER SLOTS.
    return createCluster({ rootNodes: config.nodes.map((url) => ({ url })) });
  }
  return createClient({ url: config.nodes[0] });
}

/**
 * @typedef {Object} RealtimeBus
 * @property {string} instanceId      Unique id for this process (tags outbound messages).
 * @property {boolean} enabled        True once connected to Redis (multi-instance mode).
 * @property {() => Promise<void>} init
 * @property {(msg: object) => void} publish
 * @property {(handler: (msg: object) => void) => void} onMessage
 * @property {(key: string, ttlMs: number) => Promise<boolean>} acquireLock
 * @property {() => Promise<boolean>} ping
 * @property {() => Promise<void>} close
 */

/**
 * Create a realtime bus. Call init() once at startup; if redisUrl is falsy the
 * bus runs in local (no-op) mode.
 *
 * @param {{ redisUrl?: string, cluster?: boolean, logger?: Pick<Console, 'log'|'error'> }} [opts]
 * @returns {RealtimeBus}
 */
export function createRealtimeBus({ redisUrl, cluster = false, logger = console } = {}) {
  const instanceId = crypto.randomBytes(8).toString('hex');
  const config = resolveRedisOptions({ redisUrl, cluster });

  /** @type {((msg: object) => void) | null} */
  let handler = null;
  /** @type {any} */
  let pub = null;
  /** @type {any} */
  let sub = null;
  let enabled = false;

  /**
   * Connect to Redis and start receiving. No-op (local mode) when redisUrl is unset.
   */
  async function init() {
    if (!config) {
      logger.log('[realtime] no REDIS_URL set — single-instance (local) mode');
      return;
    }
    pub = await createRedisClient(config);
    // Pub/sub needs a connection dedicated to subscribing. For a single node we can
    // duplicate the publisher; for a cluster we create a second cluster client.
    sub = config.cluster ? await createRedisClient(config) : pub.duplicate();
    pub.on('error', (/** @type {Error} */ e) => logger.error('[realtime] redis publisher error:', e.message));
    sub.on('error', (/** @type {Error} */ e) => logger.error('[realtime] redis subscriber error:', e.message));

    await pub.connect();
    await sub.connect();

    // node-redis exposes the same subscribe()/publish() API on single and cluster
    // clients. On a cluster, classic pub/sub still propagates a published message
    // cluster-wide, so a subscriber on any node receives it.
    await sub.subscribe(RT_CHANNEL, (/** @type {string} */ raw) => {
      try {
        const env = JSON.parse(raw);
        // Ignore our own echoes — we already delivered these to local sockets.
        if (env.from === instanceId) return;
        if (handler) handler(env.msg);
      } catch (e) {
        logger.error('[realtime] dropping malformed message:', /** @type {Error} */ (e).message);
      }
    });

    enabled = true;
    logger.log(`[realtime] connected to Redis (${config.cluster ? 'cluster' : 'single'}) — multi-instance mode (instance ${instanceId})`);
  }

  /**
   * Publish a message to the other instances. No-op in local mode.
   * @param {object} msg
   */
  function publish(msg) {
    if (!enabled) return;
    pub
      .publish(RT_CHANNEL, JSON.stringify({ from: instanceId, msg }))
      .catch((/** @type {Error} */ e) => logger.error('[realtime] publish failed:', e.message));
  }

  /**
   * Register the handler invoked for every message from *other* instances.
   * @param {(msg: object) => void} fn
   */
  function onMessage(fn) {
    handler = fn;
  }

  /**
   * Best-effort distributed lock so only one instance performs a singleton task
   * (e.g. an autosave version snapshot) per window. Returns true if this instance
   * won the lock for ttlMs. Always returns true in local mode (no contention).
   * @param {string} key
   * @param {number} ttlMs
   * @returns {Promise<boolean>}
   */
  async function acquireLock(key, ttlMs) {
    if (!enabled) return true;
    try {
      const res = await pub.set(`cosheet:lock:${key}`, instanceId, { NX: true, PX: ttlMs });
      return res === 'OK';
    } catch (e) {
      logger.error('[realtime] lock acquisition failed:', /** @type {Error} */ (e).message);
      // Fail open: better to risk a duplicate snapshot than to skip it entirely.
      return true;
    }
  }

  /**
   * Health check for readiness probes. In local mode (no REDIS_URL) Redis is not
   * used, so there is nothing to fail — resolves true. When connected, issues a
   * PING and resolves true only if the server answers.
   * @returns {Promise<boolean>}
   */
  async function ping() {
    if (!config) return true; // local mode: Redis not required
    if (!enabled || !pub) return false; // configured but not yet/no longer connected
    try {
      const res = await pub.ping();
      // node-redis returns 'PONG'; cluster clients may return an array of replies.
      if (Array.isArray(res)) return res.every((r) => String(r).toUpperCase() === 'PONG');
      return String(res).toUpperCase() === 'PONG';
    } catch (e) {
      logger.error('[realtime] ping failed:', /** @type {Error} */ (e).message);
      return false;
    }
  }

  /** Tear down the Redis connections (used by tests/shutdown). */
  async function close() {
    try { if (sub) await sub.quit(); } catch { /* already closed */ }
    try { if (pub) await pub.quit(); } catch { /* already closed */ }
    enabled = false;
  }

  return {
    instanceId,
    get enabled() { return enabled; },
    init,
    publish,
    onMessage,
    acquireLock,
    ping,
    close,
  };
}
