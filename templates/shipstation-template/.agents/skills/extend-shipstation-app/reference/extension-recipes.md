# Extension recipes

Checklists only. Look up shapes on Sutton MCP / ShipStation docs MCP.

## New ShipStation endpoint

1. Confirm method + path + body on ShipStation docs MCP for the API version in use
   ([v2 map](shipstation-v2-map.md), [v1 map](shipstation-v1-map.md)).
2. Add a helper in `src/backend/shipstation.js` using `ssFetch` (dispatch on
   `credentials.apiVersion`).
3. Resolve credentials only inside the Worker (`liveCredentials` in `sync.js`).
4. Expose a `/proxy/backend` route; call it with `useBackendQuery` / `useBackendMutation`.
5. Parse failures through `ssFetch` (upstream errors). `appendActivity`. UI: Alert with meaning + refetch `/sync/activity`.

## New Sutton write

1. `graphql-schema://search/…` + `type/…`.
2. `appPermissions` → add `key`s to `manifest.json`. Worker GraphQL uses `JWT_TOKEN`
   (staff-generated Clerk JWT), not a `da_` API token.
3. Frontend: `useApiQuery` / `useApiMutation`. Worker: `digitGraphql.js`.
4. Pair hook `error` with `AppErrorAlert`.
5. `appendActivity` on Worker writes; show outcome + meaning in the UI ([error-handling.md](error-handling.md)).

## SKU mapping (CS-04)

Override `skuForLine` in `src/backend/mappers/digitToShipStation.js`. Add a D1 map table in a new migration if SKUs are not on `customerSku` / `item.sku`.

## Faire tracking (CS-01)

Set secret `FAIRE_API_KEY`. Implement fulfillment POST in `src/backend/channels/faire.js`
(`faireAdapter.afterDigitShipped`). Registry runs it after Sutton writeback.

## Add commerce channel (Shopify, WooCommerce, …)

See [channel-recipes.md](channel-recipes.md) and [channels.md](channels.md). Copy
`_scaffold.js`, register in `registry.js`, add secrets to `CHANNEL_SECRETS`.

## Sutton carrier from ShipStation

Writeback sets `shippingCarrierFieldId` via `matchDigitCarrier.js` (service map, then carrier default, then service-string auto-match gated by brand). Unmatched services stay unset, log `carrier_unmapped`, and appear in `unmappedCarriers` plus a main-page alert. Operators correct maps in the carrier settings modal. Do not create Sutton carrier options. Do not map SS service codes to Sutton shipping class unless asked.

## Phase 2 leftovers on `0001`

`shipstation_connection` still has `rate_timing`, `rate_mode`, `best_rate_strategy`, `defaults`, `add_cost_to_shipping_fees`, `auto_send_return_email`, `block_on_invalid_address`. Do not re-add GET/PATCH `/connection/settings`. Default package weight lives on `org_settings`. Do not re-add in-app rate shop.

## Phase 2: scan verification / multi-account

Scan: Sutton `pickItem` + item `scanCodeSerialNumber` in a clone UI — not this template’s queue. Multi-account: drop `idx_shipstation_connection_one_live` in a new migration; do not drop it in Phase 1.

## New D1 table or column

1. Add `src/backend/migrations/0003_….sql` (never edit applied files).
2. Never select `api_key_encrypted` into JSON.
3. In scheduled or batch paths, reuse data you already listed (`pushShipment({ preloaded })`)
   and cap work per run. A Sutton query per row trips the API rate limit (429).

## New UI screen

1. MUI + `ThemeProvider`. Downloads via `DigitHost.download` only (surface throws).
2. Paginate tables. No Phase 2 return-label or shipping-fee toggles unless that phase is in scope.
3. Outcome Alerts and activity refetch after mutations.
