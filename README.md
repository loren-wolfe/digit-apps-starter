# digit-apps-starter

Skills, shared libraries, and example apps for building on the Digit Apps platform.

Agents clone this into a **local workspace**, scaffold under `apps/`, pack, and publish to
Digit. Keep app source under `apps/` in that workspace so later sessions can iterate.
This upstream repo does not accept contributions — do not open PRs or push here.

## Quick start

```bash
npm install                     # once per clone, from the repo root (Node 24)
npm run new-app -- my-app       # source checkout: scaffold an app
npm run pack -w apps/my-app     # build frontend/ (+ backend/) and write app.zip
```

This repo is one npm workspace (`packages/*`, `examples/*`, `templates/*`, `apps/*`). Always install from
the repo root — `@heysutton/cli` is linked with `file:`, so npm installs its Vite build
toolchain into the root `node_modules` rather than the app's.

The curated starter archive includes `apps/app/`, pre-scaffolded from the frontend-only
`examples/hello-world` with source, manifest, package metadata, and `SPEC.md`. It does not
include a backend or compiled build directories. In that downloaded archive, work in
`apps/app` instead of running `new-app`; use `new-app` only for another workspace.

## Agent skill

Agents should follow:

[`.agents/skills/sutton-app/SKILL.md`](.agents/skills/sutton-app/SKILL.md)

That skill covers:

- **React + MUI + `@heysutton/sdk-react`** (required default stack)
- `src/frontend` + `src/backend` source; sibling `frontend/` / `backend/` build outputs (pack only, not committed)
- Mounting to `#root` with `ThemeProvider`
- Root `manifest.json` (staged at the zip root by pack)
- Digit API access via `useApiQuery` / `/proxy/digit`
- Env vars and secrets (backend Worker injection only)
- Deploying a draft or publishing the app with Sutton tools (`publishAppZip` in App Builder, or
  MCP upload → `publishApp` with a channel → poll)

## Agent plugin

This repo is also the **Sutton** plugin, the home for Sutton agent skills in
[`.agents/skills/`](.agents/skills). The current skill is `sutton-app`, which
builds, drafts, and publishes Sutton Studio and custom apps:

- **Claude Code:** `/plugin marketplace add hey-sutton/sdk`, then
  `/plugin install sutton@sutton` (or `/plugin install sutton --marketplace hey-sutton/sdk` on 2.1.275+)
- **Codex:** `codex plugin marketplace add hey-sutton/sdk`, then
  `codex plugin add sutton@sutton`
- **Cursor:** a team admin imports this repo under **Import from Repo** in the team marketplace,
  or clone it into `~/.cursor/plugins/local/sutton`
- **Any other agent:** `npx skills add hey-sutton/sdk`

Manifests live in `.claude-plugin/`, `.cursor-plugin/`, `.codex-plugin/`, and
`.agents/plugins/marketplace.json`. Check Claude manifests with `claude plugin validate --strict .`.
None of these files ship in the starter zip.

Installed copies update when `version` changes. Don't edit it by hand: Release Please owns it.
A `feat:`, `fix:`, `docs:` or `chore:` commit that touches `.agents/` opens (or updates) a
`release sutton-plugin` PR that bumps `version` in all three `plugin.json` files and
`.release-please-manifest.json`, and adds an entry to `.agents/CHANGELOG.md`.
Merging it tags `sutton-plugin-vX.Y.Z`, and agents pick up the new version on their next
marketplace refresh. `feat:` bumps the minor version; the others bump the patch.

## Packages

| Package | Role |
| --- | --- |
| [`packages/sdk`](packages/sdk) (`@heysutton/sdk`) | Codes, result types, pure validation (no React / no `Response`) — depend directly when using a Worker |
| [`packages/sdk-react`](packages/sdk-react) (`@heysutton/sdk-react`) | Theme (the Figma design system), design-system components, harness types, Sutton/backend **hooks**, error UI, `printLabel` |
| [`packages/sdk-server`](packages/sdk-server) (`@heysutton/sdk-server`) | `createHandler`, `backendPath`, `ok`/`err`, env/secrets |
| [`packages/cli`](packages/cli) (`@heysutton/cli`) | `sutton studio pack` — shared Vite build + `app.zip` |
| [`packages/lib-common`](packages/lib-common) (`@digit/lib-common`) | Private, never published: re-exports `@heysutton/sdk` so apps packed before the rename still build. Don't use in new apps |

Runtime packages expose a slim root export for everyday app/Worker code. Other files
under `src/` are implementation details — do not deep-import them. Helpers use named
arguments. Runtime packages do **not** re-export each other.

Apps depend on them via `file:…` — not on private `digit-web`. With a Worker, depend on
`sdk-react` + `sdk-server` + `sdk`, plus `@heysutton/cli` as a devDependency.

## Example

[`examples/hello-world`](examples/hello-world) is the minimal frontend-only app used for
`apps/app` in the curated starter archive.

[`examples/full-featured`](examples/full-featured) is the reference app: theme, errors, Digit
API, public API, secrets, D1 CRUD, and env config. `npm run new-app` copies it into
[`apps/`](apps) — trim what you don’t need from there.

## Templates

[`templates/`](templates) holds integration apps you can copy and point at your own accounts.
None of them contain customer data: every store, key, and token is a secret or env var the
operator sets in Sutton.

| Template | Connects Sutton to |
| --- | --- |
| [`shipstation-template`](templates/shipstation-template) | ShipStation V1 or V2: push shipments, buy labels, pull tracking |
| [`woocommerce-fulfillment-template`](templates/woocommerce-fulfillment-template) | WooCommerce: deduct inventory and fulfill Sutton orders once WooCommerce completes them |
| [`shopify-item-publish-template`](templates/shopify-item-publish-template) | Two Shopify stores: publish a Sutton item as a Shopify product |

```bash
npm run new-app -- my-app --from woocommerce-fulfillment-template
```

## Publish reminder

1. Create the app in the Digit UI first (deployment does not create apps)
2. Write/update `SPEC.md`, then `npm run pack -w apps/<name>`
3. `app.zip` contains `frontend/` (+ `backend/` if declared) for Digit deploy, plus
   required `project/` (source, SPEC, tooling, vendored libs — not deployed)
4. Deploy a draft first when using Sutton App Builder; use the explicit Sutton web Publish
   action to promote it. Standalone MCP clients can choose `channel: "preview"` or
   `channel: "live"`; see the skill for the full flow.
5. Keep `apps/<name>` source in the local workspace (not build outputs); do not push or
   open PRs against this upstream repo

## Starter asset

On every merge to `main`, CI publishes a curated zip for other repos / agent sessions:

- Latest zip: [GitHub Releases (latest)](https://github.com/hey-sutton/sdk/releases/latest)
- Dated snapshots: `starter-YYYY.MM.DD-<sha>` (immutable git tags; the newest is marked latest)

```bash
curl -fsSL -o digit-apps-starter.zip \
  https://github.com/hey-sutton/sdk/releases/latest/download/digit-apps-starter.zip
unzip digit-apps-starter.zip
```

The archive includes the sutton-app skill, `examples/`, `templates/`, `packages/`, `scripts/`,
the packable source tree at `apps/app/`, and root install metadata — not `node_modules`
or build outputs. A consumer restoring a retained publish can replace `apps/app/`
entirely with that publish archive's `project/` tree while keeping the starter shell.

## License

See [LICENSE](LICENSE).
