# Examples

[`hello-world/`](hello-world) is the minimal frontend-only example used to pre-scaffold
`apps/app` in the curated starter archive.

[`full-featured/`](full-featured) is the reference Digit app. Copy it and remove tabs /
routes you don’t need rather than inventing a new project shape.

[`production-dashboard/`](production-dashboard) and [`timecard/`](timecard) are Sutton
Studio's official templates. Each ships a `preview.jpg`: the card image Studio shows for
that template under starting points (digit-api serves its `raw.githubusercontent.com` URL
from `main`). Pack leaves it out of `app.zip`, and `npm run new-app -- --from <example>`
does not copy it.

Integration templates (ShipStation, WooCommerce fulfillment, Shopify item publish) live in
[`../templates/`](../templates), not here.

**Stack:** React + MUI + [`@heysutton/sdk-react`](../packages/sdk-react). Workers use
[`@heysutton/sdk-server`](../packages/sdk-server) + [`@heysutton/sdk`](../packages/sdk)
(codes / validation — depend directly; packages do not re-export each other). Tooling:
[`@heysutton/cli`](../packages/cli) (`sutton studio pack`).

Shared conventions (also enforced by the skill):

- Source lives under `src/frontend/` and (when needed) `src/backend/`
- Build outputs are sibling `frontend/` and `backend/` — gitignored; only in `app.zip` via pack
- Wrap UI in `ThemeProvider`; use MUI components
- Mount to `#root`
- Harness types come from `@heysutton/sdk-react` — no local `digit.d.ts`
- Prefer `useApiQuery` / `useBackendQuery` (and mutations) from `@heysutton/sdk-react`
  (hooks only — pair errors with `AppErrorAlert`)
- Workers: `createHandler` + `backendPath` + `requireEnv` / `ok` / `err` from
  `sdk-server`; `AppErrorCode` / parsers from `sdk`
- Root `manifest.json`; `sutton studio pack` stages it at the zip root
- `npm run pack` → `app.zip` with root `manifest.json` + `frontend/` (+ `backend/`) for
  Digit deploy and required `project/` (source, `SPEC.md`, tooling, vendored
  `@heysutton/sdk*` incl. `@heysutton/cli` — not deployed)
- Do not copy Vite configs or pack scripts into each example — use `@heysutton/cli`
- Ignore `node_modules/`, `.vite/`, `*.zip`, and build folders
