# Agent notes (ShipStation template)

This template’s ShipStation skill lives **here**, not in the starter’s shared
`.agents/skills/` (that path is sutton-app only).

Read before changing this app:

- [sutton-app](../../.agents/skills/sutton-app/SKILL.md) — Sutton stack, iframe, pack, publish
- [extend-shipstation-app](.agents/skills/extend-shipstation-app/SKILL.md) — this template

`npm run new-app -- <name> --from shipstation-template` copies this file and
`.agents/skills/extend-shipstation-app/` into `apps/<name>/`. sutton-app stays
at the **repo root**.

## Required MCPs

- **Sutton MCP** — GraphQL schema, `appPermissions`, publish. Do not invent types or
  permission keys.
- **ShipStation docs MCP** (`https://docs.shipstation.com/mcp`) — endpoint docs only.
  It does not call ShipStation. Implement HTTP in `src/backend/shipstationFetch.js`
  (`ssFetch`) via the facade in `src/backend/shipstation.js`.

If either MCP is missing, stop and ask the user to connect it. Never put an API key in
MCP config or the frontend.

## Do

- Extend `ssFetch` / the facade for new ShipStation calls; keep secrets in Sutton / D1.
- **Credential rule:** `SHIPSTATION_API_KEY` alone → V2 (`api.shipstation.com`);
  key + `SHIPSTATION_API_SECRET` → V1 (`ssapi.shipstation.com` Basic auth). Persist
  `api_version` on connect. Switching versions requires disconnect and reconnect.
- `JWT_TOKEN` is a Clerk JWT. **Sutton staff generate this token and place it in the
  organization’s app secrets.** Do not use a Settings → API Tokens `da_` key.
- Connect does **not** use ShipStation webhooks. Tracking is polled every 300s
  and via **Pull from ShipStation** (`POST /sync/poll`).
- Add D1 changes as a new migration file.
- Update `SPEC.md` with verbatim prompts.
- Follow [error-handling.md](.agents/skills/extend-shipstation-app/reference/error-handling.md)
  (activity log, outcome + meaning, no silent skips).

## Do not

- Call `api.shipstation.com` or `ssapi.shipstation.com` from the browser.
- Log or return API keys, secrets, or `api_key_encrypted`.
- Mix V1 and V2 on one live connection without disconnect/reconnect.
- Treat `requirements.md` as the implementation spec if it is present.
