# Commerce channel API — thin map

**Do not invent bodies.** Look up current vendor docs before implementing adapters.

## Shopify Admin API

Base: `https://{shop}.myshopify.com/admin/api/{version}/`  
Auth: `X-Shopify-Access-Token` header  

| Operation | Method | Path (typical) |
| --- | --- | --- |
| Create fulfillment | `POST` | `/orders/{order_id}/fulfillments.json` |
| Update fulfillment tracking | `POST` | `/fulfillments/{fulfillment_id}/update_tracking.json` |
| Get order | `GET` | `/orders/{order_id}.json` |

Webhook topics (inbound): `orders/create`, `orders/updated`, `orders/paid` — confirm in Shopify docs.

Verify: `X-Shopify-Hmac-Sha256` over raw body.

## WooCommerce REST API

Base: `https://{store}/wp-json/wc/v3/`  
Auth: Consumer key/secret query or OAuth — confirm for the store version.

| Operation | Method | Path (typical) |
| --- | --- | --- |
| Get order | `GET` | `/orders/{id}` |
| Update order | `PUT` | `/orders/{id}` |
| Add order note (tracking) | `POST` | `/orders/{id}/notes` |

Webhook verify: `X-WC-Webhook-Signature` (base64 HMAC).

## Faire

Look up current Faire external API for order shipment / tracking writeback before
implementing `channels/faire.js`.

## HTTP client

Use `platformFetch` in `src/backend/http/platformFetch.js` — same error rules as `ssFetch`
(no secrets or raw bodies in operator messages).
