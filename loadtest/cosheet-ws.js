// Co-Sheet WebSocket concurrency load test (k6).
//
// "How many people can edit at once?" is really a WebSocket-concurrency question:
// every connected client is one open socket held in the server's `activeUsers` map,
// and every cursor-move / cell-edit is fanned out to all OTHER sockets on the same
// file (see localBroadcast in server.js). That fan-out is O(N) per message, so N
// users all moving cursors is ~O(N^2) messages/sec on a SINGLE shared sheet — which
// is why "max people on one document" is much lower than "max raw connections".
// This script drives that traffic so the ramp measures the real ceiling.
//
// One k6 VU == one user == one open socket.
//
//   # zero-setup: guests on the default workbook (no login required)
//   NO_AUTH=1 BASE_URL=http://localhost:3000 k6 run loadtest/cosheet-ws.js
//
//   # named users on a private file (start the server with NODE_ENV=test so the
//   # /auth/test-login route is mounted)
//   FILE_ID=<24-hex-id> k6 run loadtest/cosheet-ws.js
//
// See loadtest/README.md for what to watch and the known caveats.
import ws from 'k6/ws';
import http from 'k6/http';
import { check } from 'k6';
import { Trend, Counter } from 'k6/metrics';

const BASE        = __ENV.BASE_URL    || 'http://localhost:3000';
const WS_BASE     = BASE.replace(/^http/, 'ws');
const FILE        = __ENV.FILE_ID     || 'default';   // 'default' => no auth needed
const SESSION_SEC = Number(__ENV.SESSION_SEC || 60);
const NO_AUTH     = !!__ENV.NO_AUTH;

const initLatency = new Trend('cosheet_init_ms', true);   // connect -> 'init' received
const cellRecv    = new Counter('cosheet_cell_updates_recv');
const cursorRecv  = new Counter('cosheet_cursor_updates_recv');

// Default: ramp 100 -> 500 -> 1000 over ~5.5 min. For a quick smoke test (or any
// fixed-load run), set VUS and DURATION to hold a constant number of sockets, e.g.
// VUS=5 DURATION=15s k6 run loadtest/cosheet-ws.js
const scenario = (__ENV.VUS && __ENV.DURATION)
  ? { executor: 'constant-vus', vus: Number(__ENV.VUS), duration: __ENV.DURATION, gracefulStop: '10s' }
  : {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '1m',  target: 100 },
        { duration: '2m',  target: 500 },
        { duration: '2m',  target: 1000 },
        { duration: '30s', target: 0 },
      ],
      gracefulStop: '10s',
    };

export const options = {
  scenarios: { main: scenario },
  thresholds: {
    cosheet_init_ms: ['p(95)<1000'],   // 95% of clients receive init within 1s
    ws_connecting:   ['p(95)<1000'],   // handshake latency
  },
};

// Obtain a real session cookie via the test-only login route. The server must run
// with NODE_ENV=test for /auth/test-login to exist. Skip entirely with NO_AUTH=1
// (guests can view+edit the 'default' workbook).
function authCookie(name) {
  if (NO_AUTH) return null;
  const res = http.post(`${BASE}/auth/test-login`, JSON.stringify({ username: name }),
    { headers: { 'Content-Type': 'application/json' } });
  const sc = res.headers['Set-Cookie'];
  return sc ? sc.split(';')[0] : null;
}

export default function () {
  const cookie = authCookie(`vu${__VU}`);
  const params = cookie ? { headers: { Cookie: cookie } } : {};
  const t0 = Date.now();

  const res = ws.connect(`${WS_BASE}/?file=${FILE}`, params, (socket) => {
    socket.on('open', () => {
      const rndCell = () =>
        `${String.fromCharCode(65 + Math.floor(Math.random() * 26))}${1 + Math.floor(Math.random() * 100)}`;

      // Cursor moves drive the broadcast fan-out — the dominant scaling cost.
      socket.setInterval(() => socket.send(JSON.stringify(
        { type: 'cursor-move', payload: { cellId: rndCell(), sheetName: 'Sheet1' } })), 1000);

      // Lighter edit cadence. NOTE: cell-edit also persists to Postgres via autosave,
      // so for a pure connection/presence test drop this and keep cursor-move only.
      socket.setInterval(() => socket.send(JSON.stringify(
        { type: 'cell-edit', payload: { cellId: rndCell(), value: `v${Date.now()}`, sheetName: 'Sheet1' } })), 5000);

      socket.setTimeout(() => socket.close(), SESSION_SEC * 1000);
    });

    socket.on('message', (data) => {
      let m;
      try { m = JSON.parse(data); } catch { return; }
      if (m.type === 'init') initLatency.add(Date.now() - t0);
      else if (m.type === 'cell-update')   cellRecv.add(1);
      else if (m.type === 'cursor-update') cursorRecv.add(1);
    });
  });

  check(res, { 'handshake 101': (r) => r && r.status === 101 });
}
