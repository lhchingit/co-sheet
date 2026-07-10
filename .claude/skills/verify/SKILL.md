---
name: verify
description: Launch co-sheet locally and drive the editor UI in a headless browser to verify a change end-to-end.
---

# Verifying co-sheet changes in the running app

## Launch

1. Throwaway Postgres (schema is auto-created on server startup):
   ```bash
   docker run -d --name cosheet-verify-pg -p 5433:5432 \
     -e POSTGRES_USER=cs -e POSTGRES_PASSWORD=cs -e POSTGRES_DB=cs postgres:16-alpine
   ```
2. Server (no Redis needed for single instance; no CSS build needed — Tailwind output is committed):
   ```bash
   NODE_ENV=test PORT=3177 DATABASE_URL=postgres://cs:cs@localhost:5433/cs \
     DOTENV_CONFIG_PATH=nonexistent node server.js
   ```
   `NODE_ENV=test` enables `POST /auth/test-login` (JSON body `{ "username": "x" }`),
   which sets a session cookie — no OIDC needed. `DOTENV_CONFIG_PATH=nonexistent`
   stops a local `.env` from overriding the test env.

## Drive

- No browser deps in the repo: `npm install playwright-core` in a temp dir and launch
  the system browser via `executablePath` (e.g. `C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe`), headless.
- Log in with `context.request.post('/auth/test-login', { data: { username: 'verifier' } })` —
  it shares the browser context's cookie jar.
- `GET /sheet` (no query) opens the seeded `default` workbook — no need to create a file.
- Cells are addressable as `[data-cell-id="C5"]`. Click to select; the selection overlay is
  `#selection-range-overlay` (child of `#grid-root`), the active-cell frame is `.grid-cell-active`.

## Gotchas

- The drive page `/` and editor are zh-TW by default; prefer id/data-attribute selectors
  over text.
- Use a non-default port (not 3000) and DB port (not 5432) — the user may have the
  docker-compose stack running.
- Clean up: `docker rm -f cosheet-verify-pg` and kill the node process on your port.
