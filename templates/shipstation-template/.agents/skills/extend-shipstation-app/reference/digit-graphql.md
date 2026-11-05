# Sutton GraphQL (shipping-adjacent)

There are **no** `shipstation*` types. Connection state is D1, not Sutton.

Before adding a Sutton operation:

1. `graphql-schema://search/{query}` then `graphql-schema://type/{TypeName}`
2. `appPermissions` — put each needed permission **`key`** in `manifest.json`
3. Frontend: `useApiQuery` / `useApiMutation`. Use connection/page args; paginate tables.

Do not dump the schema into SPEC or this file. Look it up every time — fields change.

## Names to search (not a field list)

Typical starting queries (confirm on MCP; add whatever keys those fields require):

| Intent | Search for |
| --- | --- |
| Sales orders | `Order`, `salesOrders`, line items, ship-to address |
| Sutton shipments | `Shipment`, `shipments`, `createShipment`, `updateShipment` |
| Companies / contacts | company and contact types on the order |
| Invoices | invoice types if you attach shipping cost |
| Permissions | `appPermissions` for `READ_SHIPMENT` and any write keys you actually call |

- Sutton GraphQL used: `currentPermissions`, `organization`, `organizationDynamicFields.shippingCarriers`,
  `shipments`, `shipment`, `orders`, `items`,
  `companies`, `generateSalesOrderPdf`, and Worker mutations for orders/shipments
  (`shippingCarrierFieldId`, `updateOrder.shippingFees` so packing-slip PDFs include
  ShipStation label postage).
  Look up fields on `graphql-schema://…` before adding more.
- Queue filters `shipments(shippingStatuses: …)` using Sutton statuses mapped from ShipStation
  label `tracking_status`: `unknown` → `awaiting_pickup`; `in_transit` / `delivered` / `error`
  → `shipped`. Default All is those plus `awaiting_carrier` and `awaiting_drop_off`.
  The queue search box also sends `shipments(search:)` for that same status set, then keeps a row
  only when the text matches carrier, sales order number, shipping order number, ShipStation id,
  or tracking number. ShipStation id and map tracking are not on the Sutton shipment: `GET /sync/shipments?q=`
  finds those maps (max 25) and the queue loads just those shipments with aliased `shipment(shipmentId:)`.
  Do not alias `shipment(shipmentId:)` for every visible row — that exceeds Sutton’s query cost cap.
  Nested `order` includes `shippingCarrierField` as a fallback when the shipment carrier is empty.
  Outbound poll still uses `SHIPMENT_LIST_QUERY` with `shippingStatuses: [awaiting_carrier]`. Nested `order`
  and packed items (`packContainers.packedItems.pickedItem.orderItem`) need `READ_ORDER`,
  `READ_PACK_CONTAINER`, `READ_PICKED_ITEM`, and `READ_ITEM`.
- Outbound package mapping reads `PackContainer.container`, `packageGrossWeight`, and
  `packageLength` / `packageWidth` / `packageHeight`, including each measurement's
  `uom { name symbol type }`. V2 maps every Sutton pack container to one ShipStation
  package; V1 accepts only one pack container per Sutton shipment.
- `manifest.permissions` must cover every Sutton field the iframe **and** `JWT_TOKEN` call.
