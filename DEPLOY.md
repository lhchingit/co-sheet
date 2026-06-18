# Deploying co-sheet to Google Cloud

co-sheet is a stateful, real-time app: it keeps a persistent **WebSocket** open per
client, holds live workbook state and sessions **in the server process**, and
persists data to **PostgreSQL**. That rules out serverless platforms that can't
hold a socket (e.g. Vercel functions). It runs as a **single instance** by default,
and scales to **multiple instances** when a Redis (`REDIS_URL`) is configured.
Google Cloud Run + Cloud SQL is the recommended target and is what the included
`deploy.sh` and `cloudbuild.yaml` automate.

> **⚠️ Scaling caveat — read first.** Without `REDIS_URL`, live edits are broadcast
> only to the WebSocket connections on the **same process** and sessions use an
> in-memory store, so you **must** run a single instance — `deploy.sh` and
> `cloudbuild.yaml` therefore pin Cloud Run to `--min/--max-instances=1`. To run
> more than one instance, set `REDIS_URL`: the app then shares sessions in Redis and
> fans edits/presence out across instances over Redis pub/sub. See
> [Horizontal scaling with Redis](#horizontal-scaling-with-redis) below before
> raising the instance cap. Not required to launch.

---

## Prerequisites

- `gcloud` CLI installed and authenticated: `gcloud auth login`
- A project selected: `gcloud config set project <PROJECT_ID>`
- A Google OAuth 2.0 **Web application** client (APIs & Services → Credentials)
- Enable the required APIs once:

  ```bash
  gcloud services enable \
    run.googleapis.com \
    sqladmin.googleapis.com \
    cloudbuild.googleapis.com \
    artifactregistry.googleapis.com \
    secretmanager.googleapis.com
  ```

---

## One-time infrastructure

### 1. Cloud SQL (PostgreSQL)

```bash
gcloud sql instances create cosheet-db \
  --database-version=POSTGRES_16 --tier=db-f1-micro --region=us-central1

gcloud sql databases create cosheet --instance=cosheet-db
gcloud sql users set-password postgres --instance=cosheet-db --password='STRONG_PASSWORD'
```

No schema work is needed: on boot the app's `initDatabase()` (`server.js`) creates
all tables (`workbook_state`, `workbook_versions`, files/users/shares/stars, etc.)
if they don't exist.

> Cloud Run connects to Cloud SQL over a **Unix socket** (`host=/cloudsql/<conn>`),
> so no SSL/`rejectUnauthorized` tweak is needed in the app — unlike a public TCP
> connection to Neon or Vercel Postgres, which would require it.

### 2. (CI only) Artifact Registry + Secret Manager

Only needed for the `cloudbuild.yaml` path:

```bash
gcloud artifacts repositories create cosheet \
  --repository-format=docker --location=us-central1

printf 'STRONG_PASSWORD'      | gcloud secrets create cosheet-db-pass --data-file=-
printf 'YOUR_GOOGLE_CLIENT_ID'     | gcloud secrets create cosheet-google-client-id --data-file=-
printf 'YOUR_GOOGLE_CLIENT_SECRET' | gcloud secrets create cosheet-google-client-secret --data-file=-
```

Grant the Cloud Build and Cloud Run service accounts `roles/secretmanager.secretAccessor`
and (for Cloud Run → Cloud SQL) `roles/cloudsql.client`.

---

## Environment variables the app reads

| Variable | Required | Notes |
|----------|----------|-------|
| `DATABASE_URL` | ✅ | Cloud SQL socket form: `postgresql://USER:PASS@/DB?host=/cloudsql/PROJECT:REGION:INSTANCE` |
| `BASE_URL` | ✅ in prod | The public service URL; used to build OAuth callback URLs (`server.js:382`). Defaults to `http://localhost:PORT` if unset. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | ✅ for Google login | OAuth client credentials |
| `SUPER_ADMIN_EMAILS` | optional | Comma-separated emails always granted `superadmin` |
| `NODE_ENV` | ✅ | Must be `production` (not `test`) so the real `pg` pool is used, not the file-store mock |
| `PORT` | auto | Injected by Cloud Run; the app honors it (`server.js:29`). Don't hardcode. |

> **Not used:** there is **no `SESSION_SECRET` env var** — the session secret is
> currently hardcoded (`server.js:353`). See [Hardening](#hardening-recommended).

---

## Option A — Quick deploy with `deploy.sh`

Builds from source (Cloud Build under the hood) and deploys to Cloud Run.

```bash
# First deploy (BASE_URL not yet known)
DB_PASS='STRONG_PASSWORD' \
GOOGLE_CLIENT_ID='...' \
GOOGLE_CLIENT_SECRET='...' \
SUPER_ADMIN_EMAILS='you@example.com' \
./deploy.sh
```

The script prints the service URL. Then:

1. Add `<URL>/auth/google/callback` to the OAuth client's **Authorized redirect URIs**.
2. Re-run with `BASE_URL` set so server-side redirects match:

   ```bash
   BASE_URL='https://cosheet-xxxx-uc.a.run.app' \
   DB_PASS='STRONG_PASSWORD' GOOGLE_CLIENT_ID='...' GOOGLE_CLIENT_SECRET='...' \
   ./deploy.sh
   ```

Override defaults (`PROJECT_ID`, `REGION`, `SERVICE`, `SQL_INSTANCE`, `DB_NAME`,
`DB_USER`) via environment variables — see the top of `deploy.sh`.

---

## Option B — CI with Cloud Build (`cloudbuild.yaml`)

Build, push to Artifact Registry, and deploy — secrets pulled from Secret Manager.

```bash
gcloud builds submit --config cloudbuild.yaml \
  --substitutions=_REGION=us-central1,_SERVICE=cosheet,_SQL_INSTANCE=cosheet-db,_BASE_URL=https://cosheet-xxxx-uc.a.run.app
```

Wire the same config into a build trigger (push to `main`) for continuous deploys.
On the very first build, leave `_BASE_URL` empty, grab the URL, set the OAuth
redirect URI, then re-run with `_BASE_URL` populated.

---

## Verifying the deploy

```bash
# Tail logs
gcloud run services logs read cosheet --region=us-central1

# Hit the unauthenticated login page (the Dockerfile healthcheck target)
curl -sI "$(gcloud run services describe cosheet --region=us-central1 --format='value(status.url)')/login"
```

Then open the URL, sign in with Google, and confirm real-time edits sync across two
browser tabs. The client now auto-reconnects its WebSocket with exponential backoff
(`public/app.js` `connectSocket()`), so it survives Cloud Run's request timeout and
redeploys without a manual refresh.

---

## Hardening (recommended)

These don't block a launch but you should address them for real production use:

- **Hardcoded session secret** (`server.js:353`): replace the literal
  `'co-sheet-secret-key-123'` with `process.env.SESSION_SECRET` and store the value
  in Secret Manager. As-is, every deploy shares a known secret.
- **Insecure session cookie** (`server.js:357`, `cookie: { secure: false }`): behind
  Cloud Run's HTTPS proxy, set `secure: true` and `app.set('trust proxy', 1)` so the
  session cookie is only sent over HTTPS.
- **Move secrets to Secret Manager** even on the `deploy.sh` path (it currently passes
  them as env vars), via `--set-secrets`.
- **Horizontal scale**: set `REDIS_URL` (Memorystore on Cloud Run) before raising
  `--max-instances` above 1. See [Horizontal scaling with Redis](#horizontal-scaling-with-redis).

---

## Alternative: a single VM (Compute Engine)

If you'd rather not use Cloud Run, the repo's `docker-compose.yml` runs the app,
Postgres, and Redis together. Create a small Compute Engine VM with a
container-optimized image, copy the repo and a populated `.env`, and run
`docker compose up -d`. This is the simplest model but you own patching and uptime
of the box. Use Cloud SQL instead of the bundled Postgres if you want managed backups.

---

## Horizontal scaling with Redis

By default the app is single-instance: edits fan out only to the WebSocket
connections held by one process, and sessions live in memory. Setting `REDIS_URL`
switches on multi-instance mode, which adds three things:

1. **Shared sessions** — the session store moves to Redis (`connect-redis`), so a
   socket whose login landed on one instance authenticates on any instance.
2. **Edit fan-out** — every state-changing op is published to Redis pub/sub; each
   instance re-applies it to its own in-memory workbook cache and forwards it to its
   local sockets (`services/realtimeBus.js`). This keeps all instances' caches
   coherent, so a newly connecting client gets up-to-date state regardless of which
   instance it lands on.
3. **Presence fan-out** — cursors and join/leave events propagate across instances,
   and the connect-time roster (`init`) merges local and remote users.

### Enable it

- **docker-compose**: already wired. The `redis` service is included and the app's
  `REDIS_URL` points at it (`redis://redis:6379`). To actually run multiple app
  replicas you must put a WebSocket-aware load balancer (nginx/traefik/Caddy) in
  front and drop the app's host `ports:` mapping, since two containers can't bind
  the same host port.
- **Cloud Run**: provision Memorystore (Redis), add a
  [Serverless VPC connector](https://cloud.google.com/run/docs/configuring/connecting-vpc)
  so Cloud Run can reach it, set `REDIS_URL` (e.g. via `--set-env-vars` or
  `--set-secrets`), then raise `--max-instances`. WebSocket connections are sticky
  per socket for their lifetime, so no session affinity config is needed.

### Single endpoint vs. Redis Cluster

`REDIS_URL` alone targets a **single endpoint** — a standalone Redis or a managed
HA instance behind one address (Memorystore Basic/Standard, ElastiCache
*cluster-mode-disabled*). This is the common case and needs no other config.

For a **true Redis Cluster** (cluster-mode *enabled*, data sharded across nodes),
also set `REDIS_CLUSTER=true`. The app then uses a slot-aware cluster client for
sessions, the pub/sub channel, and the autosave lock, and `REDIS_URL` may be a
comma-separated list of seed node URLs. Note: fan-out still uses a single global
pub/sub channel, which on a cluster propagates messages cluster-wide (correct, but
not sharded) — fine for typical edit/cursor volume. Sharding pub/sub per document
would be a further change.

### Known limitations (v1)

- **No conflict resolution.** Concurrent edits to the same cell remain last-write-wins
  (unchanged from single-instance); this is independent of the fan-out transport.
- **Presence of a crashed instance** can linger in peers' rosters until the next
  roster event, since cleanup is event-driven (graceful leave) rather than
  heartbeat-based.
- **Lazy cache + eventual consistency.** A per-file workbook that isn't yet cached on
  an instance is loaded from Postgres on the next connection there; persistence is
  asynchronous, so there is a small window where a just-connected client could miss
  an in-flight edit (the live fan-out then delivers subsequent edits).
