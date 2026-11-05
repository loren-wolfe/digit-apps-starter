# WooCommerce fulfillment template (Sutton app)

Operator queue for WooCommerce orders. Every 20 minutes the app lists the open Sutton sales
orders Rutter created from WooCommerce as **Awaiting completion**, and polls
`GET /wp-json/wc/v3/orders?status=completed`. Once WooCommerce marks an order completed, the
app deducts its inventory from one default bin (after Approve, or automatically with auto-apply
on) and marks the Sutton order fulfilled. Nothing is written back to WooCommerce.

The app is not tied to any one organization. The Sutton API token and WooCommerce REST keys
are secrets the operator adds themselves. The fulfillment warehouse is chosen in the app. Open
**Secrets and capabilities** to see which secrets are set, which are missing, and which features
they unlock.

## Setup

1. Make sure Rutter is syncing WooCommerce orders into Sutton (it creates the sales orders this app matches).
2. In WooCommerce → Settings → Advanced → REST API, create a key with **Read** access.
3. Go to Settings in Sutton Studio. Add `API_TOKEN_SUTTON` (an organization API token), `WC_CONSUMER_KEY`,
   and `WC_CONSUMER_SECRET` to Secrets. Add `WC_STORE_URL` (for example `https://shop.example.com`) to
   Environment variables.
4. Open the **Configuration** tab and choose the default bin every item deducts from.
5. Reload the app if keys were just added. Optional overrides and tuning keys are listed in [SPEC.md](SPEC.md).

## Pack

From the repo root:

```bash
npm install
npm run pack -w templates/woocommerce-fulfillment-template
```

To make your own copy instead of editing the template in place:

```bash
npm run new-app -- my-app --from woocommerce-fulfillment-template
```

Produces `app.zip` in this folder. Do not edit the zip. Publishing uses Sutton MCP:
`generateAppUploadLink` → POST zip → `publishApp` → poll `appPublish`.

Never prefix secret or binding names with `DIGIT_` (reserved).
