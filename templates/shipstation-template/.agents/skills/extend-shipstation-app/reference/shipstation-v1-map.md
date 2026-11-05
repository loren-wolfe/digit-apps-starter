# ShipStation API v1 — thin map

Base URL: `https://ssapi.shipstation.com`. Auth: `Authorization: Basic` (base64 of
`SHIPSTATION_API_KEY:SHIPSTATION_API_SECRET`).

Used when **both** `SHIPSTATION_API_KEY` and `SHIPSTATION_API_SECRET` are set.
Confirm request/response bodies on ShipStation docs MCP (V1) before changing helpers.
Do not call `ssapi.shipstation.com` from the browser.

V2 paths: [shipstation-v2-map.md](shipstation-v2-map.md). Dispatch lives in
`src/backend/shipstation.js`; HTTP is `ssFetch` in `shipstationFetch.js`.

## Wrapped in `shipstation.js`

| Method | Path | Used for |
| --- | --- | --- |
| `GET` | `/carriers` | Validate credentials; carrier sync on connect and again when settings or the queue refresh |
| `GET` | `/carriers/listservices?carrierCode=` | Services when the carrier list has none |
| `GET` | `/carriers/listpackages?carrierCode=` | Carrier package types. The nightly catalog job calls this. The dropdown reads the stored catalog. V1 has no account custom-package list. |
| `POST` | `/orders/createorder` | Push Sutton shipment (V1 order; `orderKey` = Sutton shipment id). Always includes `carrierCode` + `serviceCode` from the Sutton shipping-carrier → ShipStation service map. |
| `GET` | `/orders/{orderId}` | Writeback, unlabeled-map poll, and queue package-type refresh |
| `GET` | `/orders?orderNumber=` | Lookup by Sutton document number / order key |

D1 `ss_shipment_id` stores the V1 numeric `orderId` (stringified). Sync normalizes V1 orders
through `normalizeSsRecord` before writeback.

V1 exposes only one order-level `packageCode`, `weight`, and `dimensions` object. A Sutton
shipment with one pack container maps that container into those fields. A queue selection
replaces `packageCode` with the carrier package code and sends that type's dimensions when
the carrier list included them; otherwise dimensions are omitted. Weight stays the Sutton
gross weight. Account-saved packages are not listed by V1. A shipment with
multiple pack containers is ineligible: tell the operator to create one Sutton shipment
per container or disconnect and reconnect with V2 credentials.

Push requires a Sutton `shippingCarrierField` that reverse-maps to exactly one ShipStation
**service** through a confirmed (`manual`) map; that map supplies `carrierCode` and
`serviceCode` on createorder.

## Not wrapped

`POST /shipments/getrates`, `POST /orders/createlabelfororder`.
