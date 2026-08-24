# digit-apps-starter

Skills, shared libraries, and example apps for building on the Digit Apps platform.

Agents clone this into a **local workspace**, scaffold under `apps/`, pack, and publish to
Digit. Keep app source under `apps/` in that workspace so later sessions can iterate.
This upstream repo does not accept contributions — do not open PRs or push here.

## Quick start

```bash
npm install                     # once per clone, from the repo root (Node 22+)
npm run new-app -- my-app       # source checkout: scaffold an app
npm run pack -w apps/my-app     # build frontend/ (+ backend/) and write app.zip
```

This repo is one npm workspace (`packages/*`, `examples/*`, `apps/*`). Always install from
the repo root — `@digit/lib-build` is linked with `file:`, so npm installs its Vite build
toolchain into the root `node_modules` rather than the app's.

The curated starter archive includes `apps/app/`, pre-scaffolded from the frontend-only
`examples/hello-world` with source, manifest, package metadata, and `SPEC.md`. It does not
include a backend or compiled build directories. In that downloaded archive, work in
`apps/app` instead of running `new-app`; use `new-app` only for another workspace.

## Agent skill

Agents should follow:

[`.agents/skills/create-digit-app/SKILL.md`](.agents/skills/create-digit-app/SKILL.md)

That skill covers:

- **React + MUI + `@digit/lib-frontend`** (required default stack)
- `src/frontend` + `src/backend` source; sibling `frontend/` / `backend/` build outputs (pack only, not committed)
- Mounting to `#root` with `DigitThemeProvider`
- Root `manifest.json` (staged at the zip root by pack)
- Digit API access via `useDigitApiQuery` / `/proxy/digit`
- Env vars and secrets (backend Worker injection only)
- Publishing with Digit MCP (`apps` → upload zip → `publishApp` → poll)

## Packages

| Package | Role |
| --- | --- |
| [`packages/lib-common`](packages/lib-common) (`@digit/lib-common`) | Codes, result types, pure validation (no React / no `Response`) — depend directly when using a Worker |
| [`packages/lib-frontend`](packages/lib-frontend) (`@digit/lib-frontend`) | Theme, harness types, Digit/backend **hooks**, error UI |
| [`packages/lib-backend`](packages/lib-backend) (`@digit/lib-backend`) | `createHandler`, `backendPath`, `ok`/`err`, env/secrets |
| [`packages/lib-build`](packages/lib-build) (`@digit/lib-build`) | `digit-app pack` — shared Vite build + `app.zip` |

Runtime packages expose a slim root export for everyday app/Worker code. Other files
under `src/` are implementation details — do not deep-import them. Helpers use named
arguments. Runtime packages do **not** re-export each other.

Apps depend on them via `file:…` — not on private `digit-web`. With a Worker, depend on
`lib-frontend` + `lib-backend` + `lib-common`, plus `lib-build` as a devDependency.

## Example

[`examples/hello-world`](examples/hello-world) is the minimal frontend-only app used for
`apps/app` in the curated starter archive.

[`examples/full-featured`](examples/full-featured) is the reference app: theme, errors, Digit
API, public API, secrets, D1 CRUD, and env config. `npm run new-app` copies it into
[`apps/`](apps) — trim what you don’t need from there.

## Publish reminder

1. Create the app in the Digit UI first (MCP cannot create apps yet)
2. Write/update `SPEC.md`, then `npm run pack -w apps/<name>`
3. `app.zip` contains `frontend/` (+ `backend/` if declared) for Digit deploy, plus
   required `project/` (source, SPEC, tooling, vendored libs — not deployed)
4. Use the MCP publish flow documented in the skill
5. Keep `apps/<name>` source in the local workspace (not build outputs); do not push or
   open PRs against this upstream repo

## Starter asset

On every merge to `main`, CI publishes a curated zip for other repos / agent sessions:

- Latest zip: [GitHub Releases (latest)](https://github.com/Digit-Technologies/digit-apps-starter/releases/latest)
- Dated snapshots: `starter-YYYY.MM.DD-<sha>` (immutable git tags; the newest is marked latest)

```bash
curl -fsSL -o digit-apps-starter.zip \
  https://github.com/Digit-Technologies/digit-apps-starter/releases/latest/download/digit-apps-starter.zip
unzip digit-apps-starter.zip
```

The archive includes the create-digit-app skill, `examples/`, `packages/`, `scripts/`,
the packable source tree at `apps/app/`, and root install metadata — not `node_modules`
or build outputs. A consumer restoring a retained publish can replace `apps/app/`
entirely with that publish archive's `project/` tree while keeping the starter shell.

## License

See [LICENSE](LICENSE).

