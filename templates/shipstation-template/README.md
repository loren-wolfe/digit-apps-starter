# ShipStation template

A Sutton app (React + MUI frontend, Cloudflare Worker backend, D1 database) that connects one
ShipStation account to Sutton shipments: push eligible shipments to ShipStation, then pull
tracking back.

There are two things you can start from this folder:

1. **The Sutton app itself.** It only runs inside Sutton, so "starting" it means packing and
   publishing it.
2. **The local sandbox viewer.** A small dev tool you run on your machine to browse ShipStation
   sandbox shipments, buy test labels, and void them.

## Prerequisites

- Node 24 or newer
- `zip` on your PATH (the pack step shells out to it)
- Run `npm install` once from the **repo root** (`digit-apps-starter/`), not from this folder.
  The `@heysutton/*` packages are linked with `file:`, so the build toolchain installs into
  the root `node_modules`.

```bash
cd digit-apps-starter
npm install
cd templates/shipstation-template
```

## Run the sandbox viewer (local)

ShipStation's sandbox is a V2 API key that starts with `TEST_`. It uses the same endpoints as
production and never shows up in the ShipStation web UI, so this viewer is the easy way to see
your test shipments.

1. Create the env file and paste your sandbox key into it:

   ```bash
   cp tools/sandbox-viewer/.env.local.example tools/sandbox-viewer/.env.local
   ```

   `SHIPSTATION_API_KEY=TEST_...` is the only required value. `.env.local` is gitignored by
   the repo's `.env.*` rule.

2. Start it:

   ```bash
   npm run sandbox-viewer
   ```

3. Open <http://127.0.0.1:4321>. Set `SANDBOX_VIEWER_PORT` in `.env.local` to change the port.

If the key does not start with `TEST_`, the console and the page warn that it looks like a
production key, because creating a label would then buy a real one.

More detail (routes, how void works, wiring): [tools/sandbox-viewer/README.md](tools/sandbox-viewer/README.md).

## Run the Sutton app

The app has no local dev server. It runs in Sutton's sandboxed iframe with the backend on a
Worker, so you pack it and publish it.

1. **Create the app in the Sutton UI first.** MCP cannot create apps.
2. **Add the app secrets in Sutton** (Sutton's App Secrets UI, never the app itself):

   | Secret | Needed for |
   | --- | --- |
   | `SHIPSTATION_API_KEY` | A key alone connects ShipStation **V2** |
   | `SHIPSTATION_API_SECRET` | Add this with the key to connect **V1** instead |
   | `JWT_TOKEN` | Writing back to Sutton. Sutton staff generate this Clerk JWT and place it on the organization's secrets |

   Switching between V1 and V2 means disconnecting and reconnecting.

3. **Pack it** from the repo root:

   ```bash
   npm run pack -w templates/shipstation-template
   ```

   This builds `frontend/` and `backend/` and writes `app.zip`. `SPEC.md` must exist. Only
   `src`, `SPEC.md`, `README.md`, `manifest.json`, `package.json`, `tsconfig.json` and
   `index.html` go into the zip's `project/` folder, so `tools/` never ships.

4. **Publish with the Sutton MCP:** `generateAppUploadLink`, HTTP POST the zip, `publishApp`,
   then poll `appPublish`. Full steps are in
   [`.agents/skills/sutton-app/SKILL.md`](../../.agents/skills/sutton-app/SKILL.md).

5. **Open the app in Sutton** and use **Connect** to validate the key and sync carriers.
   Then push shipments from the queue.

To make your own copy instead of editing the template in place:

```bash
npm run new-app -- my-app --from shipstation-template
```

## Tests

```bash
npm test
```

Runs `node --test` in this folder.

## Working on the code

Read [AGENTS.md](AGENTS.md) and
[`.agents/skills/extend-shipstation-app/SKILL.md`](.agents/skills/extend-shipstation-app/SKILL.md)
first. The short version: every ShipStation call goes through `ssFetch` in
`src/backend/shipstationFetch.js` via the facade in `src/backend/shipstation.js`; the browser
never calls ShipStation; API keys are never logged or returned; new D1 changes are a new
migration file.
