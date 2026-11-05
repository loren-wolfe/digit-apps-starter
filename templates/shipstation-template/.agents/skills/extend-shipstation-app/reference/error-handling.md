# Error handling and activity log

Operators must always see **what happened and what that means**. Agents extending this
app must keep that contract. Details live here; recipes and routes only cross-link.

## Immediate UI feedback

- Use in-page MUI `Alert` / `AppErrorAlert` / Dialog. Never `window.alert`.
- Every operator mutation (connect, save settings, disconnect, push, Refresh, packing-slip
  download, shipping-label download) must show **outcome + meaning** after the call returns.
- Do not clear selection, close a dialog, or wipe form state until the result is known.
  On a mixed `/sync/push` batch, uncheck only rows that were actually created in
  ShipStation; keep skipped and failed rows selected.
- Pair `useBackendQuery` / `useBackendMutation` / `useApiQuery` errors with
  `AppErrorAlert`. Surface `AppHost.download` throws the same way.

Example meaning for a successful push: the Sutton shipment **stays awaiting carrier** until
the poll (or Refresh) finds a ShipStation label and writes tracking (`shipped`); the Worker
also sets Sutton `shippingCarrierField` when the ShipStation service matches (or is mapped
in the carrier modal). Operators buy the label in ShipStation, then download the PDF from
the queue once it exists. Unmapped services log `carrier_unmapped`, leave Sutton’s carrier
unset, and surface on the main page until they are mapped in carrier settings.

## HTTP 200 is not “all good”

`POST /sync/push` always returns Worker `{ ok: true, data: { results, summary } }` so a
mixed batch is not a single mutation error.

```js
{
  results: [{ shipmentId, orderId, ok, skipped, ssShipmentId, ssLabelId, message, meaning }],
  summary: { pushed, skipped, failed }
}
```

- `skipped: true` is eligibility (`ineligibilityReason`), not success. Show it.
- `ok: false` on a result is a ShipStation or Sutton failure; keep that row selected.
  The queue keeps an info icon beside that error chip. Hovering it says the shipment
  was not created, it will not retry on its own, and the operator should update the
  shipment data, then select the row and push again.
- The UI must read `summary` and `meaning`. Do not treat hook `error === null` as
  “every shipment pushed.”

## Activity log

D1 table `activity_log` (migration `0004_activity_log.sql`). Helpers:
`appendActivity` / `listActivity` in `src/backend/activity.js`.

`GET /sync/activity?organizationId=` returns `{ events }` (newest first, max 100).
Each event includes `origin`: `sutton`, `shipstation`, `channel`, `app`, or
`unknown`. `inferActivityOrigin` in `activityOrigin.js` derives it at read time
from the action, message, and detail shape (`graphqlCode` → Sutton;
`requestId` / `errorCodes` → ShipStation). Do not guess when those signals are
absent — leave `unknown` so the log can say the source was not recorded.

The log lives only on the **Activity** tab (search by date, time, and text;
filters for error, success, and warning — skipped counts as warning). Each row
shows the stored message as written, with a Sutton or ShipStation chip when the
source is known. Do not replace that message with a summary sentence. The queue
does not show a log.

Record: `actor` (`user` | `schedule` | `channel`), `action`, ids, `status`
(`success` | `skipped` | `error` | `warning`), human `message`, optional `detail` JSON (HTTP
status, `error_code`s, GraphQL `extensions.code`).

**Never** store API keys, `api_key_encrypted`, addresses, tracking numbers, or raw
payloads. Scheduled poll should not flood the log with routine eligibility
skips (those are user-visible on an explicit push). A carrier or package refresh writes
`catalog_pull` only when ShipStation returns a carrier or package this connection has not
seen before. Repeat refreshes of the same catalog stay out of the log. A failed package-type
pull writes `catalog_pull` with status `error` and the ShipStation message. The same error
text is not written again for 15 minutes. Sutton sales-order
and shipment mutations write `sutton_update` with the object number and the fields that
changed (shipping status, carrier, drop-off date, shipping fees). Failures use the same
action with status `error`.

New sync, connect, or poll paths must `appendActivity` and refetch
`/sync/activity` from the UI after operator actions.

## Verbose upstream errors

All ShipStation HTTP goes through `ssFetch`. On failure, parse the version-appropriate
body: V2 / ShipEngine `{ request_id, errors[].error_code, errors[].message, errors[].field_name }`;
V1 often `{ Message }` / `{ message }`. Confirm the shape on ShipStation docs MCP before
changing parsers. Do **not** include `field_value` (may be PII) or request bodies.

Sutton Worker GraphQL (`digitGraphql.js`): include `errors[0].message` and
`extensions.code` when present.

Keep `last_error` / activity `message` truncated (~500 chars). Full sentences belong
in the activity panel and Alerts.

## Eligibility vs errors

`ineligibilityReason` in `src/backend/eligibility.js` is a **skip** with a user-facing
sentence. Frontend copy lives in `src/frontend/eligibility.ts` — keep them in sync
(Worker cannot import TS). `skipNextStep` says what to change.

V1 multi-container shipments are blocked before selection because V1 has only one
order-level package. Show both remedies in the queue and push result: create one Sutton
shipment per pack container, or disconnect ShipStation and reconnect with V2 credentials.

Push also requires a Sutton `shippingCarrierField` that reverse-maps to **exactly one**
ShipStation service through a **confirmed** (`source = 'manual'`) `carrier_digit_map` row.
Missing, unmapped, auto-matched-only (`unconfirmed`), and ambiguous Sutton carriers are
eligibility skips (Blocked in the queue), not silent push successes.

Sweep runs (`pollOutboundPush`) must not swallow those skips. `skipNeedsAttention` splits
actionable skips (carrier mapping, V1 multi-container, missing SS carrier id) from routine
ones (already pushed / shipped / imported). Actionable skips are logged and returned as
`blocked` + `blockedShipments[]` so the queue notice can name each shipment and next step.

Show Ready / Blocked in the queue **Status** column **before** push so skips are not a
surprise. Do not duplicate that in a second status column — sync state (`pushed`,
`shipped`, errors) replaces Ready/Blocked when a map row exists.

## Scheduled jobs

- `poll-outbound-push` (300s): outbound push when fulfillment method is `scheduled` (manual is the default), plus
  unlabeled-map label pull. Refresh (`POST /sync/poll`) pulls labels only; outbound push is
  `/sync/push` or the scheduled job when fulfillment method is `scheduled`.
- A row with `push_status = error` and no ShipStation id is not retried by that job. The sweep
  returns a quiet skip (no activity row, status unchanged). The operator updates the shipment
  and pushes that row from the queue. An eligibility skip must not clear that `error` status,
  or the next sweep would push it.
- `appendActivity` on poll errors and operator Refresh; skip flooding the log with
  routine eligibility skips.
- `prune-activity` (300s): deletes `activity_log` rows older than one calendar month.
  The platform schedule is an interval, so the handler runs only from 12:00–12:09 AM
  Pacific (`America/Los_Angeles`) and skips every other tick.
- `refresh-package-catalog` (300s): pulls ShipStation package types into `package_catalog`
  during that same Pacific window, and once for a connection that has never been attempted.
  The dropdown reads the table. Failures are `catalog_pull` activity rows. New package
  types are logged once.
