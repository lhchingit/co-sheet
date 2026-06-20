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
| Database     | PostgreSQL (`pg`)                                                  |
| Frontend     | Vanilla JS + HTML, Tailwind CSS (precompiled), Material Symbols    |
| Tests        | Node's built-in test runner over a Testcontainers PostgreSQL      |
| Type-checking| TypeScript over opt-in JS files (`// @ts-check`; no migration)     |

The JavaScript and HTML are served as static files (TypeScript only type-checks them —
`npm run typecheck` — it never compiles them). The one build artifact is the Tailwind
CSS: `npm run build:css` precompiles `public/styles-{editor,drive,login}.css` from the
configs in `tailwind/`. The generated files are committed (so `npm start` needs no
build), and the Docker image rebuilds them so production is never stale.

---

## Project Structure

```
co-sheet-1/
├── server.js              # App composition: Express wiring, OIDC, route handlers, WebSocket server
├── db/                    # Data-access layer — all SQL lives here, behind per-table repositories
│   ├── pool.js            # Connection pool (real pg) via DATABASE_URL
│   ├── schema.js          # applySchema (table DDL) + initDatabase (DDL + default-workbook seed)
│   ├── users.js           # users (permissions directory)
│   ├── files.js           # files registry (drive)
│   ├── shares.js          # file_shares (view/edit grants)
│   ├── stars.js           # file_stars (per-user favourites)
│   ├── versions.js        # workbook_versions (autosave/restore snapshots)
│   └── workbook.js        # workbook_state (persisted cell/sheet state)
├── services/              # Business logic shared by the REST routes and the WebSocket handler
│   ├── cellService.js     # Cell payload validation + the canonical cell write
│   ├── sheetService.js    # Sheet operations (add/delete/copy/rename/color/hide/unhide/reorder)
│   └── validators.js      # Shared pure validators (sheet name, hex color)
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
└── docs/                  # Design specs and implementation plans
```

### Architecture

The server is organized in layers, so request handlers stay thin and the same
business logic backs both transports:

```
HTTP routes  ─┐
              ├─►  services/  ─►  db/  ─►  PostgreSQL
WebSocket    ─┘   (logic)        (SQL)
```

- **Transport (`server.js`)** — Express route handlers and the WebSocket message
  handler. These parse input, then delegate; they hold no SQL.
- **Services (`services/`)** — transport-agnostic business logic (validation +
  in-memory state mutation). A cell edit or a sheet operation runs the *same*
  service code whether it arrives over REST or the WebSocket, so the two paths
  cannot drift. Persistence, broadcasting, and access control are orchestrated by
  the caller, which differs by transport.
- **Data access (`db/`)** — one repository module per table; all SQL is confined
  here. The connection layer is a real `pg` pool driven by `DATABASE_URL`; the test
  suite points it at a throwaway PostgreSQL started via Testcontainers.
- **Middleware** — authentication (`ensureAuthenticated` / `ensureAdmin`) and
  per-file authorization (`requireFileAccess`, which delegates to `canViewFile` /
  `canModifyFile`) gate routes before the handler runs. WebSocket connections
  compute an equivalent `canEdit` flag once at connect time.

---

## Getting Started

### Prerequisites

- Node.js 22+ (uses the built-in test runner and ES modules; the Docker image runs Node 24)
- PostgreSQL (for production / non-test runs)
- Docker (only to run the test suite — Testcontainers starts a throwaway PostgreSQL)

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
| `REDIS_URL`          | Redis connection URI (or comma-separated seed nodes). Enables a Redis-backed session store and the realtime pub/sub bus for multi-replica deployments. Unset → single-instance in-memory mode. |
| `REDIS_CLUSTER`      | Set `true` when `REDIS_URL` points at a cluster-mode Redis (slot-aware client). |
| `GOOGLE_CLIENT_ID`   | Google OAuth 2.0 client ID (OIDC).                                           |
| `GOOGLE_CLIENT_SECRET`| Google OAuth 2.0 client secret.                                            |
| `OIDC_ISSUER`        | External OIDC provider issuer URL (enables "Sign in with Local OIDC").       |
| `OIDC_AUTHORIZATION_URL` / `OIDC_TOKEN_URL` / `OIDC_USERINFO_URL` | External OIDC endpoints (userinfo defaults to `<issuer>/userinfo`). |
| `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | External OIDC client credentials. Redirect URI: `<BASE_URL>/auth/oidc-sso/callback`. |
| `OIDC_SCOPE`         | Optional OAuth scopes (space-separated); defaults to `openid profile email`. |
| `OIDC_SKIP_USERINFO` | Skip the Local OIDC provider's userinfo call and derive identity from the ID-token claims (off by default). Set `true` only for a provider that has no userinfo endpoint (or no `profile` scope); otherwise login fails with "Failed to fetch user profile". |
| `OIDC_TLS_VERIFY`    | TLS cert verification for the Local OIDC provider's token/userinfo calls (on by default). Set `false` only for a self-signed HTTPS provider whose CA isn't installed; scoped to that strategy, never affects Google. |
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

The suite uses Node's built-in test runner and spawns real server processes against a **real
PostgreSQL** database and a **real Redis**. `npm test` runs `tests/run-integration.mjs`, which
starts throwaway PostgreSQL and Redis containers via [Testcontainers](https://testcontainers.com/),
exposes them as `DATABASE_URL` / `REDIS_URL`, then runs `node --test`. Each test carves out its own
isolated database on the PostgreSQL server (see `tests/helpers/db.js`), so there is no shared,
mutable store. Because `REDIS_URL` is provided, the cross-instance realtime fan-out tests
(`tests/realtime_multi_instance.test.js`) run rather than skip. **Docker must be running**; no
other setup is needed.

```bash
npm test
```

You can target individual files (still inside the container runner), and forward `node --test`
flags (anything starting with `-`):

```bash
node tests/run-integration.mjs tests/files.test.js
node tests/run-integration.mjs --test-only tests/store.test.js
```

> **Important:** Run the suite through `tests/run-integration.mjs` (a **single** `node --test`
> invocation). The integration tests bind fixed ports; launching multiple `node --test` runs
> concurrently double-spawns servers on the same ports and hangs.

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
