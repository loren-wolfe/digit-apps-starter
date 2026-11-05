# Shopify item publish template

Studio app template for a business with two Shopify stores (for example retail and B2B). An operator picks one Sutton item, reviews the field mapping, and pushes it to one or both Shopify stores. New products are created as drafts. A later push updates the Shopify product with the same SKUs and leaves its Shopify status as it is.

Orders and stock stay on the native Shopify integration. This app does not pull Shopify products into Sutton.

## Secrets

Set these in Sutton Studio → Settings → Secrets. Only the app’s original Studio admin can save values. The Worker exchanges each store’s client ID and secret for an access token. Do not paste an Admin API token.

The Sutton API token needs **Read items** (`READ_ITEM`), **Read item cost info** (`READ_ITEM_COST_INFO`), and **Update items** (`UPDATE_ITEM`). Read items covers the name, SKU, variants, images, category, and tags. Read item cost info covers the default sales price. Update items writes the Shopify product id and variant id back onto each Sutton item.

| Secret | What to paste |
| --- | --- |
| `API_TOKEN_SUTTON` | Sutton API token with Read items and Read item cost info |
| `SHOPIFY_STORE_A_SHOP` | Store A subdomain, for example `my-retail-store` |
| `SHOPIFY_STORE_A_CLIENT_ID` | Client ID from that store’s Dev Dashboard app |
| `SHOPIFY_STORE_A_CLIENT_SECRET` | Client secret from the same app |
| `SHOPIFY_STORE_B_SHOP` | Store B subdomain, for example `my-b2b-store` |
| `SHOPIFY_STORE_B_CLIENT_ID` | Client ID for Store B |
| `SHOPIFY_STORE_B_CLIENT_SECRET` | Client secret for Store B |

In the Dev Dashboard, open the app → Settings → Credentials. On the app version, enable `read_products` and `write_products`, release it, and install the app on the store.

The client-credentials grant works only when that Dev Dashboard app and the store are in the same Shopify organization. Sutton can host this Studio app either way. For staging shops, create the Dev Dashboard app in Sutton’s Shopify organization. For a customer’s live stores, create the Dev Dashboard app in their organization and paste those credentials here.

The destination row shows **Ready** after the token exchange succeeds.

## What a push does

- Items that share a Style# + Color can become one Shopify product. The item you picked is sent as a variant with Size and that colorway's Color. Other sizes stay off until you check them. The product title is the style name.
- An item with no Style# + Color becomes a product with one default variant.
- Send stays off unless the item is active, its type includes sell, and every variant that would be created has a SKU and a default sales price greater than zero.
- Matching uses the SKUs you include. When none of those SKUs match and the colorway shares one Shopify Product ID, that product is updated. Twelve Sutton custom fields are also written to the product metafields with the same meaning: Top Style, Coverage (`coverage`), Sub Class 2 (`Sub-class 2`), Department, Collection, Style Type, Sub Class (`Sub-class`), Year, Season, Fabrication, Color Code, and Color (`Product Color`). A blank Sutton value clears that Shopify field. Collection Filter, Bottom Sub Class 2, One Piece Coverage, Image Swatch, MSRP, Fabric and Description, Class, and Disclosures are not sent.
- If every colliding SKU sits on one product, the push updates that product.
- If those SKUs sit on more than one product, that store asks which product to update, or whether to create a new draft. The other products are left unchanged. The next push asks again when the SKUs still match more than one product.
- Updates change mapped fields and matching variants, add missing variants, and never delete a Shopify variant.
- A zero or missing price is never written onto a variant that already exists. A new variant still needs a price above zero.
- The two stores are independent. Retry runs only the store that failed.
- When more than one destination is selected, the page asks which store’s ids to save. That store’s numeric Shopify product id and each new variant id are written on the sizes that were sent. A Sutton id that already differs is left unchanged. The other store still publishes.

The field mapping table lists each Sutton custom field beside the Shopify product field it writes, and the value from the selected item.

## Develop

```bash
npm install
npm test -w templates/shopify-item-publish-template
npm run pack -w templates/shopify-item-publish-template
```

To make your own copy instead of editing the template in place:

```bash
npm run new-app -- my-app --from shopify-item-publish-template
```

`npm test` runs the publish-plan matrix (create, update, add a size, choose a product, missing price, style group). A live push to your stores needs the secrets above installed on the published app.
