---
name: create-digit-app
description: >-
  Build and publish Digit custom apps (React + MUI + Digit theme via
  @digit/lib-frontend, optional Cloudflare Worker backends via @digit/lib-backend,
  Vite IIFE bundles, manifest.json, Digit API proxy, env/secrets). Apps run in a
  locked-down sandboxed iframe (no downloads, popups, browser dialogs, clipboard,
  or device APIs). Use when creating a Digit app, editing an app in a local clone
  of this starter, publishing via MCP, or when the user mentions Digit apps,
  manifest.json, DigitProxyClient, DigitThemeProvider, /proxy/digit, or
  /proxy/backend.
---

# Create Digit App

Build Digit custom apps that run inside Digit as **sandboxed iframes** with a locked-down
Permissions Policy. Follow this skill end-to-end — do not invent alternate layouts,
mount targets, stacks, or publish flows, and do not build features the iframe cannot
support (downloads, new tabs/popups, browser dialogs, clipboard, camera, etc.).
See [reference/iframe-constraints.md](reference/iframe-constraints.md).

**Default stack (required):** React + MUI + `@digit/lib-frontend` (`DigitThemeProvider`).
Do not build vanilla HTML/CSS UI, invent a parallel design system, or skip the theme
package. Users are often non-developers — one path keeps apps looking and behaving
like Digit.

**Digit MCP is required.** Use it for schema lookup, permissions, listing apps,
downloading the live publish (`app` → `currentPublish.downloadUrl`), and publish.
If MCP is not connected, stop and ask the user to connect Digit MCP before
continuing.

## When to use

- Creating a new Digit app from scratch
- Iterating on an already-published app (download live source via **`app`**)
- Adapting one of the `examples/` templates
- Declaring `manifest.json` permissions / backend
- Calling the Digit GraphQL API from an app
- Using app env vars or secrets (backend only)
- Publishing via Digit MCP tools

## Digit MCP (apps)

| Need | Use |
| --- | --- |
| Public GraphQL schema | MCP resources `graphql-schema://index`, `graphql-schema://type/{TypeName}`, `graphql-schema://search/{query}` |
| Manifest permissions | MCP tool **`appPermissions`** — put each permission’s **`key`** in `manifest.json` |
| Find an existing app’s id | MCP tool **`apps`** |
| Load one app (incl. live source) | MCP tool **`app`** — when published, `currentPublish.downloadUrl` is a GET URL for the active bundle |
| Publish | **`generateAppUploadLink`** → HTTP POST zip → **`publishApp`** → poll **`appPublish`** |

There are **no** MCP tools to create, update, or delete apps, or to manage env/secrets —
those stay in the Digit UI. Do not invent them.

Do **not** load the full GraphQL schema into context. Use the schema resources above when
writing or changing Digit API operations. Details:
[reference/proxy-and-api.md](reference/proxy-and-api.md),
[reference/permissions.md](reference/permissions.md).

## Quick workflow

Copy this checklist and track progress:

```
Digit app progress:
- [ ] 1. Use the starter's apps/app, or scaffold apps/<name> for an additional app
- [ ] 2. Confirm the user created the app in Digit (get appId via apps)
- [ ] 2b. If iterating on a live app: call app, GET currentPublish.downloadUrl, unpack project/ over apps/<name>
- [ ] 3. Implement frontend (React + MUI + DigitThemeProvider → #root)
- [ ] 4. Add src/backend/ only if env/secrets or server logic needed
- [ ] 5. Look up GraphQL via graphql-schema://… and permissions via appPermissions
- [ ] 6. Write root manifest.json (permissions[].key from appPermissions)
- [ ] 7. Check manifest.permissions against appPermissions — confirm it covers every Digit API call the app makes
- [ ] 8. Write/update SPEC.md
- [ ] 9. npm run pack -w apps/<name> → app.zip
- [ ] 10. Publish via MCP (upload zip out-of-band)
- [ ] 11. Keep app source under apps/ — not build outputs; no upstream PRs
```

Schema and permission lookup (steps 5–7) must happen **before publish**. Do them as soon
as you know which Digit API calls the app makes — inventing fields or permission strings
fails at runtime or publish validation. Re-check step 7 whenever you add or change a Digit
API call.

### 1. Scaffold the app

This repo is a single **npm workspace**. Apps live in `apps/<name>` — that depth is
required, because apps depend on the libraries via `file:../../packages/*`.

The curated starter archive already contains `apps/app`, pre-scaffolded from the
frontend-only `examples/hello-world` without build outputs. Use it when the app has
never been published. Add `src/backend/` only when the app needs server-side
functionality. When iterating on an already-published app, download the live bundle
from MCP **`app`** → `currentPublish.downloadUrl` and replace `apps/app` (or
`apps/<name>`) with that zip’s `project/` tree — do not start from the hello-world
scaffold and guess. Run `new-app` only when adding another app workspace:

```bash
npm install                     # once per clone, from the repo root
npm run new-app -- my-app       # copies examples/full-featured → apps/my-app
```

`new-app` copies the template, renames the package, writes a `SPEC.md` stub, and re-runs
`npm install` so the workspace links the new app. Trim what you don't need from the copy —
do not invent a new project shape.

The template covers theme, errors, Digit GraphQL (`useDigitApiQuery`), public API + secrets
+ D1 via the Worker (`useBackendQuery` / `@digit/lib-backend`), and env config. Keep the
`@digit/lib-build` devDependency and `"pack": "digit-app pack"` — do **not** add Vite
configs, a local pack script, or a per-app `npm install`.

**Always install from the repo root.** `@digit/lib-build` is a `file:` link, so npm puts
its build toolchain (Vite) in the root `node_modules`, not the app's. Running `npm install`
only inside `apps/<name>` leaves Vite missing and `pack` fails.

All apps share React + MUI + `@digit/lib-frontend` and the same folder conventions.
There is no local Digit preview (Worker / env / D1 are platform-injected) — pack + publish
is the path.

### 2. App must already exist in Digit

Publishing **never creates** an app. Ask the user to create the app in the Digit UI first,
then resolve its `id` with MCP **`apps`** (or have the user paste it).

### 2b. Iterate from the live published source

If the user wants to change an app that is already live, **download the current
publish** instead of rebuilding from an example:

1. Call MCP **`apps`** to get the `id`, then MCP **`app`** with that id.
2. Read `currentPublish.downloadUrl`. If it is missing, the app has no successful
   publish yet — use `apps/app` / `new-app` as in step 1.
3. HTTP **GET** that URL (out-of-band; not via MCP) and unzip the archive.
4. Replace `apps/<name>` entirely with the zip’s **`project/`** tree (source,
   `manifest.json`, `SPEC.md`, vendored `@digit/lib-*`). Do not copy zip-root
   `frontend/` / `backend/` into the workspace — those are pack outputs.
5. Continue the checklist from implementation through pack and republish.

The download is the same shape as a packed `app.zip`. Do not invent another fetch
path. Details: [reference/publish.md](reference/publish.md).

### 3. Project layout

```
apps/my-app/
├── package.json            # @digit/lib-* ; "pack": "digit-app pack"
├── manifest.json           # staged at zip root by digit-app pack
├── SPEC.md
├── src/frontend/           # main.tsx → #root + DigitThemeProvider; App.tsx
├── src/backend/            # optional Worker (index.js, migrations/)
├── frontend/               # BUILD — gitignored; frontend/index.js entry
└── backend/                # BUILD when Worker present — gitignored
```

Edit `src/frontend` and `src/backend` only. Harness types come from `@digit/lib-frontend`
— no local `digit.d.ts`. Prefer data hooks over calling `window.DigitProxyClient`.

```bash
npm run pack -w apps/my-app     # from repo root → app.zip
```

`app.zip` has root `manifest.json`, `frontend/` (+ `backend/` when declared), and
`project/` (source + vendored `@digit/lib-*`). Digit deploys `frontend/` / `backend/`
only; still upload the zip **unchanged**. Details:
[reference/manifest.md](reference/manifest.md), [reference/publish.md](reference/publish.md).

### 4. Frontend rules

- **Iframe limits (hard):** Apps run under
  `sandbox="allow-scripts allow-same-origin"` and a Permissions Policy that sets
  camera, clipboard, fullscreen, geolocation, mic, and related features to `'none'`.
  **Never** implement downloads, `window.open` / `target="_blank"`, browser
  `alert`/`confirm`/`prompt`, or device/clipboard/fullscreen APIs — they will not
  work. In-page MUI Dialog/Drawer/Snackbar are fine. Full list:
  [reference/iframe-constraints.md](reference/iframe-constraints.md).
- **Stack:** React + MUI + `DigitThemeProvider`. Prefer theme palette / typography over
  hard-coded colors or custom CSS. See [reference/theming.md](reference/theming.md).
- **Mount to `#root`.** Do not create a different root id or remove `#root`.
- **Wrap the tree** with `DigitThemeProvider` in `main.tsx` (see the template).
- **Entry is IIFE `frontend/index.js`.** `@digit/lib-build` packs it — no alternate bundler.
- **Digit API:** `useDigitApiQuery` / `useDigitApiMutation`. Look up operations via
  `graphql-schema://…` first. Never call Digit GraphQL with a bearer token from the browser.
- **Sort / filter / page via the API:** When the GraphQL field (or backend route) accepts
  sort, filter, or connection/page inputs, use those — do not fetch a full list and
  sort/filter client-side when the API can do it. Confirm arg names via
  `graphql-schema://…`.
- **Tables need pagination:** Any MUI `Table` (or equivalent list of many rows) must be
  paginated — e.g. `connection: { first, after }` / page size + next/previous — not an
  unbounded dump of nodes.
- **Backend:** `useBackendQuery` / `useBackendMutation` — do not hand-roll `/proxy/backend`.
- **Public surface:** hooks + theme + `AppErrorAlert` only. Pair hook `error` with
  `AppErrorAlert` (`onRetry` when retryable) — do not branch on `AppErrorCode` in UI.

### 5. `manifest.json`

Keep it at the **project root**. Pack stages it at the zip root.

No `name`, no `entryFile`, no `compatibilityFlags` — display name lives on the app in
Digit; entries are conventions (`frontend/index.js`, `backend/index.js`).

```json
{
  "permissions": [],
  "backend": {
    "kind": "cloudflare-worker",
    "bindings": { "MY_APP_DB": "database" }
  }
}
```

Omit `backend` when the app is UI-only / Digit API only. `bindings` maps
`BINDING_NAME` → `"database"` (one D1 per app) or `"bucket"` (an R2 bucket for
file/blob storage, max 10). Names are `UPPER_SNAKE_CASE` and must not start with
`DIGIT_`.

Optional `backend.schedules` and on-demand jobs:
[reference/jobs-and-schedules.md](reference/jobs-and-schedules.md).
Optional `backend.webhooks` — public inbound POST endpoints at `/webhooks/{path}`; the
handler MUST verify the provider's signature over the raw bytes:
[reference/webhooks.md](reference/webhooks.md).
Full schema: [reference/manifest.md](reference/manifest.md).

### 6. Permissions

`permissions` is the **ceiling** for `/proxy/digit`. Digit intersects it with the viewing
user’s live permissions at runtime.

1. Call MCP **`appPermissions`**
2. Put each needed permission’s **`key`** into `manifest.permissions`
3. Never invent strings — unknown keys fail publish
4. Before pack/publish (checklist step 7), re-read `manifest.permissions` against
   **`appPermissions`** and the app’s Digit API calls — add any missing keys; drop unused
   ones only when you are sure nothing still needs them

Look up GraphQL fields with `graphql-schema://…`, then declare only the permissions those
operations need. Details: [reference/permissions.md](reference/permissions.md).

### 7. Env vars and secrets

Configured on the app in the Digit UI. Injected only into the Worker as `env.KEY`. Read
with `requireEnv` / `optionalEnv` inside `createHandler`. Frontend never embeds secrets —
read env-backed data via backend hooks.
[reference/backend-env-secrets.md](reference/backend-env-secrets.md).

### 8. Publish via MCP

```
apps → generateAppUploadLink → POST zip to uploadUrl → publishApp → poll appPublish
```

The zip does **not** travel through MCP. If you cannot HTTP POST the zip, stop and tell the
user. Run `npm run pack`, then upload **`app.zip` unchanged**.
Full steps: [reference/publish.md](reference/publish.md).

### 9. SPEC.md and local source

Update `SPEC.md` before pack — iteration context for the next agent (purpose, why each
permission/env exists, verbatim prompts, context supplied). Model:
[`examples/full-featured/SPEC.md`](../../../examples/full-featured/SPEC.md).
Details: [reference/spec.md](reference/spec.md).

Keep `apps/<name>/` source on disk. Do not commit build outputs or open PRs against this
upstream starter.

## Decision guide

| Need | Path |
| --- | --- |
| Any new app | Copy `full-featured`, delete unused tabs/routes |
| Digit GraphQL | Schema resources → hooks + `appPermissions` → `key` in manifest |
| Env / secrets / D1 / third-party HTTP | Worker + `@digit/lib-backend` |
| Codes / JSON validation | `@digit/lib-common` |

## Packages (`lib-*`)

Import from each package **root only**. Helpers use **named arguments**. Runtime packages
do **not** re-export each other. Use `@digit/lib-build` only via `npm run pack`.

| Package | When | Role |
| --- | --- | --- |
| `@digit/lib-frontend` | Always | Theme, harness types, data hooks, `AppErrorAlert` |
| `@digit/lib-backend` | Worker | `createHandler`, `backendPath`, `ok`/`err`, `requireEnv`, jobs |
| `@digit/lib-common` | With Worker (or code branching) | `AppErrorCode`, result types, validation |
| `@digit/lib-build` | Always (devDependency) | `digit-app pack` |

### Backend Worker

Always wrap with `createHandler`. Strip `/proxy/backend` via `backendPath`, match
`method` + `path`, return `ok` / `err`. Prefer `requireEnv` over reading `env.KEY`.
Jobs/schedules: `createHandler({ jobs })` + `digitJobs({ env })` —
[reference/jobs-and-schedules.md](reference/jobs-and-schedules.md). Webhooks:
`createHandler({ webhooks })`, verify with `verifyWebhookSignature` before acting —
[reference/webhooks.md](reference/webhooks.md). SQL migrations:
[reference/d1-migrations.md](reference/d1-migrations.md).

See `examples/full-featured/src/backend/index.js` for the reference layout.
Proxy details: [reference/proxy-and-api.md](reference/proxy-and-api.md).

## Additional resources

- [reference/iframe-constraints.md](reference/iframe-constraints.md) — sandboxed iframe limits (no downloads/popups/device APIs)
- [reference/theming.md](reference/theming.md) — DigitThemeProvider, MUI theme, DigitHost
- [reference/manifest.md](reference/manifest.md) — schema, backend block, validation rules
- [reference/proxy-and-api.md](reference/proxy-and-api.md) — schema resources, hooks, proxies
- [reference/permissions.md](reference/permissions.md) — appPermissions → key
- [reference/backend-env-secrets.md](reference/backend-env-secrets.md) — env/secrets in Workers
- [reference/jobs-and-schedules.md](reference/jobs-and-schedules.md) — jobs, schedules, DIGIT_JOBS
- [reference/webhooks.md](reference/webhooks.md) — inbound webhooks, signature verification
- [reference/d1-migrations.md](reference/d1-migrations.md) — database SQL applied on publish
- [reference/publish.md](reference/publish.md) — MCP publish workflow, live-source download, and zip rules
- [reference/spec.md](reference/spec.md) — SPEC.md iteration context
- [`packages/lib-build`](../../../packages/lib-build) — `digit-app pack` shared tooling
