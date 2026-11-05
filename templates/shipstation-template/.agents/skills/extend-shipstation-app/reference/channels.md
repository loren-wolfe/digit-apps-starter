# Commerce channels (Shopify, WooCommerce, Faire, …)

This template ships **scaffolding** for third-party store integrations. Customer clones
implement platform-specific API calls; the template provides registry, D1 maps,
and setup reporting. There is **no inbound webhook path**.

## Rutter vs direct adapter

| Path | When to use | What this app does |
| --- | --- | --- |
| **Sutton Rutter** | Store already connected in Sutton; Rutter `pushFulfillments` covers tracking | Nothing extra — tracking on the Sutton shipment is enough |
| **Direct adapter** | Rutter gap, custom store, Faire, B2B marketplace | Implement `afterDigitShipped` in `src/backend/channels/{platform}.js` |

There is no default — pick per organization and document the choice in `SPEC.md`.

## Outbound only

| Flow | Trigger | Template hook |
| --- | --- | --- |
| **Outbound** (tracking → store) | After ShipStation label writeback to Sutton | `runAfterDigitShipped` → `afterDigitShipped` on configured adapters |

## Files

| Path | Role |
| --- | --- |
| `src/backend/channels/registry.js` | Adapter list, outbound runner |
| `src/backend/channels/_scaffold.js` | Copy-paste starter for new platforms |
| `src/backend/channels/store.js` | D1: `channel_order_map`, `channel_connection` |
| `src/backend/http/platformFetch.js` | Generic upstream HTTP (mirror `ssFetch`) |
| `src/backend/runtimeConfig.js` | `CHANNEL_SECRETS` registry |
| `GET /setup` | `channels[]` secret presence (no values) |
| `GET /channels/status` | Per-org channel config + connections |

Recipes: [channel-recipes.md](channel-recipes.md) · API paths: [channel-api-map.md](channel-api-map.md)

## LLM workflow

1. Read this doc — choose Rutter vs direct outbound adapter.
2. Copy `_scaffold.js` → `channels/{platform}.js`; register in `registry.js`.
3. Add app secrets to `CHANNEL_SECRETS` in `runtimeConfig.js` (names only in UI).
4. Use `channel_order_map` for Sutton ↔ store order ids ([d1.md](d1.md)).
5. `appendActivity` with `channelId` / `externalOrderId` — no addresses or secrets.
6. Extend `FeatureStatus` / `GET /setup` only when adding new secret keys.

Fixtures for unit tests: `src/backend/channels/__fixtures/` (handlers are plain functions).
