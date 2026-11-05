---
name: extend-shipstation-app
description: >-
  Extend this Sutton ShipStation template (encrypted V1/V2 connection, D1,
  Worker ssFetch). Use when editing this template directory or an app copied
  from it with new-app --from shipstation-template, or when the user mentions
  ShipStation, labels, rates, tracking, or carriers while working on this app.
---

# Extend ShipStation app

Follow **sutton-app** first (React + MUI + `ThemeProvider`, iframe limits,
`manifest.json`, pack, publish). This skill is the extra layer for the ShipStation
template — do not invent a second stack or call ShipStation from the browser.

## Required MCPs

| MCP | Role | If missing |
| --- | --- | --- |
| **Sutton** | GraphQL schema (`graphql-schema://index`, `type/…`, `search/…`), `appPermissions`, `apps` / publish | Stop. Ask the user to connect Sutton MCP. |
| **ShipStation docs** | Endpoint and payload docs only (`https://docs.shipstation.com/mcp`) | Stop. Ask the user to connect it. Do not invent V1 or V2 paths or bodies. |

ShipStation’s MCP **does not** call ShipStation. Runtime HTTP belongs in the Worker via
`ssFetch` in `src/backend/shipstationFetch.js`, dispatched by `src/backend/shipstation.js`
from `credentials.apiVersion`. Do **not** put a ShipStation API key in Cursor MCP config,
`.env`, or the frontend.

Setup: [reference/mcp.md](reference/mcp.md). Sutton GraphQL lookup:
[reference/digit-graphql.md](reference/digit-graphql.md).

## Hard rules

- Sutton has **no** `shipstation*` GraphQL types. Connection, carriers, settings, and
  labels live in D1 (`SHIPSTATION_DB`). Look up every Sutton field you use; never invent
  types or `manifest.permissions` keys — use `appPermissions`.
- New ShipStation HTTP: look up the operation on ShipStation docs MCP, then add a
  function next to the existing helpers in `shipstation.js` (all go through `ssFetch`).
  Thin path maps (not schemas): [reference/shipstation-v2-map.md](reference/shipstation-v2-map.md)
  and [reference/shipstation-v1-map.md](reference/shipstation-v1-map.md).
- All credentials are **organization-level Sutton app secrets**, read via `env`. Never add
  a UI field that accepts a secret, and never write one to D1 — the published app is a
  shared template, so nothing may leak between organizations.
  - `SHIPSTATION_API_KEY` alone → **V2**
  - key + `SHIPSTATION_API_SECRET` → **V1**
  - Also `JWT_TOKEN` (Clerk JWT; **Sutton staff generate this token and place it in the
    organization’s app secrets**). Do not use a Settings → API Tokens `da_` key.
- Never log or return `apiKey`, `apiSecret`, `api_key`, or `api_key_encrypted`. Do not
  `SELECT` the encrypted key into JSON responses.
- Operator mutations must show **outcome + meaning** (MUI `Alert`, not `window.alert`).
  Inspect per-item results on HTTP 200 batch routes (`/sync/push`); never treat
  `skipped: true` as a silent success; never clear selection or close dialogs until the
  result is shown. Persist troubleshooting events with `appendActivity`.
  Details: [reference/error-handling.md](reference/error-handling.md).
- This app has **no inbound webhooks**. Tracking writeback is the 5-minute
  poll plus `POST /sync/poll`. Channel adapters are outbound-only (`afterDigitShipped`).
  Details: [reference/webhooks.md](reference/webhooks.md).
- Do not POST subscribe or DELETE ShipStation webhooks on connect/disconnect.
- Org-admin in the UI (`UPDATE_ORGANIZATION`) is **not** Worker auth. Anyone who can
  open the published app can hit `/proxy/backend`.
- Sort / filter / page Sutton lists via GraphQL args. Paginate tables.
- Update `SPEC.md` with **verbatim** user prompts before pack.

## Where to edit

[reference/architecture.md](reference/architecture.md) ·
[reference/backend-routes.md](reference/backend-routes.md) ·
[reference/d1.md](reference/d1.md) ·
[reference/error-handling.md](reference/error-handling.md) ·
[reference/channels.md](reference/channels.md)

Recipes: [reference/extension-recipes.md](reference/extension-recipes.md) ·
Channels: [reference/channels.md](reference/channels.md)

Do **not** treat `requirements.md` (if present) as the skill. Extend the code that
exists; look up APIs via MCP.

## Checklist

```
ShipStation extend:
- [ ] sutton-app stack / iframe / pack rules
- [ ] Sutton MCP connected; schema + appPermissions for any new Sutton call
- [ ] ShipStation docs MCP connected; lookup before new ssFetch paths (V1 or V2)
- [ ] `JWT_TOKEN` / ShipStation API key (and V1 secret) are managed only
      in Sutton's built-in App Secrets UI; Sutton staff generate `JWT_TOKEN` and
      place it on the account. The app never accepts, returns, or logs them
- [ ] New D1 shape = new migration file, not an edit of 0001_init.sql
- [ ] Sutton shipment carrier writeback: `matchDigitCarrier.js` + carrier modal maps (service then carrier default); never auto-create Sutton options
- [ ] Sutton → SS push: Sutton `shippingCarrierField` must reverse-map to exactly one SS service through a confirmed (`manual`) map; send `carrier_id`/`service_code` (V2) or `carrierCode`/`serviceCode` (V1)
- [ ] Sutton carrier → SS service push gaps are visible on the main page and in Carrier configuration
- [ ] Keep SS service → Sutton carrier writeback mapping logic intact but hidden until rate shopping is added
- [ ] Tracking writeback: poll unlabeled maps (`GET /v2/labels` or V1 `GET /orders/{id}`)
- [ ] New sync/poll paths: `appendActivity` (no secrets/PII); UI Alert + activity refetch
- [ ] `ssFetch` / `digitGraphql` errors include upstream messages (not HTTP-only)
- [ ] SPEC.md prompts updated

Channel extend (Shopify, WooCommerce, Faire, …):
- [ ] Read reference/channels.md — Rutter vs direct outbound adapter
- [ ] Adapter in channels/{platform}.js registered in registry.js
- [ ] Secret key names in runtimeConfig.CHANNEL_SECRETS (Sutton App Secrets UI only)
- [ ] Outbound: afterDigitShipped via platformFetch; channel_order_map when ids differ
- [ ] appendActivity channelId + externalOrderId; FeatureStatus / GET /setup if new secrets
- [ ] Vendor API paths from channel-api-map.md + official docs — never invent
```
