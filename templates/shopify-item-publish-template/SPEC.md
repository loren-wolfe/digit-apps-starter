# Shopify item publish template

## What it does

Operators create an item in Sutton and push it to a retail and a B2B Shopify store from one page. The page is the three steps in the reference screenshot: choose an item, map fields, confirm destinations.

The native integration keeps orders and stock. This app does not import Shopify products, and it does not write inventory quantities.

## Matching

A push can group items that share Style# + Color into one product. The item the operator picked is sent as a variant with Size and Color, using that item's SKU, GTIN, and default sales price. Color is the Sutton Color field, and every size on the product uses that same value. A missing Color, or included sizes that use different Color values, blocks the push. Other sizes in the colorway are listed and stay off until the operator checks them. The product title is the style name: ` - {Size} / {Color}` is removed from the picked item's name, and a name that only has ` - {Size}` drops the size. An item with no Style# + Color is one product with a single default variant. The push searches the SKUs being sent. When none match and the group shares one Shopify Product ID, that product is updated. After the chosen store creates a product or adds a size, the numeric product id and variant ids are written back to the Sutton items that were sent. A field that already holds a different id is left unchanged. The token needs `UPDATE_ITEM`. It also writes twelve product metafields from Sutton custom fields, matched to the store's existing definitions by name: Top Style, coverage, Sub-class 2, Department, Collection, Style Type, Sub-class, Year, Season, Fabrication, Color Code, and Product Color (from Sutton Color). The value comes from the picked item, or from the other sizes when every size has the same value. A blank value deletes that metafield on update. Sizes that disagree leave the metafield unchanged. A definition that is missing, or whose type is not text, a number, or a list of text, is skipped and named in the publish result. The push still completes. Collection Filter, Bottom Sub Class 2, One Piece Coverage, Image Swatch, MSRP, Fabric and Description, Class, and Disclosures are not sent.

- No product: `productSet` creates a **draft**, including options, variants, price, barcode, and images.
- One product: `productUpdate` for mapped product fields, `productVariantsBulkUpdate` for SKUs that already exist, and `productVariantsBulkCreate` for SKUs that do not. When that product has Size and is missing Color, `productOptionsCreate` adds Color with the colorway's single value and leaves the existing variants in place. `productSet` is not used here, because it would delete variants left out of the input.
- Several products: the operator picks one product to update, or creates a new draft. The other products are left unchanged. The other store still runs.

New products are drafts. Updates do not send `status`.

## Credentials

Per store, the secrets are the shop subdomain, client ID, and client secret from a Dev Dashboard app. `POST https://{shop}.myshopify.com/admin/oauth/access_token` with `grant_type=client_credentials` returns an access token that lasts about 24 hours. The Worker caches it and refreshes it before expiry.

That grant requires the Dev Dashboard app and the store to be in the same Shopify organization. The Studio app itself stays hosted in Sutton.

Scopes: `read_products`, `write_products`.

## Sutton reads

Item search uses `items(connection: { first: 50 })`. Sutton rejects a page size above 250, which is the error in the reference screenshot. The loader reads name, description, SKU, GTIN, status, item types, category, tags, images, default sales price, and item custom fields. Siblings that share Style# + Color are loaded with `items(customFields: { filters })`, up to 100 active items.

## Gates

Search lists non-deleted items. Publish is blocked unless the item is active and includes sell. A size that is included, and is missing or repeated, is blocked. A missing Color, or more than one Color among the included sizes, is blocked. Sizes left unchecked do not block the push. Every variant that would be created needs a SKU and a default sales price greater than zero.

## Routes

- `GET /setup` — secret presence and a token-exchange probe for each store. Values are never returned.
- `GET /items?search=` — name and SKU search.
- `GET /items/:id/preview?mapping=&variants=` — mapped values and, per store, create, update, choose, blocked, or failed. `variants` is a comma-separated list of extra Sutton item ids. The picked item is always included.
- `POST /publish` — `{ itemId, mapping, stores, variantIds }`. `variantIds` lists the sizes to send. The picked item is always included. One result per store, with an admin URL when Shopify returned a product id.

Field mapping is stored in the browser. There is no database and no schedule.

## Tests

`npm test` covers the plan matrix without Shopify. Live confirmation on your two staging stores is the path in the README, after those Dev Dashboard apps are installed and the secrets are saved by the original Studio admin.
