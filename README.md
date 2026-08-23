# digit-apps-starter

Skills, shared libraries, and example apps for building on the Digit Apps platform.

Agents clone this into a **local workspace**, pack, and publish to Digit.
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

## Agent skills

| Skill | Who | When |
| --- | --- | --- |
| [create-digit-app](.agents/skills/create-digit-app/SKILL.md) | In-app agent **and** MCP | New apps, or edits when source is already on disk |
| [update-digit-app](.agents/skills/update-digit-app/SKILL.md) | **MCP only** | Change a **published** app from a **fresh** workspace (download live source first) |

The curated **starter zip** (in-app harness) ships **create-digit-app only**.
Claude users working through Digit MCP install the **Digit Apps** plugin, which
bundles both skills.

The create skill covers:

- **React + MUI + `@digit/lib-frontend`** (required default stack)
- `src/frontend` + `src/backend` source; sibling `frontend/` / `backend/` build outputs (pack only, not committed)
- Mounting to `#root` with `DigitThemeProvider`
- Root `manifest.json` (staged at the zip root by pack)
- Digit API access via `useDigitApiQuery` / `/proxy/digit`
- Env vars and secrets (backend Worker injection only)
- Publishing with Digit MCP (`apps` → upload zip → `publishApp` → poll)

## Claude plugin (Digit MCP users)

The native, non-technical install path is the **Digit Apps** Claude plugin:

1. In Claude, open **Customize → Plugins**.
2. Click **+ → Add marketplace → Add from a repository**.
3. Enter `Digit-Technologies/digit-apps-starter`.
4. Install **Digit Apps**.

The plugin bundles create-digit-app and update-digit-app. Users add the
marketplace once; Claude checks that marketplace for plugin updates, and users
can also select **Update** on the marketplace. No skill ZIP or shell script is
required.

### Publish to the Claude plugin directory

Listing the plugin in Anthropic's directory removes the "add a marketplace" step
entirely — users find **Digit Apps** under **Browse plugins** and click Install.

1. Bump `version` in [`.claude-plugin/plugin.json`](.claude-plugin/plugin.json).
2. Validate locally: `claude plugin validate .` (add `--strict` for CI parity).
3. Submit this **public** repo URL through one of Anthropic's in-app forms:
   - [claude.ai directory submission](https://claude.ai/admin-settings/directory/submissions/plugins/new)
     (Team/Enterprise org with directory-management access)
   - [Console submission](https://platform.claude.com/plugins/submit)
     (Developer/Admin/Owner on a Console org)
   - Short link: [clau.de/plugin-directory-submission](https://clau.de/plugin-directory-submission)
4. Track review status at
   [claude.ai/admin-settings/directory/submissions](https://claude.ai/admin-settings/directory/submissions).

Approved plugins are pinned by commit SHA in
[`anthropics/claude-plugins-community`](https://github.com/anthropics/claude-plugins-community)
and the catalog syncs nightly. After approval, pushes to `main` are mirrored
automatically — no re-submission per release, but still bump `version` so
installed users receive the update.

Reference: [Submitting your plugin](https://claude.com/docs/plugins/submit) and
[plugin marketplaces](https://code.claude.com/docs/en/plugin-marketplaces).

**Team / Enterprise note:** organization-synced marketplaces
([admin guide](https://support.claude.com/en/articles/13837433-manage-plugins-for-your-organization))
require a **private or internal** GitHub repo, so this public repo can't be
connected that way. Customer orgs that want **Installed by default** or
**Required** distribution should mirror the plugin into a private marketplace
repo of their own.

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
2. Fresh MCP workspace + existing publish: follow **update-digit-app** (download
   `currentPublish.downloadUrl`) before editing. In-app agent: skip — source is
   already on disk
3. Write/update `SPEC.md`, then `npm run pack -w apps/<name>`
4. `app.zip` contains `frontend/` (+ `backend/` if declared) for Digit deploy, plus
   required `project/` (source, SPEC, tooling, vendored libs — not deployed)
5. Use the MCP publish flow in create-digit-app
6. Do not push or open PRs against this upstream repo

## Starter asset

On every merge to `main`, CI publishes a curated zip for other repos / agent sessions:

- Floating release: [`starter-latest`](https://github.com/Digit-Technologies/digit-apps-starter/releases/tag/starter-latest)
- Dated releases: `starter-YYYY.MM.DD-<sha>` (same asset, immutable)

```bash
curl -fsSL -o digit-apps-starter.zip \
  https://github.com/Digit-Technologies/digit-apps-starter/releases/latest/download/digit-apps-starter.zip
unzip digit-apps-starter.zip
```

The archive includes **create-digit-app only** (not update-digit-app), `examples/`,
`packages/`, `scripts/`, the packable source tree at `apps/app/`, and root
install metadata — not `node_modules` or build outputs. Claude + Digit MCP users
get both skills through the [Digit Apps plugin](#claude-plugin-digit-mcp-users).

## License

See [LICENSE](LICENSE).

