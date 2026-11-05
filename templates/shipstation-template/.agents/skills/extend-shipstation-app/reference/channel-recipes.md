# Channel extension recipes

Checklists only. Look up request/response shapes in vendor docs — do not invent bodies.

## Add a channel adapter (any platform)

1. Copy `src/backend/channels/_scaffold.js` → `channels/{platform}.js`.
2. Set `id`, `label`, `secretKeys`.
3. Register the adapter in `ADAPTERS` in `registry.js`.
4. Add secret key names to `CHANNEL_SECRETS` in `runtimeConfig.js`.
5. Implement `isConfigured` (all required secrets present).
6. Outbound: implement `afterDigitShipped` using `platformFetch` + `channel_order_map`.
7. `appendActivity` on success/error; UI Alert + activity refetch.
8. Document secrets and flows in `SPEC.md`.

## Shopify

**Secrets:** `SHOPIFY_ACCESS_TOKEN`  
**Outbound:** Admin REST/GraphQL fulfillment create — look up current Shopify fulfillment API.  
**Stub:** `src/backend/channels/shopify.js`  
**Fixture:** `channels/__fixtures__/shopify-order-created.json`

## WooCommerce

**Secrets:** `WOOCOMMERCE_CONSUMER_KEY`, `WOOCOMMERCE_CONSUMER_SECRET`  
**Outbound:** WooCommerce order notes or shipment tracking REST — look up current docs.  
**Stub:** `src/backend/channels/woocommerce.js`  
**Fixture:** `channels/__fixtures__/woocommerce-order-created.json`

## Faire (outbound only)

**Secret:** `FAIRE_API_KEY`  
**Hook:** `faireAdapter.afterDigitShipped` via registry.  
Implement POST against Faire order-shipment API in `channels/faire.js`.

## Sutton Rutter (no adapter code)

When the store is connected in Sutton and Rutter pushes fulfillments:

- Finish ShipStation writeback (tracking on Sutton shipment).
- Leave channel adapters unconfigured — registry skips them.

## D1 mapping

Use `channel_order_map` when the store order id differs from Sutton order id:

```sql
-- see migration 0005_channel_integration.sql
```

Helper: `upsertChannelOrderMap` in `channels/store.js`.
