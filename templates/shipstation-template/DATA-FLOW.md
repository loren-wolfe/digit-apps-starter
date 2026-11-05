# Sutton ↔ ShipStation data flow

How the ShipStation template moves a Sutton shipment into ShipStation, and how a purchased label comes back onto that Sutton shipment.

Sutton has no ShipStation types. The join between the two systems is a row in D1 `shipstation_order_map`, keyed by Sutton shipment id. Carrier translation is a separate table, `carrier_digit_map`.

The live queue is outbound-first: Sutton is the source of the shipment, ShipStation is where the label is bought, and Sutton is updated after the label exists. Creating Sutton orders from ShipStation shipments (`importSsShipment` / `shipStationToDigit.js`) is implemented and unused by the queue.

## Runtime path

```
Sutton iframe (operator session)
  GraphQL  shipments, updateShipment, updateOrder
  /proxy/backend
        │
        ▼
Cloudflare Worker
  D1 SHIPSTATION_DB          shipment map, carrier map, activity
  Sutton GraphQL              JWT_TOKEN (Clerk JWT, org app secret)
  ShipStation HTTPS          ssFetch
        │
        ├── V2  https://api.shipstation.com     api-key
        └── V1  https://ssapi.shipstation.com   Basic key:secret
```

Credential rule, stored on connect as `shipstation_connection.api_version`:

| Secrets present | API | Auth |
| --- | --- | --- |
| `SHIPSTATION_API_KEY` only | V2 | `api-key` header |
| Key and `SHIPSTATION_API_SECRET` | V1 | `Authorization: Basic` |

Switching versions requires disconnect and reconnect. The browser never calls ShipStation.

Two Sutton identities write data:

| Caller | Credential | What it writes |
| --- | --- | --- |
| Iframe | Viewing user's session | `updateShipment`, `updateOrder` on pull |
| Worker | `JWT_TOKEN` | Reads shipments for the scheduled push; writes `updateOrder.shippingFees` after a completed writeback |

The Worker stages label data in D1. The iframe applies it, because the fulfillment write uses the operator session's `UPDATE_SHIPMENT` permission. `POST /sync/writeback-complete` then marks the map row shipped.

There are no ShipStation webhooks. Tracking arrives by poll.

## Identity

One Sutton shipment maps to one ShipStation resource.

| | V2 | V1 |
| --- | --- | --- |
| Created by | `POST /v2/shipments` | `POST /orders/createorder` |
| Stored in `ss_shipment_id` | ShipStation `shipment_id` | V1 `orderId` (stringified) |
| Sutton key sent to ShipStation | `external_shipment_id` = Sutton shipment id (50 chars) | `orderKey` = Sutton shipment id (50 chars) |
| Human number | `shipment_number` | `orderNumber` |

`shipstation_order_map` is unique on `(connection_id, digit_shipment_id)`. `digit_order_id` is the parent sales order, used for postage rollup and channel notification. `source` is `digit` for a push. A row with `source = shipstation` is never pushed again.

`push_status` on that row:

| Status | Meaning |
| --- | --- |
| `pending` / `skipped` | Not created in ShipStation, or held back by an eligibility rule |
| `pushed` | ShipStation accepted the shipment or order; no label yet |
| `error` | Create call failed; `last_error` has the upstream message. The scheduled job does not retry it. Update the shipment and push the row again. |
| `label_ready` | Label or tracking is staged; the iframe still owes `updateShipment` |
| `shipped` | Sutton shipment was updated and the map is closed for writeback |
| `imported` | Originated in ShipStation; excluded from push and from tracking refresh |

## Outbound: Sutton → ShipStation

### When a push runs

| Trigger | Route | Behavior |
| --- | --- | --- |
| Operator pushes selected rows | `POST /sync/push` | Up to 25 Sutton shipment ids. HTTP 200 with per-row `pushed` / `skipped` / `failed`. |
| Schedule `poll-outbound-push` (every 300s) | `jobs.js` → `pollOutboundPush` | Runs only when org setting `defaultFulfillmentMethod` is `scheduled`. Lists Sutton shipments in `awaiting_carrier`, newest first, up to 25 creates per run. Skips rows already in `error` with no ShipStation id. |
| Manual fulfillment (the default) | — | Schedule skips the push. Operators push from the queue. |

Both paths call `pushShipment` in `sync.js`.

### Eligibility

`ineligibilityReason` in `eligibility.js` blocks the create. A blocked row is a skip, not a failed create, so an existing ShipStation id is kept.

A shipment is pushed only when all of these hold:

1. `source` is not `shipstation`.
2. Sutton `shippingStatus` is not `shipped`.
3. No `ss_shipment_id`, and `push_status` is not `pushed`, `label_ready`, or `shipped`. `error` is still eligible: it is not treated as already pushed, so the checkbox stays enabled. The scheduled sweep refuses that row until an operator pushes it.
4. The shipment has a parent sales order (`order.id`).
5. At least one packed line resolves to an item (`packContainers → packedItems → pickedItem → orderItem → item`).
6. V1: exactly one pack container. Several containers need one Sutton shipment each, or a V2 connection.
7. A Sutton shipping carrier is set, and it reverse-maps to exactly one confirmed ShipStation service (see [Carrier map](#carrier-map)).

The carrier used for that check is `shipment.shippingCarrierField`, or the parent order's `shippingCarrierField` when the shipment field is empty.

Before those checks, `pushShipment` applies the optional source filter (`sourceFilter.js`). A shipment's source is `order.externalOrder.connection.id` (the Source column on the Sutton sales order table), or `manual` when the sales order has no external order. When org settings `source_filter_enabled = 1` and the source is not in `source_filter_keys`, the push is skipped with no map write. The scheduled sweep stays quiet; an operator push logs `push_skip`. Rows already in ShipStation are never excluded. The queue hides the same shipments. The settings picker lists commerce connections with `rutterConnections` (`READ_INTEGRATION`).

### Sutton read

`SHIPMENT_BY_ID_QUERY` / `SHIPMENT_LIST_QUERY` in `digitQueries.js` load the shipment, its order, addresses, pack containers, and packed lines. The scheduled list filters `shippingStatuses: [awaiting_carrier]`.

Ship-from (V2 only) is the organization address with `isShipFromDefault`, then `isManufacturingDefault`, then the first address. V1 `createorder` does not send a warehouse address.

### V2 create body

`digitShipmentToShipment` → `POST /v2/shipments` with `{ shipments: [body] }` and `create_sales_order: true`.

| ShipStation field | Sutton source |
| --- | --- |
| `external_shipment_id` | `shipment.id` (max 50) |
| `shipment_number` | `shipment.documentNumber`, else `shippingNumber`, else `order.documentNumber`, else `order.orderNumber`, else the shipment id |
| `carrier_id` | ShipStation catalog id from the confirmed carrier map |
| `service_code` | Mapped ShipStation service code |
| `ship_to.name` | `order.customerContact.fullName`, else address `title`, else customer name, else `"Ship to"` |
| `ship_to.company_name` | `order.customer.name` |
| `ship_to.phone` | `"000-000-0000"` (contact phone is not copied) |
| `ship_to.address_line1` | `addressLineOne`, or `"—"` when empty |
| `ship_to.address_line2` | `addressLineTwo` |
| `ship_to.city_locality` | `city` |
| `ship_to.state_province` | `state` |
| `ship_to.postal_code` | `zip` |
| `ship_to.country_code` | `country`, normalized (below) |
| `ship_to.address_residential_indicator` | `"unknown"` |
| `ship_from` | Organization ship-from address, same address shape; name and company are the organization name |
| `items[]` | One row per distinct packed order line (below) |
| `packages[]` | One package per pack container (below) |
| `internal_notes` | `order.notes`, `shipment.notes`, and a `Bill-to:` line built from `order.billingAddress`, joined and cut at 1000 characters |

Ship-to address is `shipment.shippingAddress`, else `order.shippingAddress`.

Country: a 2-letter code is uppercased. `United States` / `USA` / `US` → `US`, `Canada` → `CA`, `Mexico` → `MX`. Anything else keeps the first two characters, uppercased. Empty becomes `US`.

Packed lines are grouped by order-item id across every pack container. Quantities add. SKU is `orderItem.customerSku`, else `item.sku` (`skuForLine`).

| ShipStation item | Sutton source |
| --- | --- |
| `name` | `item.name`, else SKU, else `"Item"` |
| `sku` | `customerSku` or `item.sku` |
| `quantity` | Sum of packed quantity for that order item, minimum 1, rounded |
| `external_order_id` | `order.id` |
| `external_order_item_id` | `orderItem.id` |

V2 item rows do not send a unit price. Billing address is notes, not a `bill_to` object.

### V1 create body

`digitShipmentToV1Order` → `POST /orders/createorder`. The Worker wraps the response so callers still read `shipments[0].shipment_id`, which is the V1 `orderId`.

| ShipStation field | Sutton source |
| --- | --- |
| `orderKey` | `shipment.id` (max 50) |
| `orderNumber` | Same precedence as V2 `shipment_number` |
| `orderDate` | `order.orderDate`, else `shipment.createdAt`, else `order.createdAt`, else now |
| `orderStatus` | `"awaiting_shipment"` |
| `customerEmail` | `customerContact.email`, else `customer.email` |
| `carrierCode` / `serviceCode` | Confirmed carrier map |
| `shipTo` | Same person and address rules as V2, in V1 names (`street1`, `city`, `state`, `postalCode`, `country`, `company`) |
| `billTo` | `order.billingAddress`, else the ship-to address; name is the customer name |
| `items[].lineItemKey` | `orderItem.id` |
| `items[].sku` / `name` / `quantity` | Same as V2 |
| `items[].unitPrice` | `0` on the live path (packed lines do not carry a price) |
| `packageCode` | `"package"` |
| `weight` / `dimensions` | The first pack container only |
| `internalNotes` | `order.notes` and `shipment.notes`, cut at 1000 characters |

`shipTo.phone` and `billTo.phone` are `"000-000-0000"`. `residential` is null.

### Packages and measurements

`packageMapping.js`. ShipStation always receives ounces and inches.

Weight uses the container `packageGrossWeight` when the unit converts. Otherwise the org default `defaultWeightOz`, otherwise 16 oz. A package is emitted only when length, width, and height are all present; otherwise those three fall back to `defaultLengthIn` / `defaultWidthIn` / `defaultHeightIn` together, or dimensions are omitted.

| Sutton unit symbol or name | Becomes |
| --- | --- |
| oz, ounce, ounces | ounces × 1 |
| lb, lbs, pound, pounds | ounces × 16 |
| g, gram, grams | ounces × 0.0352739619 |
| kg, kilogram, kilograms | ounces × 35.2739619 |
| in, inch, inches | inches × 1 |
| ft, foot, feet | inches × 12 |
| yd, yard, yards | inches × 36 |
| mm / cm / m (and full names) | inches × 0.0393700787 / 0.3937007874 / 39.37007874 |

Unknown units are dropped, and the field falls back as above.

| | V2 `packages[]` | V1 order |
| --- | --- | --- |
| Cardinality | One entry per Sutton pack container. No containers → one default package. | Order-level `weight` and `dimensions` from the first container. Extra containers make the shipment ineligible. |
| Code | `package_code` from the queue selection, otherwise `"package"` | `packageCode` from the queue selection, otherwise `"package"` |
| Weight | Sutton gross weight `{ value, unit: "ounce" }` | Sutton gross weight `{ value, units: "ounces" }` |
| Dimensions | Catalog dimensions when the selected type has them. Otherwise Sutton/org dimensions for the generic package, omitted for a selected type with no dimensions. | Same, with V1 `units`. |
| Id | `external_package_id` = Sutton pack-container id | Not sent |

V2 `items[]` stay on the shipment. They are not allocated onto `packages[].products`.

### After a successful create

The map row stores `ss_shipment_id`, `push_status = pushed`, `source = digit`, and clears `last_error`. No label is purchased. The operator buys the label in ShipStation.

### After a failed create

The map row stores `push_status = error` and `last_error`, and does not store a ShipStation id. The activity log records `push_error`. The five-minute job leaves the row alone. The queue shows the ShipStation message and an info icon: update the shipment data, then select the row and push again. A later eligibility skip keeps `error` and `last_error` so the schedule still will not pick the row up.

## Inbound: ShipStation → Sutton

### When a pull runs

| Trigger | What it does |
| --- | --- |
| Schedule, after the optional push | `pollPendingLabels` |
| Operator **Pull from ShipStation** | `POST /sync/poll` — labels only, no outbound push |

Candidates are map rows with an `ss_shipment_id`, no label id, no tracking number, and `push_status` other than `shipped` or `imported`. Up to 25 per run.

Lookup:

| API | Request |
| --- | --- |
| V2 | `GET /v2/labels?shipment_id={ss_shipment_id}&page_size=25`. If that list is empty, `GET /v2/labels?external_shipment_id={digit_shipment_id}`. |
| V1 | `GET /orders/{orderId}`. V1 has no label list. |

A label is usable when it has a tracking number or label id and its status is not `voided` or `error`. A `completed` label is preferred. Fulfillment is ready when the normalized record has a tracking number or a label id. No label yet is the normal gap between push and purchase; the schedule stays quiet about it.

Rows that already have a label or tracking number, and whose `tracking_status` is not `delivered` or `voided`, are refreshed in the same run. A Sutton status change restages the row as `label_ready` so the iframe writes the new status.

### Normalize

`normalizeSsRecord` turns a V1 order or a V2 shipment/label into one shape before anything is written to Sutton.

| Normalized field | V2 | V1 |
| --- | --- | --- |
| `ssShipmentId` | `shipment_id` | `orderId` |
| `externalId` | `external_shipment_id` | `orderKey` |
| `labelId` | `label_id` | — |
| `trackingNumber` | `tracking_number`, else `packages[0].tracking_number` | `trackingNumber`, else `shipments[0].trackingNumber` |
| `carrierCode` | `carrier_code`, else `carrier_id` | `carrierCode` |
| `serviceCode` | `service_code` | `serviceCode` |
| `shipDate` | `ship_date`, else `created_at` | `shipDate`, else `shipments[0].shipDate`, else `orderDate` |
| `costAmount` | `shipment_cost.amount` | `shippingAmount` |
| `costCurrency` | `shipment_cost.currency` | — (postage write uses `USD`) |
| `trackingStatus` | `tracking_status` | Derived from `orderStatus` (below) |

### Stage, then write

`stageLabelWriteback` saves the normalized label onto the map row and sets `push_status = label_ready`. It does not call `updateShipment`.

`POST /sync/poll` returns `pendingWritebacks[]`. The iframe (`FulfillmentQueue.tsx`) applies each one, then calls `POST /sync/writeback-complete`.

| Sutton mutation field | Source |
| --- | --- |
| `updateShipment.shipmentId` | `digit_shipment_id` |
| `updateShipment.shippingStatus` | Tracking status, mapped below. Fallback `shipped`. |
| `updateShipment.trackingNumber` | Normalized tracking number |
| `updateShipment.dropOffDate` | Normalized ship date |
| `updateShipment.shippingCarrierFieldId` | Sutton option resolved from carrier + service. Omitted when unresolved. |
| `updateShipment.notes` | `Carrier: {code}` when the carrier did not resolve to a Sutton option. `ShipStation tracking status: error.` when tracking status is `error`. Omitted when both are empty, so an existing Sutton note is left alone. |
| `updateOrder.shippingFees` | Sum of `shipment_cost_amount` across map rows for that Sutton order, as `{ currencyCode, costAmount }`. Currency is uppercased; missing currency becomes `USD`. |
| `updateOrder.orderStatus` | Set on `writeback-complete` from the order’s other shipments. `fulfilled` when this is the only shipment or every other shipment is `shipped`. `partially_fulfilled` when another shipment is `awaiting_carrier`, `awaiting_drop_off`, `awaiting_pickup`, or `cancelled`. Omitted when this writeback is a void. The shipment that just received the label is excluded, so a new label mapped to `awaiting_pickup` still fulfills a single-shipment order. |

`writeback-complete` sets `push_status = shipped` and sends that `orderStatus` on the same `updateOrder` as postage, including when postage and carrier are omitted. A voided label (`shippingStatus` `cancelled`) does not change the sales order status. The first time the mapped Sutton status is `shipped`, it also notifies channel adapters (`afterDigitShipped`) with tracking number, carrier name, ship date, and Sutton shipment id. Later tracking-status refreshes do not notify again (`channels_notified`), but they do run this order-status decision again when the Sutton shipping status changes, so the order becomes `fulfilled` once the last sibling is `shipped`.

The Worker still has `applyDigitShipmentWriteback`, which can `updateShipment` or `createShipment` itself. The queue does not call it. Pull uses the stage-and-iframe path above.

### Shipping status

`digitShippingStatus.js`.

V1 has no `tracking_status`. `orderStatus` `shipped`, or any tracking number, becomes `in_transit`. `cancelled` and `rejected_fulfillment` become `voided`.

| ShipStation tracking status | Sutton `shippingStatus` |
| --- | --- |
| `unknown`, `created`, `pending_pickup`, `dispatched`, `in_route_to_pickup`, `at_pickup` | `awaiting_pickup` |
| `in_transit`, `out_for_delivery`, `at_delivery`, `delivered`, `delivered_to_service_point`, `error`, `exception` | `shipped` |
| `voided` | `cancelled` |
| anything else, or empty | `shipped` (writeback fallback) |

The queue's status filter reads Sutton `shippingStatus`, so a label whose ShipStation status is still `unknown` shows under Sutton **Awaiting pickup**, and in-transit, delivered, and error labels show under **Shipped**. Search matches carrier, sales order, shipping order, ShipStation id, and tracking. List is the default; **By push status** groups those same rows.

## Carrier map

Carriers are copied into D1 on connect (`GET /v2/carriers` or `GET /carriers`, plus services). Sutton options come from `organizationDynamicFields.shippingCarriers`. The app does not create Sutton options.

`carrier_digit_map` rows are `(ss_carrier_code, ss_service_code) → digit_option_id`, with `source` `manual` or `fuzzy`. An empty `ss_service_code` is the carrier-level default.

The two directions use different rules.

### Sutton → ShipStation (push)

`resolveSsServiceFromDigitOption`. Only a **manual** row whose service code is non-empty can push.

| Result | Push |
| --- | --- |
| No Sutton carrier id | Skip. Set the carrier on the shipment. |
| No service row for that Sutton option | Skip. Map it in Carrier configuration. |
| Only `fuzzy` or auto matches | Skip. Confirm the service (that saves `source = manual`). |
| Two or more confirmed services | Skip. Keep the Sutton option on one ShipStation service. |
| One confirmed service | Send it. |

V2 sends `carrier_id` (catalog `shipstation_carrier_id`) and `service_code`. V1 sends `carrierCode` and `serviceCode`. A missing V2 carrier id after a confirmed map asks the operator to reconnect so the catalog refreshes.

Carrier-level defaults (empty service code) do not authorize a push.

### ShipStation → Sutton (writeback)

`effectiveCarrierMatch`, first hit wins:

1. Manual or fuzzy **service** row for that carrier + service.
2. Manual or fuzzy **carrier default** (empty service code), reported as match source `carrier`.
3. Automatic match on the service string against live Sutton option labels (exact, then alias, then a conservative fuzzy match).

When nothing matches, `shippingCarrierFieldId` is omitted and the shipment note records the ShipStation carrier code.

## Endpoint map

| Step | Sutton | ShipStation |
| --- | --- | --- |
| Connect | — | `GET /v2/carriers` or `GET /carriers`; services from `/v2/carriers/{id}/services` or `/carriers/listservices` |
| List queue | `shipments` (iframe) | — |
| Push | `shipment(shipmentId:)` (Worker) | `POST /v2/shipments` or `POST /orders/createorder` |
| Poll label | — | `GET /v2/labels` or `GET /orders/{orderId}` |
| Write shipment | `updateShipment` (iframe) | — |
| Write postage | `updateOrder.shippingFees` (iframe on pull; Worker again on complete) | — |
| Sales order status | `updateOrder.orderStatus` on complete: `fulfilled` or `partially_fulfilled` from sibling shipments | — |
| Packing slip | `generateSalesOrderPdf` after postage is written | — |
| Download label | `DigitHost.download` of PDF bytes | V2 `GET /v2/labels/{id}?label_download_type=inline`; V1 uses the PDF stored on the map row |
| Lookup by Sutton id | — | V2 `GET /v2/shipments/external_shipment_id/{id}`; V1 `GET /orders?orderNumber=` |

Rate shopping, address validation, and purchasing a label from this app are not wrapped. Label purchase stays in the ShipStation UI.

## Where the mapping code lives

| File | Role |
| --- | --- |
| `src/backend/sync.js` | Push, poll, stage, complete |
| `src/backend/shipstation.js` | V1/V2 HTTP dispatch |
| `src/backend/mappers/digitToShipStation.js` | Sutton shipment → V2 body |
| `src/backend/mappers/digitToShipStationV1.js` | Sutton shipment → V1 order |
| `src/backend/mappers/packageMapping.js` | Measurements → ounces and inches |
| `src/backend/mappers/normalizeSsRecord.js` | V1/V2 payload → one fulfillment shape; postage sum |
| `src/backend/mappers/digitShippingStatus.js` | Tracking status → Sutton `shippingStatus` |
| `src/backend/eligibility.js` | Push gates |
| `src/backend/carrierMatch.js` | Both carrier directions |
| `src/backend/matchDigitCarrier.js` | Load, save, and resolve carrier rows |
| `src/frontend/FulfillmentQueue.tsx` | `updateShipment` / `updateOrder` from `pendingWritebacks` |
