// @ts-check
import http from 'http';
import client from 'prom-client';
import { component } from './logger.js';

/**
 * @file services/metrics.js
 * @description Prometheus metrics for co-sheet. Exposes a `/metrics` endpoint on a
 * SEPARATE HTTP server (its own port) so scraping is isolated from the public app
 * surface — the metrics port can be firewalled to the monitoring network and never
 * shares auth/session middleware with the application traffic.
 *
 * The whole subsystem is opt-in: nothing is collected and no server is started
 * unless METRICS_PORT is set to a valid port (see {@link metricsPort}). This keeps
 * local development and the test suite at zero overhead by default.
 *
 * Exposed series (in addition to prom-client's default Node/process metrics — GC,
 * heap, event-loop lag, CPU, open FDs):
 *   - http_request_duration_seconds  Histogram of request latency, labeled by
 *                                    method / route (the matched Express pattern,
 *                                    e.g. `/api/users/:id`) / status.
 *   - ws_active_connections          Gauge of live WebSocket clients on this instance.
 *   - active_users                   Gauge of tracked collaborators on this instance.
 *   - db_up / redis_up               Gauges (1/0) sampled at scrape time, mirroring
 *                                    the readyz dependency checks.
 *
 * Metrics live in a private Registry (not the global default) so importing this
 * module has no side effects until wired up by the server.
 */

const metricsLog = component('metrics');

// A dedicated registry keeps our series isolated from prom-client's global default
// registry, so nothing is collected merely by importing this module.
const register = new client.Registry();
register.setDefaultLabels({ app: 'co-sheet' });

// Node/process metrics (GC, heap, event-loop lag, CPU, file descriptors, …).
client.collectDefaultMetrics({ register });

const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds, labeled by method, route and status.',
  labelNames: ['method', 'route', 'status'],
  // Web-request oriented buckets: 5ms up to 10s.
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

const wsActiveConnections = new client.Gauge({
  name: 'ws_active_connections',
  help: 'Number of live WebSocket connections on this instance.',
  registers: [register],
});

const activeUsers = new client.Gauge({
  name: 'active_users',
  help: 'Number of tracked collaborators (presence entries) on this instance.',
  registers: [register],
});

const dbUp = new client.Gauge({
  name: 'db_up',
  help: 'Whether Postgres was reachable at the last scrape (1 = up, 0 = down).',
  registers: [register],
});

const redisUp = new client.Gauge({
  name: 'redis_up',
  help: 'Whether the realtime bus / Redis was reachable at the last scrape (1 = up, 0 = down). Always 1 in single-instance mode.',
  registers: [register],
});

/**
 * Resolve the configured metrics port, or null when metrics are disabled. Enabled
 * only when METRICS_PORT is set to an integer in the valid TCP range.
 * @returns {number|null}
 */
export function metricsPort() {
  const raw = process.env.METRICS_PORT;
  if (raw === undefined || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}

/**
 * Whether the Prometheus metrics subsystem is enabled (METRICS_PORT is set).
 * @returns {boolean}
 */
export const isMetricsEnabled = () => metricsPort() !== null;

/**
 * Express middleware that records the duration and outcome of every HTTP request.
 * The route label uses the matched Express route pattern (e.g. `/api/users/:id`)
 * rather than the raw URL, so path parameters like file/user ids do not explode
 * label cardinality; unmatched requests are bucketed under `unmatched`.
 * @param {any} req  Express request.
 * @param {any} res  Express response.
 * @param {() => void} next
 */
export function httpMetricsMiddleware(req, res, next) {
  const endTimer = httpRequestDuration.startTimer();
  res.on('finish', () => {
    // req.route is populated once a route matches; fall back for 404s / unmatched.
    const route = (req.route && req.route.path)
      ? `${req.baseUrl || ''}${req.route.path}`
      : 'unmatched';
    endTimer({ method: req.method, route, status: res.statusCode });
  });
  next();
}

/**
 * Start the metrics HTTP server on METRICS_PORT. Returns null (and does nothing)
 * when metrics are disabled. The runtime gauges are sampled at scrape time via the
 * supplied providers, so they always reflect current state without a background
 * timer.
 *
 * @param {Object} providers
 * @param {() => number} providers.getWsConnectionCount  Live WebSocket client count.
 * @param {() => number} providers.getActiveUserCount    Tracked collaborator count.
 * @param {() => Promise<boolean>} providers.checkDb      Resolves true if Postgres is reachable.
 * @param {() => Promise<boolean>} providers.checkRedis   Resolves true if the bus/Redis is reachable.
 * @returns {import('http').Server|null} The metrics server, or null if disabled.
 */
export function startMetricsServer(providers) {
  const port = metricsPort();
  if (port === null) return null;

  const server = http.createServer(async (req, res) => {
    if (req.method !== 'GET' || !req.url || req.url.split('?')[0] !== '/metrics') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }
    try {
      // Sample the runtime gauges at scrape time.
      wsActiveConnections.set(providers.getWsConnectionCount());
      activeUsers.set(providers.getActiveUserCount());
      const [db, redis] = await Promise.all([providers.checkDb(), providers.checkRedis()]);
      dbUp.set(db ? 1 : 0);
      redisUp.set(redis ? 1 : 0);

      const body = await register.metrics();
      res.writeHead(200, { 'Content-Type': register.contentType });
      res.end(body);
    } catch (err) {
      metricsLog.error({ err }, 'Failed to render metrics');
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Server Error');
    }
  });

  // Don't let the metrics listener hold the event loop open on shutdown.
  server.on('error', (err) => metricsLog.error({ err }, 'Metrics server error'));
  server.listen(port, () => metricsLog.info(`Metrics server running on port ${port}`));
  return server;
}

export { register };
