# Co-Sheet

A real-time collaborative spreadsheet web application — a Google Sheets–style editor with
live multi-user editing, a file/drive manager, role-based permissions, file sharing, version
history, and a rich formula engine. Built on Node.js + Express + WebSockets, with PostgreSQL
for persistence and an OpenID Connect (Google) authentication flow.

The UI is fully internationalized (Traditional Chinese `zh-TW` as default, English `en` as
alternate) and styled with a Material Design 3 light theme.

---

## Features

- **Real-time collaboration** — multiple users edit the same workbook simultaneously over a
  WebSocket channel; cell edits, formatting, and sheet changes sync live.
- **Spreadsheet editor** — multiple sheets per workbook, cell formatting (font, size, color,
  fill, borders, alignment, wrap), number formats, merge, undo/redo, copy/cut/paste, find &
  replace, sort, value filters, freeze rows/columns, hide/unhide sheets, zoom, and range
  selection.
- **Formula engine** — a real tokenizer / parser / evaluator with a library of ~150 functions
  (math, statistical, logical, text, lookup, date). Autocomplete is driven by a separate
  function catalog.
- **Drive / file manager** — a `/` landing page listing your workbooks; create, open, rename,
  delete, and copy-link.
- **Authentication** — Google OIDC sign-in in production, a configurable external/self-hosted
  OIDC provider ("Sign in with Local OIDC", e.g. Keycloak/Authentik/Dex), plus a built-in mock
  OIDC provider and a test-only login for local development and the test suite.
- **Role-based access control (RBAC)** — three roles: `user`, `admin`, `superadmin`. Super
  admins are bootstrapped from an environment variable; admins manage other users' roles from
  an admin-only permissions page.
- **File access control & sharing** — the creator owns a file; regular users may own at most
  one file (admins/super admins unlimited). Only the owner and admins can edit/rename/delete.
  Owners can search the user directory and share a file (view-only) with other users.
- **Version history** — periodic autosave snapshots with browse-and-restore.
- **Internationalization** — runtime locale switching via `data-i18n` attributes and a `t()`
  helper; `zh-TW` (default) and `en`.

---

## Tech Stack

| Layer        | Technology                                                        |
|--------------|-------------------------------------------------------------------|
| Runtime      | Node.js (ES modules)                                              |
| Server       | Express 4                                                          |
| Real-time    | `ws` WebSocket server (shares the HTTP server via upgrade)         |
| Auth         | Passport + `passport-openidconnect`; `express-session`            |
| Database     | PostgreSQL (`pg`); JSON-sidecar mock in test mode                  |
| Frontend     | Vanilla JS + HTML, Tailwind-style utility classes, Material Symbols|
| Tests        | Node's built-in test runner (`node --test`)                       |
| Type-checking| TypeScript over opt-in JS files (`// @ts-check`; no migration)     |

No build step — the frontend is served as static files. TypeScript is used only to
type-check the existing JavaScript (`npm run typecheck`); the code is not compiled.

---

## Project Structure

```
co-sheet-1/
├── server.js              # Express app, OIDC, REST API, WebSocket server, DB layer
├── package.json
├── tsconfig*.json         # Opt-in TypeScript type-checking config (no emit, no build)
├── .env.example           # Environment template (copy to .env)
├── public/                # Static frontend assets (served without auth where noted)
│   ├── app.js             # Spreadsheet editor client (grid, formulas, share dialog, ...)
│   ├── drive.js           # Drive / file manager + permissions page client
│   ├── formula-engine.js  # Tokenizer / parser / evaluator + function library
│   ├── sheet-functions.js # Autocomplete function catalog
│   ├── sheet-utils.js     # Shared helpers
│   ├── i18n.js            # Runtime i18n (loadLocales, t, translatePage, getLang)
│   ├── locales/           # en.json, zh-TW.json
│   ├── login.html         # Sign-in page
│   └── favicon.svg
├── private/               # Authenticated HTML views
│   ├── index.html         # Spreadsheet editor page (/sheet)
│   └── drive.html         # Drive + admin permissions page (/)
├── tests/                 # Integration & unit tests (node --test)
├── k8s/                   # Kubernetes manifests (namespace, secrets, postgres, app, ingress)
└── docs/                  # Design specs and implementation plans
```

---

## Getting Started

### Prerequisites

- Node.js 22+ (uses the built-in test runner and ES modules; the Docker image runs Node 24)
- PostgreSQL (for production / non-test runs)

### Install

```bash
npm install
```

### Configure

Copy the environment template and fill in your values:

```bash
cp .env.example .env
```

| Variable             | Description                                                                 |
|----------------------|-----------------------------------------------------------------------------|
| `PORT`               | HTTP port (default `3000`).                                                  |
| `BASE_URL`           | Public base URL; required in production for OAuth callbacks.                 |
| `DATABASE_URL`       | PostgreSQL connection URI.                                                   |
| `GOOGLE_CLIENT_ID`   | Google OAuth 2.0 client ID (OIDC).                                           |
| `GOOGLE_CLIENT_SECRET`| Google OAuth 2.0 client secret.                                            |
| `OIDC_ISSUER`        | External OIDC provider issuer URL (enables "Sign in with Local OIDC").       |
| `OIDC_AUTHORIZATION_URL` / `OIDC_TOKEN_URL` / `OIDC_USERINFO_URL` | External OIDC endpoints (userinfo defaults to `<issuer>/userinfo`). |
| `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | External OIDC client credentials. Redirect URI: `<BASE_URL>/auth/oidc-sso/callback`. |
| `OIDC_SCOPE`         | Optional OAuth scopes (space-separated); defaults to `openid profile email`. |
| `SUPER_ADMIN_EMAILS` | Comma-separated emails (or usernames for mock login) always granted `superadmin`. |

> **Note:** The schema is created automatically on startup (`initDatabase`). If Google
> credentials are not configured, the app serves a built-in **mock** Google sign-in page so you
> can develop locally without real OAuth.

### Run

```bash
npm start
```

Then open <http://localhost:3000>. You'll be redirected to the login page; sign in (or use the
mock sign-in) to reach your drive.

---

## Testing

The suite uses Node's built-in test runner and spawns real server processes against an
in-memory / JSON-sidecar mock database (`NODE_ENV=test`), so **no PostgreSQL is required** to
run tests.

```bash
npm test
```

> **Important:** Run the suite as a **single** `node --test` invocation. The integration tests
> bind fixed ports; launching multiple `node --test` runs concurrently double-spawns servers on
> the same ports and hangs.

Coverage spans authentication & OIDC, the REST API, the WebSocket channel, the formula engine,
clipboard/edit-menu behaviors, version history, permissions/RBAC, and file access control &
sharing.

### Type-checking

JavaScript sources are type-checked with TypeScript on an **opt-in, per-file** basis: a file
is only checked once it starts with `// @ts-check` (aided by JSDoc annotations). There is no
migration to `.ts` and no compiled output (`noEmit`):

```bash
npm run typecheck
```

---

## Authentication & Roles

- **Identity** is keyed by `(email || username)` lowercased. The local mock/test sign-in has no
  email, so identity falls back to the username.
- **Roles:** `user` (default), `admin`, `superadmin`.
  - **Super admins** are bootstrapped from `SUPER_ADMIN_EMAILS` — the environment is
    authoritative on each login (a stored super admin removed from the env is demoted to
    `admin`). They cannot be created or modified through the UI.
  - **Admins** can promote/demote other users between `user` and `admin` on the permissions
    page, but cannot change their own role, grant `superadmin`, or modify a super admin.
- The **permissions page** (in the drive) is visible only to admins and super admins.

---

## File Access Control & Sharing

- The user who creates a file becomes its **owner** (`files.created_by`).
- **Quota:** a regular `user` may own at most one file; admins and super admins are unlimited.
- **Edit/rename/delete** is restricted to the owner and admins/super admins, enforced on the
  REST API, the cell-write endpoint, and the WebSocket channel.
- **Sharing:** an owner can search the user directory and share a file with one or more users.
  Sharing grants **view-only** access — shared users see the file in their drive but cannot
  edit it.
- A legacy **`default`** workbook is a shared document that remains open to every authenticated
  user (exempt from ownership/quota restrictions) for backward compatibility.

---

## API Overview

Auth & session:

| Method & Path                  | Description                                  |
|--------------------------------|----------------------------------------------|
| `GET /login`                   | Sign-in page (unauthenticated).              |
| `GET /auth/google`             | Start Google OAuth (or mock) sign-in.        |
| `GET /auth/google/callback`    | OAuth callback.                              |
| `GET /logout`                  | End session and clear cookies.               |
| `GET /api/me`                  | Current user `{username,email,picture,role}`.|

Users / permissions (admin-gated):

| Method & Path            | Description                              |
|--------------------------|------------------------------------------|
| `GET /api/users`         | List users with roles (admin only).      |
| `PATCH /api/users/:id`   | Change a user's role (admin only).       |
| `GET /api/users/search`  | Search the directory for sharing.        |

Files, cells, sharing & versions:

| Method & Path                     | Description                                |
|-----------------------------------|--------------------------------------------|
| `GET /api/files`                  | List visible files (owned + shared + ...). |
| `POST /api/files`                 | Create a file (quota-checked).             |
| `PATCH /api/files/:id`            | Rename (owner/admin only).                 |
| `DELETE /api/files/:id`           | Delete (owner/admin only).                 |
| `GET/POST /api/files/:id/shares`  | List / grant view-only shares.             |
| `GET/POST /api/cells`             | Read / write cells (write is access-gated).|
| `GET /api/versions`               | List version snapshots.                    |
| `GET /api/versions/:id`           | Fetch a snapshot.                          |
| `POST /api/versions/:id/restore`  | Restore a snapshot.                        |

Real-time editing happens over a **WebSocket** connection (HTTP upgrade on the same server);
on connect, the server computes the user's `canEdit` flag and silently drops state-changing
messages from users without edit rights.

A mock **OIDC provider** is also served under `/oidc/*` (discovery, JWKS, authorize, token,
userinfo) for local development and tests.

---

## Deployment

### Google Cloud Run (recommended)

A scripted deployment to **Cloud Run + Cloud SQL** is included: `deploy.sh` and
`cloudbuild.yaml` build the image and deploy it pinned to a single instance. See
[`DEPLOY.md`](DEPLOY.md) for the full walkthrough (prerequisites, Cloud SQL setup,
secrets, and OAuth configuration).

### Kubernetes

Kubernetes manifests are provided under `k8s/`:

- `00-namespace.yaml`, `10-secrets.yaml`, `20-postgres.yaml`, `30-app.yaml`, `40-ingress.yaml`

> **Single replica only.** The app keeps sessions (in-memory `MemoryStore`) and all live
> collaboration state in process. Running more than one replica would split sessions and break
> cross-user sync. The Deployment is pinned to `replicas: 1` with a `Recreate` strategy.
> Scaling out would first require a shared session store (e.g. Redis/Postgres) and a WebSocket
> pub/sub layer.

Before applying, replace the placeholder values in `k8s/10-secrets.yaml` (`CHANGE_ME`) and the
image reference in `k8s/30-app.yaml`.

---

## Internationalization

UI strings live in `public/locales/{zh-TW,en}.json`. The runtime (`public/i18n.js`) exposes
`window.CoSheet.i18n` with `loadLocales`, `getLang`, `t(key, vars)`, and `translatePage(lang)`.
Markup is annotated with `data-i18n`, `data-i18n-title`, and `data-i18n-aria` attributes;
`<input>` placeholders are set from JavaScript. `zh-TW` is the default locale; `en` is the
alternate.

---

## License

Released under the [MIT License](LICENSE) — Copyright (c) 2026 LHCHIN.

You are free to use, copy, modify, merge, publish, distribute, sublicense, and/or
sell copies of the software, subject to including the copyright and permission
notice. The software is provided "as is", without warranty of any kind. See the
[`LICENSE`](LICENSE) file for the full text.
