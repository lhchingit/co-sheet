# Load testing — WebSocket concurrency

`cosheet-ws.js` is a [k6](https://k6.io/) script for answering *"how many people can
edit simultaneously?"*. That's a WebSocket-concurrency question: each connected client
is one open socket in the server's `activeUsers` map, and the script drives realistic
cursor/edit traffic so the ramp measures the real ceiling rather than idle sockets.

This is an operational tool, not part of `npm test`. It needs the [k6 binary](https://grafana.com/docs/k6/latest/set-up/install-k6/)
installed separately; there is no npm dependency.

## Run

```bash
# Zero setup: guests on the legacy 'default' workbook (no login required).
NO_AUTH=1 BASE_URL=http://localhost:3000 k6 run loadtest/cosheet-ws.js

# Named users on a private file. Start the server with NODE_ENV=test so the
# /auth/test-login route exists, then point at a real 24-hex file id.
FILE_ID=<24-hex-id> k6 run loadtest/cosheet-ws.js
```

| Env var       | Default                 | Meaning                                              |
|---------------|-------------------------|------------------------------------------------------|
| `BASE_URL`    | `http://localhost:3000` | HTTP base; the `ws://` URL is derived from it.       |
| `FILE_ID`     | `default`               | Workbook to join (`?file=`). `default` needs no auth.|
| `NO_AUTH`     | unset                   | Set to connect as guests, skipping `/auth/test-login`.|
| `SESSION_SEC` | `60`                    | How long each VU holds its socket before closing.    |
| `VUS`         | unset                   | With `DURATION`, hold this many constant sockets instead of ramping. |
| `DURATION`    | unset                   | With `VUS`, the constant-load run length (e.g. `30s`, `5m`). |

One k6 VU == one user == one open socket. By default the script ramps 100 → 500 → 1000
over ~5.5 min. For a quick smoke test or any fixed-load run, set `VUS` and `DURATION`
to hold a constant number of sockets:

```bash
# 50 concurrent users for 20s against an isolated server
NO_AUTH=1 BASE_URL=http://localhost:3100 VUS=50 DURATION=20s SESSION_SEC=18 k6 run loadtest/cosheet-ws.js
```

To change the ramp profile itself, edit the `stages` in the script's `scenario`.

## What to watch

k6's own numbers will mislead you if read alone — correlate all three:

- **k6 side** — `cosheet_init_ms` p95 (connect → `init`) climbing, `ws handshake`
  failures, and `cosheet_*_recv` counters falling behind the send rate (fan-out
  lagging).
- **Server side** — Node CPU pegged at ~100% of **one** core (single-instance is
  single-threaded) and event-loop lag. The knee is usually here, not in k6.
- **OS limits** masquerading as a server ceiling — `ulimit -n` (file descriptors) on
  the server, plus ephemeral-port / FD exhaustion on the **k6 host**. Past a few
  thousand VUs from one machine, tune both or you'll be measuring your test box.

## Caveats specific to co-sheet

- **The bottleneck is broadcast fan-out, not raw connections.** `localBroadcast`
  (`server.js`) loops over every socket on the same file, so N users all moving cursors
  is ~O(N²) messages/sec on a single sheet. "Max people on one shared document" is far
  lower than "max total connections spread across many files." Test the scenario you
  actually care about.
- **Single instance caps you at one core.** To measure the *architecture's* ceiling
  rather than one process, run multiple instances behind a load balancer with
  `REDIS_URL` set — then the Redis pub/sub bus (not in-process broadcast) is what
  you're stressing.
- **`cell-edit` writes to Postgres** via the autosave engine. For a pure
  connection/presence scaling test, remove the edit interval in the script and keep
  cursor-move only, or point at a throwaway file — otherwise you're also load-testing
  the database.
- **Don't aim this at production.** Run it against a local or dedicated load
  environment.
