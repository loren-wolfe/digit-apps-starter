---
name: sutton-app
description: >-
  Build, draft, and publish Sutton custom apps (React + MUI + Sutton theme via
  @heysutton/sdk-react, optional Cloudflare Worker backends via @heysutton/sdk-server,
  Vite IIFE bundles, manifest.json, Digit API proxy, env/secrets). Apps run in a
  locked-down sandboxed iframe (no popups, browser dialogs, clipboard read,
  or device APIs). Use when creating a Digit app, editing an app in a local clone
  of this starter, publishing via MCP, laying out screens, or when the user mentions
  Sutton apps, manifest.json, AppProxy, ThemeProvider, /proxy/digit, /proxy/backend,
  settings panels, status pills, tables, checklists, chat boxes, or confirmation dialogs, or
  asks for an app to look like Sutton, match the design system, or match a Figma mockup.
---

# Sutton App

Build Digit custom apps that run inside Digit as **sandboxed iframes** with a locked-down
Permissions Policy. Follow this skill end-to-end — do not invent alternate layouts,
mount targets, stacks, or publish flows, and do not build features the iframe cannot
support (new tabs/popups, direct browser dialogs, clipboard read, camera, etc.). The
host can do some of these on the app's behalf (scanning, for example), so call
`getHostCapabilities` before telling the user a feature can't be built.
Use `AppHost.invoke` from `@heysutton/sdk-react` for every host-mediated action:
`invoke("download", ...)` for files, `invoke("print", ...)` for printable HTML. `window.DigitHost`
(including its `download` and `print`) is deprecated — migrate it to `AppHost` in any file you
touch. See
[reference/iframe-constraints.md](reference/iframe-constraints.md).

**Default stack (required):** React + MUI + `@heysutton/sdk-react` (`ThemeProvider`).
Do not build vanilla HTML/CSS UI, invent a parallel design system, or skip the theme
package. Users are often non-developers — one path keeps apps looking and behaving
like Digit.

**Digit platform tools are required.** Use Digit MCP for standalone schema lookup,
permissions, app discovery, and publishing. When this skill runs inside Digit App Builder,
use the builder's platform tools for those same operations. If neither surface is available,
stop and ask the user to connect the Digit tools before continuing.

## When to use

- Creating a new Digit app from scratch
- Adapting one of the `examples/` or `templates/` starting points
- Declaring `manifest.json` permissions / backend
- Calling the Digit GraphQL API from an app
- Using app env vars or secrets (backend only)
- Publishing via Digit MCP tools

## Digit MCP (apps)

| Need                      | Use                                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Public GraphQL schema     | MCP resources `graphql-schema://index`, `graphql-schema://type/{TypeName}`, `graphql-schema://search/{query}` |
| Manifest permissions      | MCP tool **`appPermissions`** — put each permission’s **`key`** in `manifest.json`                            |
| Find an existing app’s id | MCP tool **`apps`**                                                                                           |
| Standalone publish        | **`generateAppUploadLink`** → HTTP POST zip → **`publishApp`** (`channel`) → poll **`appPublish`**            |
| App Builder deploy        | **`publishAppZip`** → draft; the Sutton web app's Publish action promotes it to the published app             |

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
- [ ] 3. Implement frontend (React + MUI + ThemeProvider → #root)
- [ ] 4. Add src/backend/ only if env/secrets or server logic needed
- [ ] 5. Look up GraphQL via graphql-schema://… and permissions via appPermissions
- [ ] 6. Write root manifest.json (permissions[].key from appPermissions)
- [ ] 7. Check manifest.permissions against appPermissions — confirm it covers every Digit API call the app makes
- [ ] 8. Write/update SPEC.md
- [ ] 9. npm run pack -w apps/<name> → app.zip
- [ ] 10. Deploy a draft (App Builder: `publishAppZip`; standalone MCP: `publishApp` with `channel: preview`)
- [ ] 11. If the user explicitly asks to ship, promote the current draft from the Sutton web app
- [ ] 12. Keep app source under apps/ — not build outputs; no upstream PRs
```

Schema and permission lookup (steps 5–7) must happen **before publish**. Do them as soon
as you know which Digit API calls the app makes — inventing fields or permission strings
fails at runtime or publish validation. Re-check step 7 whenever you add or change a Digit
API call.

The checklist tracks progress, not tool calls — a step is not one call. Batch whatever your
harness lets you batch: several schema lookups together, several file reads together, several
edits together, and search with a shell `grep -rn` rather than a walk per file. Spending a
round trip per file is the slowest way to work through this.

### 1. Scaffold the app

This repo is a single **npm workspace**. Apps live in `apps/<name>` — that depth is
required, because apps depend on the libraries via `file:../../packages/*`.

The curated starter archive already contains `apps/app`, pre-scaffolded from the
frontend-only `examples/hello-world` without build outputs. Use it when there is no
retained publish. Add `src/backend/` only when the app needs server-side functionality.
If a retained publish is supplied, its `project/` tree replaces `apps/app` entirely.
Run `new-app` only when adding another app workspace:

```bash
npm install                     # once per clone, from the repo root
npm run new-app -- my-app       # copies examples/full-featured → apps/my-app
npm run new-app -- my-app --from shipstation-template   # copies templates/shipstation-template
```

For a ShipStation, WooCommerce fulfillment, or Shopify item publish integration, start from
the matching folder in [`templates/`](../../../templates/README.md) instead of
`full-featured`.

`new-app` copies the template, renames the package, writes a `SPEC.md` stub, and re-runs
`npm install` so the workspace links the new app. Trim what you don't need from the copy —
do not invent a new project shape.

The template covers theme, errors, Digit GraphQL (`useApiQuery`), public API, secrets,
D1 via the Worker (`useBackendQuery` / `@heysutton/sdk-server`), and env config. Keep the
`@heysutton/cli` devDependency and `"pack": "sutton studio pack"` — do **not** add Vite
configs, a local pack script, or a per-app `npm install`.

**Always install from the repo root.** `@heysutton/cli` is a `file:` link, so npm puts
its build toolchain (Vite) in the root `node_modules`, not the app's. Running `npm install`
only inside `apps/<name>` leaves Vite missing and `pack` fails.

All apps share React + MUI + `@heysutton/sdk-react` and the same folder conventions.
There is no local Sutton runtime draft (Worker, env/secrets, and D1 are platform-injected).
`npm run pack` produces the same channel-neutral `app.zip` for a remote draft or a published
deployment.

### Draft and production

The Sutton App Builder is draft-first:

- Pack the app, then call `publishAppZip` to deploy the zip to the owner's draft. A
  successful draft deploy does **not** change the published app.
- Talk about that result as “built a draft,” never “published.” Keep iterating by packing
  and deploying another draft.
- The Sutton web app's explicit Publish action promotes the current draft build to the published app.
  Publish ships the reviewed build and applies pending migrations on the published app only — it is not a
  config promote. **Promote does not wipe published env/secrets** — draft shares published env and
  secrets, and Sutton Settings write the published app only. Nothing is copied from draft onto the published app for
  env or secrets.

Standalone MCP clients use `publishApp` directly and may choose `channel: "preview"` or
`channel: "live"`. Omitting `channel` remains the backwards-compatible published behavior, so do
not omit it when a standalone workflow is meant to deploy a draft. The draft and the published app have separate
Workers, D1 databases, R2 buckets, and bundle pointers; draft is owner-only.

Draft is not production-equivalent for every backend feature:

- Draft sessions use the viewer's Sutton permissions for GraphQL reads and writes,
  still limited to `manifest.permissions`. App-owned D1/R2 writes stay in draft resources.
- **Schedules run on the published app only.** Draft cron, inbound webhooks, and other timer/webhook side
  effects stay off. On-demand jobs are scoped to the draft job namespace when invoked, but
  should not be treated as a production run.
- Draft uses the **published env vars and published secrets**. Sutton Settings that edit env or
  secrets update **the published app only**. Guard or
  disable external side effects; do not seed published data into draft by default.

Full deployment details and safety notes: [reference/publish.md](reference/publish.md),
[reference/backend-env-secrets.md](reference/backend-env-secrets.md), and
[reference/draft-and-publish.md](reference/draft-and-publish.md).

**Debugging a published app.** The harness forwards uncaught errors, unhandled rejections,
`console.error` / `console.warn`, bundle load failures and failed Digit API / backend calls
to the Sutton host. In Sutton Studio they appear in the draft's Console tab and are attached
to the next chat message automatically; elsewhere ask the user to copy them from the Console
tab. Report unexpected states with `console.error` (not `console.log`) so they get there, and
never replace `console.error` or `window.onerror` — wrapping them breaks forwarding.

### 2. App must already exist in Digit

Publishing **never creates** an app. Ask the user to create the app in the Digit UI first,
then resolve its `id` with MCP **`apps`** (or have the user paste it).

### 3. Project layout

```
apps/my-app/
├── package.json            # @heysutton/sdk* ; "pack": "sutton studio pack"
├── manifest.json           # staged at zip root by sutton studio pack
├── SPEC.md
├── src/frontend/           # main.tsx → #root + ThemeProvider; App.tsx
├── src/backend/            # optional Worker (index.js, migrations/)
├── frontend/               # BUILD — gitignored; frontend/index.js entry
└── backend/                # BUILD when Worker present — gitignored
```

Edit `src/frontend` and `src/backend` only. Harness types come from `@heysutton/sdk-react`
— no local `digit.d.ts`. Prefer data hooks over calling `window.AppProxy`.

```bash
npm run pack -w apps/my-app     # from repo root → app.zip
```

`app.zip` has root `manifest.json`, `frontend/` (+ `backend/` when declared), and
`project/` (source + vendored `@heysutton/sdk*`). Digit deploys `frontend/` / `backend/`
only; still upload the zip **unchanged**. Details:
[reference/manifest.md](reference/manifest.md), [reference/publish.md](reference/publish.md).

**Older apps on `@digit/lib-*`.** Apps packed before the SDK rename import `@digit/lib-*`
and carry their own vendored copies under `packages/lib-*`. They keep working as they are.
Don't migrate them to `@heysutton/sdk*`, and don't mix the two names in one app: leave
their `package.json` and imports on `@digit/lib-*` and pack them as usual.
Some lack `packages/lib-common`; the starter's private `packages/lib-common` shim (re-exports
`@heysutton/sdk`) resolves it, so don't copy or recreate it in the app.

### 4. Frontend rules

- **Iframe limits (hard):** Apps run under
  `sandbox="allow-scripts allow-same-origin allow-forms"` and a Permissions Policy
  that sets camera, clipboard-read, fullscreen, geolocation, mic, and related
  features to `'none'`. **Never** implement direct downloads, `window.open` /
  `target="_blank"`, browser `alert`/`confirm`/`prompt`, or device/clipboard-read/
  fullscreen APIs — they will not work. Copy buttons (`navigator.clipboard.writeText`
  in a click handler), form `onSubmit` + `preventDefault`, file exports via
  `invoke("download", ...)`, and HTML printing via `invoke("print", ...)` DO work. In-page MUI
  Dialog/Drawer/Snackbar are fine. Never ask to loosen the iframe sandbox. Where the
  iframe can't do something itself (camera, scanning, navigating Digit), check
  `getHostCapabilities` for a host method that does it before ruling it out. Full
  list: [reference/iframe-constraints.md](reference/iframe-constraints.md).
- **Look and layout:** follow [Design system](#design-system-required-for-every-screen) below.
- **Mount to `#root`.** Do not create a different root id or remove `#root`.
- **Wrap the tree** with `ThemeProvider` in `main.tsx` (see the template).
- **Entry is IIFE `frontend/index.js`.** `@heysutton/cli` packs it — no alternate bundler.
- **Digit API:** `useApiQuery` / `useApiMutation`. Look up operations via
  `graphql-schema://…` first. Never call Digit GraphQL with a bearer token from the browser.
- **Sort / filter / page via the API:** When the GraphQL field (or backend route) accepts
  sort, filter, or connection/page inputs, use those — do not fetch a full list and
  sort/filter client-side when the API can do it. Confirm arg names via
  `graphql-schema://…`.
- **Backend:** `useBackendQuery` / `useBackendMutation` — do not hand-roll `/proxy/backend`.
- **Errors:** pair a hook's `error` with `AppErrorAlert` (`onRetry` when retryable) — do not
  branch on `AppErrorCode` in UI.

#### Printing

When the user wants invoices, labels, packing slips, or reports, print through the host with
`await AppHost.invoke("print", { title, html })`. Do not use `window.open`,
`target="_blank"`, blob navigation, or a new print window. Never request `allow-modals`,
`allow-popups`, or `allow-downloads` on the app iframe.

Print HTML is a snapshot, not a live app. The host sanitizes it and no JavaScript runs in
the print document. Build a dedicated receipt/print view or hidden print root and serialize
that element with `outerHTML`; do not dump the full SPA chrome with
`document.documentElement.outerHTML`.

Before sending HTML:

- Inline CSS in `<style>` or `style` attributes. The host strips `<link
rel="stylesheet">`, and the print CSP blocks network CSS.
- Fetch images as blobs and convert them with `FileReader` or canvas to `data:image/...`.
  Remote `http(s)` images do not load (`img-src data:`). This is the first thing to check
  when a print is missing images.
- Replace canvas and chart output with `<img src="${canvas.toDataURL('image/png')}">`.
- Use system fonts, or `@font-face` with a `data:` font URL. Remote fonts such as Google
  Fonts do not load.
- Copy printable values into normal elements such as `p`, `table`, `span`, and `div`.
  The host removes `form` (and `script` / `iframe` / `link` / `meta`). `input`, `select`,
  `textarea`, and `button` stay but are inert, and React live values usually are not in
  the HTML.
- Keep the UTF-8 payload under 10MB after inlining. Compress images and print only the
  receipt or report content.
- Use a 1-119 character title made from ASCII letters or digits plus spaces, `.`, `_`, `-`,
  `(`, and `)`. It must start with a letter or digit. Accents and emoji are not allowed.

Do not send PDF bytes to the print call. Download a PDF instead:
`invoke("download", { filename, contentType: "application/pdf", data })`. Printing only
accepts HTML and opens the browser print dialog.

**Sutton labels (inventory, item):** read [reference/labels.md](reference/labels.md) before writing label code. Use `LabelPrintPanel`. Never draw the label, load its records, or call `AppHost.invoke("printLabel")` yourself.

#### Host-mediated actions (`AppHost.invoke`)

Every host-mediated action goes through one generic call, `AppHost.invoke(method, params?)`
(`import { AppHost } from "@heysutton/sdk-react"`), which returns a promise:

- the host succeeded — it **resolves with the result data**.
- the user dismissed a host UI — it **resolves with `null`**. That is a normal outcome, not
  a failure; do not surface it as an error.
- the host refused or failed — it **rejects** with an `Error`. Handle it like any other
  async failure (`AppErrorAlert`, etc.).

Call `getHostCapabilities` before writing the code, and before ruling out a feature the iframe
can't do itself — it returns each method's name, params and a
note on what it does, so you never guess one. Read that note: some capabilities replace the whole
Digit page, which unmounts your app. Then call `invoke` directly: do not guard it with a runtime
capability check. The host offers whatever the Digit it runs inside supports, capabilities are
only ever added, and a method it does not offer simply rejects, like any other failure.

```ts
const result = await AppHost.invoke("openModal", { modal: "item", id })
```

No optional chaining needed: outside Digit (tests, a local page) `invoke` simply rejects.

Never call `AppHost.invoke("printLabel", ...)` directly, even though `getHostCapabilities` lists
it. The helpers space calls one second apart and send the exact keys the host validates. A
hand-rolled call fails with "Too many calls" or "Invalid params". Use the label components in
[reference/labels.md](reference/labels.md).

`window.DigitHost` still works, including its `download(...)` and `print(...)`, but it is
deprecated. Write new code against `AppHost`, and migrate `window.DigitHost` calls in any
existing file you edit.

### Design system (required for every screen)

Sutton apps sit next to the platform's own screens, so they must look like them. The **Figma
design system is the source of truth**, and `@heysutton/sdk-react` implements it in two layers:

- **The theme** (`ThemeProvider`) restyles every MUI component to the Figma values, in light
  and dark. A plain `<Button>`, `<TextField>` or `<Tabs>` already looks right.
- **Library components** (`PageHeader`, `DataTable`, `StatusPill`, `SidePanel`, `Modal`, …) group themed
  MUI parts into the larger pieces Figma defines, such as a page header, an index table or a
  form dialog.

You pick and compose those pieces. You never restyle them.

**Work in this order:**

1. Before any UI, read [reference/design-system.md](reference/design-system.md). It has the
   rules, the component picker and the tokens.
2. For each screen, copy the closest recipe in
   [reference/design-patterns.md](reference/design-patterns.md) (list page, details panel,
   record page, settings, form dialog, confirm, dashboard, …).
3. Look up a component's props in [reference/components.md](reference/components.md) when you use it.
4. When you finish, run the self-check at the end of design-system.md on every screen and fix
   what fails.

**The rules that matter most.** Breaking any of these makes an app look like stock MUI instead
of Sutton:

- Use the library component when one exists. Never rebuild it from `Box` and `Typography`.
- Never set colour, background, border, radius, shadow, font, height or padding on a themed
  component, and never use hex colours, px font sizes or `fontWeight`. Layout props (`gap`,
  `flex`, `width`, margins) are fine.
- Every screen starts with `PageHeader`. Lists are a full-bleed `DataTable` with no card around them.
- Every status is a `StatusPill`. Icons are Lucide, imported from `@heysutton/sdk-react`.

If a screen needs something the library and the recipes do not cover, build it from themed MUI
parts with layout props only, and mention the gap in `SPEC.md`. Do not invent new colours,
sizes or shapes.


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

Optional `backend.schedules` run on the **published app only** (draft cron stays off) — see
[reference/jobs-and-schedules.md](reference/jobs-and-schedules.md).
Optional `backend.webhooks` — public inbound POST endpoints at `/webhooks/{path}`
(**published app only**; draft Hosts 404); the handler MUST verify the provider's signature over
the raw bytes: [reference/webhooks.md](reference/webhooks.md).
Full schema: [reference/manifest.md](reference/manifest.md).

### 6. Permissions

`permissions` is the **ceiling** for `/proxy/digit` and the backend's `api.query`. Sutton
intersects it with the acting user’s live permissions at runtime (the viewer).

1. Call MCP **`appPermissions`**
2. Put each needed permission’s **`key`** into `manifest.permissions`
3. Never invent strings — unknown keys fail publish
4. Before pack/publish (checklist step 7), re-read `manifest.permissions` against
   **`appPermissions`** and the app’s Digit API calls — add any missing keys; drop unused
   ones only when you are sure nothing still needs them

Look up GraphQL fields with `graphql-schema://…`, then declare only the permissions those
operations need. Details: [reference/permissions.md](reference/permissions.md).

Printing Sutton labels needs its own permissions. See
[reference/labels.md#manifest-permissions](reference/labels.md#manifest-permissions).

### 7. Env vars and secrets

Configured on the app in Digit Settings (UI only). Injected only into the Worker as
`env.KEY`. Read with `requireEnv` / `optionalEnv` inside `createHandler`. Frontend never
embeds secrets — read env-backed data via backend hooks.

Draft uses the **same published env vars and published secrets**. Settings edits update the published app only.
**Promote does not wipe published env/secrets.** Nothing is copied from draft onto the published app for env
or secrets — draft already shares them, and promote is not a config copy. Details:
[reference/backend-env-secrets.md](reference/backend-env-secrets.md).

### 8. Deploy or publish

```
pack → draft (App Builder: publishAppZip; standalone MCP: publishApp channel=preview)
draft → explicit Sutton web Publish action → published app
```

The zip does **not** travel through standalone MCP. If you cannot upload it, stop and tell the
user. Run `npm run pack`, then use **`app.zip` unchanged**. Do not call a publish to the published app just to
make a draft, and do not describe a successful draft deploy as production.
Full steps: [reference/publish.md](reference/publish.md).

### 9. SPEC.md and local source

Update `SPEC.md` before pack — iteration context for the next agent (purpose, why each
permission/env exists, verbatim prompts, context supplied). Model:
[`examples/full-featured/SPEC.md`](../../../examples/full-featured/SPEC.md).
Details: [reference/spec.md](reference/spec.md).

Keep `apps/<name>/` source on disk. Do not commit build outputs or open PRs against this
upstream starter.

## Decision guide

| Need                                   | Path                                                            |
| -------------------------------------- | --------------------------------------------------------------- |
| Any new app                            | Copy `full-featured`, delete unused tabs/routes                 |
| Digit GraphQL                          | Schema resources → hooks + `appPermissions` → `key` in manifest |
| Env / secrets / D1 / third-party HTTP  | Worker + `@heysutton/sdk-server`                                |
| Codes / JSON validation                | `@heysutton/sdk`                                                |
| Print a Sutton inventory or item label | `LabelPrintPanel` → [reference/labels.md](reference/labels.md)  |
| Which component to use, and how it should look | [reference/design-system.md](reference/design-system.md) |
| A component's props                   | [reference/components.md](reference/components.md)              |
| Screen layout: lists, records, panels, settings, dialogs, dashboards | Recipe from [reference/design-patterns.md](reference/design-patterns.md) |

## Packages (`@heysutton/sdk*`)

Import from each package **root only**. Helpers use **named arguments**. Runtime packages
do **not** re-export each other. Use `@heysutton/cli` only via `npm run pack`.
Use the current export names (`ThemeProvider`, `useApiQuery`, `useApiMutation`, `appJobs`).
The old `Digit*` names (`DigitThemeProvider`, `useDigitApiQuery`, `digitJobs`, …) are
deprecated aliases; don't use them in new code.

| Package                 | When                            | Role                                                                                                                                    |
| ----------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `@heysutton/sdk-react`  | Always                          | Theme, harness types, data hooks, design-system components (`PageHeader`, `DataTable`, `StatusPill`, `SidePanel`, `Modal`, `ConfirmDialog`, …), Lucide icons, `AppErrorAlert`, label printing |
| `@heysutton/sdk-server` | Worker                          | `createHandler`, `backendPath`, `ok`/`err`, `requireEnv`, jobs                                                                          |
| `@heysutton/sdk`        | With Worker (or code branching) | `AppErrorCode`, result types, validation                                                                                                |
| `@heysutton/cli`        | Always (devDependency)          | `sutton studio pack`                                                                                                                    |

### Backend Worker

Always wrap with `createHandler`. Strip `/proxy/backend` via `backendPath`, match
`method` + `path`, return `ok` / `err`. Prefer `requireEnv` over reading `env.KEY`.
Sutton API: use the `api` argument `fetch` receives (`api.query(...)`) — never an API token;
it acts as the requesting user, and jobs/schedules/webhooks have no Sutton API for now —
[reference/proxy-and-api.md](reference/proxy-and-api.md#sutton-api-from-the-backend).
Jobs/schedules: `createHandler({ jobs })` + `appJobs({ env })` —
[reference/jobs-and-schedules.md](reference/jobs-and-schedules.md). Webhooks:
`createHandler({ webhooks })`, verify with `verifyWebhookSignature` before acting —
[reference/webhooks.md](reference/webhooks.md). SQL migrations:
[reference/d1-migrations.md](reference/d1-migrations.md).

See `examples/full-featured/src/backend/index.js` for the reference layout.
Proxy details: [reference/proxy-and-api.md](reference/proxy-and-api.md).

## Additional resources

- [reference/iframe-constraints.md](reference/iframe-constraints.md) — sandboxed iframe limits, host-mediated downloads, and printing
- [reference/labels.md](reference/labels.md) for Sutton label preview and print, permissions, and failures
- [reference/theming.md](reference/theming.md) — ThemeProvider, MUI theme, AppHost settings
- [reference/design-system.md](reference/design-system.md) — **read before any UI**: rules, component picker, type, colour, spacing, icons, self-check
- [reference/design-patterns.md](reference/design-patterns.md) — screen recipes from the product mockups: list page, details panel, record page, settings, form dialog, confirm, dashboard
- [reference/components.md](reference/components.md) — props and conventions for each component; look up as needed
- [reference/manifest.md](reference/manifest.md) — schema, backend block, validation rules
- [reference/proxy-and-api.md](reference/proxy-and-api.md) — schema resources, hooks, proxies
- [reference/permissions.md](reference/permissions.md) — appPermissions → key
- [reference/backend-env-secrets.md](reference/backend-env-secrets.md) — env/secrets in Workers
- [reference/jobs-and-schedules.md](reference/jobs-and-schedules.md) — jobs, schedules, DIGIT_JOBS
- [reference/webhooks.md](reference/webhooks.md) — inbound webhooks, signature verification
- [reference/d1-migrations.md](reference/d1-migrations.md) — database SQL applied on publish
- [reference/publish.md](reference/publish.md) — draft/published deployment workflows and zip rules
- [reference/draft-and-publish.md](reference/draft-and-publish.md) — channel behavior and draft safety
- [reference/spec.md](reference/spec.md) — SPEC.md iteration context
- [`packages/cli`](../../../packages/cli) — `sutton studio pack` shared tooling
