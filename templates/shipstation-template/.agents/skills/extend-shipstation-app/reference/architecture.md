# Architecture

Sutton iframe → Worker → D1, Sutton GraphQL (token), and ShipStation V1 or V2. Cursor MCPs
are design-time only.

```
Cursor: Sutton MCP (schema, permissions, publish)
        ShipStation docs MCP (endpoint docs — not live API calls)

Published app:
  Frontend (src/frontend)  --/proxy/digit-->  Sutton GraphQL (viewing user)
                           --/proxy/backend--> Worker
  Worker (src/backend)     --D1-->  SHIPSTATION_DB
                           --HTTPS--> https://api.shipstation.com (V2 ssFetch)
                           --HTTPS--> https://ssapi.shipstation.com (V1 ssFetch)
                           --HTTPS--> Sutton GraphQL (JWT_TOKEN)
  After SS writeback               -->  runAfterDigitShipped (Rutter or direct channel adapters)
  Schedule poll-outbound-push (300s) -->  push eligible Sutton shipments (if scheduled); poll unlabeled maps
```

## Secrets and bindings (names only)

| Name | Kind | Role |
| --- | --- | --- |
| `SHIPSTATION_DB` | D1 binding | Publish-time only. Not shown in the setup UI. |
| `SHIPSTATION_API_KEY` | Sutton app secret | ShipStation key. Alone = V2; with secret = V1. Validated on connect. |
| `SHIPSTATION_API_SECRET` | Sutton app secret | Optional. When set with the key, connect uses V1 Basic auth. |
| `JWT_TOKEN` | Sutton app secret | Clerk JWT for Worker GraphQL (poll writeback + scheduled push). Sutton staff generate this token and place it on the account. |
| `FAIRE_API_KEY` | optional secret | Faire adapter after Sutton ship writeback. |
| `SHOPIFY_*`, `WOOCOMMERCE_*` | optional secrets | Channel adapters — see `CHANNEL_SECRETS` in `runtimeConfig.js`. |

**Credential rule:** key alone → V2; key + secret → V1. Mode is stored as
`shipstation_connection.api_version`. Switching requires disconnect and reconnect.
`liveCredentials` in `sync.js` returns null (with a reconnect message) if current
secrets no longer match that stored version.

App secrets are **organization-level**, so a published template serves many organizations
without sharing any credential. All of them are managed in Sutton's App Secrets UI and reach
the Worker as `env.KEY` — never pasted into the app. Sutton GraphQL is always
`https://api.digit-software.com/graphql`. Do not name secrets with a `DIGIT_` prefix.

The generated `ENCRYPTION_KEY` row in D1 exists only to decrypt legacy pasted **V2** keys
(`shipstation_connection.api_key_encrypted`). New connection rows store `''`. Core setup
secrets are read from Sutton-injected `env` only (migration `0007` drops legacy
`app_config` secret rows so removing a Sutton secret cannot leave a ghost “1 of 3”).

`GET /setup` is read-only and reports what the Worker can see, including
`items[].source` (`appSecret` when injected; core setup secrets no longer use
`appDatabase`) and `shipStationApiMode` (`v1` | `v2` | `missing`). Partial config never
blocks the app — the UI degrades feature by feature instead.

## Files to edit

| File | Role |
| --- | --- |
| `src/backend/shipstationFetch.js` | Shared `ssFetch` (V1 Basic / V2 api-key, SSRF allowlist). |
| `src/backend/shipstation.js` | Facade: dispatch helpers on `credentials.apiVersion`. |
| `src/backend/digitGraphql.js` | Worker Sutton GraphQL client. |
| `src/backend/sync.js` | Push, writeback, D1 map (`liveCredentials`). Sets the shipment carrier after label purchase / fulfillment writeback. |
| `src/backend/matchDigitCarrier.js` | Map SS `carrier_code` / service onto Sutton shipping-carrier options (manual map, aliases, conservative fuzzy). Reverse-map Sutton option → unique SS carrier+service for push. |
| `src/backend/activity.js` | `appendActivity` / `listActivity` (no secrets or PII). |
| `src/backend/eligibility.js` | Packed / already-pushed / import / Sutton carrier map gates for Sutton shipments, plus `skipNeedsAttention` (actionable vs routine skips). |
| `src/backend/mappers/packageMapping.js` | Sutton measurements/container ids → V2 packages or V1 order-level package fields. A queue selection overrides code and dimensions. |
| `src/backend/mappers/digitToShipStation.js` | Sutton shipment → V2; aggregates split order lines and emits one package per pack container. |
| `src/backend/mappers/digitToShipStationV1.js` | Single-container Sutton shipment → V1 order (`POST /orders/createorder`). |
| `src/backend/mappers/normalizeSsRecord.js` | V1 order / V2 shipment → shared fulfillment shape. |
| `src/backend/mappers/shipStationToDigit.js` | Normalized SS record → Sutton company/order (clone recipe; not used in Phase 1 UI). |
| `src/backend/channels/` | Adapter registry, D1 store helpers, platform stubs (outbound). |
| `src/backend/http/platformFetch.js` | Generic commerce HTTP client. |
| `src/backend/handleChannels.js` | `GET /channels/status`. |
| `src/backend/connection.js` | Connect/disconnect, org settings, carriers. |
| `src/backend/labels.js` | Label download helpers. |
| `src/backend/handleSync.js` | `/sync/shipments`, `/sync/push`, `/sync/label`, `/sync/activity`, `/sync/poll`. |
| `src/backend/jobs.js` | `poll-outbound-push`, `prune-activity` (midnight Pacific, drop activity older than 1 month), `refresh-package-catalog` (same window, plus one bootstrap for a connection that has never stored package types). |
| `src/backend/runtimeConfig.js` | Sutton-injected app secrets (`env`); `ENCRYPTION_KEY` in D1. |
| `src/backend/setup.js` | `GET /setup` status only (no writes). |
| `src/backend/migrations/*.sql` | New files only after `0001_init.sql` has been published. |
| `src/frontend/App.tsx` | Connect + Phase 1 settings. |
| `src/frontend/SetupNeeded.tsx` | Reports missing app-secret keys and directs owners to Sutton's App Secrets UI. |
| `src/frontend/FeatureStatus.tsx` | Per-feature Working / Limited / Not yet and what each needs. |
| `src/frontend/FulfillmentQueue.tsx` | Shipping queue. Refetches Sutton `shipments` on load and when the iframe is shown again. Sutton status filter uses `shippingStatuses`. Search matches carrier, sales order, shipping order, ShipStation id, and tracking (Sutton `search` plus D1 id/tracking). List view or grouped by push status. |
| `src/frontend/ActivityLog.tsx` | D1 activity events on the Activity tab (search, type filter, stored message, Sutton vs ShipStation chip). |
| `src/frontend/eligibility.ts` | Keep in sync with `eligibility.js`. |
| `manifest.json` | Permissions, D1, schedule. |

## Constraints the UI does not enforce

- The Worker does not receive the viewing user. Treat `/proxy/backend` as callable by anyone who can open the app.
- `JWT_TOKEN` is the Worker’s Sutton identity (staff-generated Clerk JWT). A `da_` API token cannot update shipments.

Error handling and the activity log: [error-handling.md](error-handling.md).
