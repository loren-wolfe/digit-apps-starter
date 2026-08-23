# App spec & provenance (`SPEC.md`)

Every app must ship a `SPEC.md`. It is **iteration context for a later agent** that has no
chat history and no harness memory — not a second README and not an API dump.

`README.md` is for humans using or setting up the app. `SPEC.md` answers: why this app
exists, what the user asked for, what constraints matter, and what gotchas aren’t obvious
from the source.

Write or update it as part of the workflow (before `npm run pack`), not as an afterthought.

In the publish zip, SPEC lives at `project/SPEC.md`. In a local clone it lives at the
app root next to `package.json`.

## What belongs in SPEC

Prefer **intent, provenance, and non-obvious gotchas**. Do **not** mirror `manifest.json`
or list every backend route — those live in source and drift when duplicated.

### What it does

2–4 sentences: purpose, who uses it, key behaviors, and constraints that aren’t obvious
from reading the code (pagination limits, units, client vs server aggregation, etc.).

### Data & permissions

- Permissions declared in `manifest.json` and **why** each is needed
- GraphQL fields relied on when relevant (root fields, important filters) — not a full schema dump
- Backend env vars / secrets and their purpose (**names only** — never values)
- Schema quirks or gotchas discovered while building

Skip a full route inventory; the Worker source is authoritative.

### Prompts

The prompts that produced this app, **verbatim**, in chronological order — the original
request plus follow-up refinements. This is the stand-in for missing chat history. Do not
paraphrase. If a prompt only makes sense with a note (e.g. “user rejected approach X”),
add a one-line note before it, but keep the prompt text unedited.

### Context supplied

Anything beyond the prompts that shaped the result: example app copied from, screenshots
or mockups, tickets/docs, an existing Digit object used as a model, schema notes, product
decisions the user made mid-build.

## Example

See [`examples/full-featured/SPEC.md`](../../../../examples/full-featured/SPEC.md) for a
realistic builder-perspective SPEC.

## Local workspace vs Digit zip

| Where | How the app is preserved |
| --- | --- |
| In-app agent sandbox | Live `project/` is already under `apps/<name>`. Edit in place (create-digit-app). |
| Fresh MCP workspace | Restore via **update-digit-app** (`app.currentPublish.downloadUrl` → unpack `project/`). |
| Published Digit app | `npm run pack` → `app.zip` (includes required `project/` source tree, including this SPEC). |

### Keep in the workspace

- `src/frontend/` — UI source
- `src/backend/` — Worker source (when the app has a backend)
- Root config: `manifest.json`, `package.json`, `package-lock.json`, `tsconfig.json`,
  `index.html` (if any), `README.md`, `SPEC.md`
- `package.json` must use `@digit/lib-build` (`"pack": "digit-app pack"`)

### Do not keep / do not commit

- Built `frontend/` and `backend/` (gitignored; only packed into `app.zip`)
- Per-app Vite configs or `scripts/pack.sh` — owned by `@digit/lib-build`
- `node_modules/`
- `.vite/`
- `*.zip` (`npm run pack` creates `app.zip` for Digit upload only)

### Workflow

```bash
# …verify… update SPEC.md if purpose/constraints changed…
npm run pack           # digit-app pack → build + app.zip
# Optional: local git commit in the clone for the user's own history — never push upstream
```