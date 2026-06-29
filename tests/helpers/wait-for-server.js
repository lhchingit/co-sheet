/**
 * @file wait-for-server.js
 * @description Test helper: poll a freshly spawned `node server.js` until it is
 * actually listening, instead of waiting a fixed sleep. A fixed boot delay (the
 * old `setTimeout(…, 1000)`) races against a loaded CI runner's startup, so the
 * first request would intermittently hit ECONNREFUSED and fail the test. Any
 * HTTP response — even a redirect or 404 — means the listener is up.
 */
import http from 'http';

/**
 * Resolves once the server on `port` accepts an HTTP connection, or rejects
 * after `timeoutMs`.
 * @param {number|string} port
 * @param {{ timeoutMs?: number, path?: string, intervalMs?: number }} [opts]
 * @returns {Promise<void>}
 */
export function waitForServer(port, { timeoutMs = 15000, path = '/', intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get({ host: '127.0.0.1', port, path }, (res) => {
        res.resume(); // drain so the socket can close
        resolve();
      });
      req.on('error', () => {
        if (Date.now() >= deadline) {
          reject(new Error(`server on :${port} did not become ready within ${timeoutMs}ms`));
        } else {
          setTimeout(attempt, intervalMs);
        }
      });
    };
    attempt();
  });
}
