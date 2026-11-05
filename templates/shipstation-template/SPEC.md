# ShipStation template

## What it does

Phase 1 org Sutton app: connect one ShipStation account (V2 key, or V1 key + secret), push Sutton
shipments in **awaiting_carrier** into ShipStation as V2 shipments/`create_sales_order` or V1 orders.
**Scheduled push** sends eligible shipments every five minutes; **Manual push** (the default) sends them
only when an operator clicks Push to ShipStation. Before push, the Sutton shipment must have a
`shippingCarrierField` with a confirmed map to exactly one ShipStation **service** in Carrier configuration;
that carrier and service are sent on the created ShipStation shipment/order. Operators buy the
label in ShipStation (no in-app rate shop). The same five-minute poll (and Pull from ShipStation)
pulls tracking, carrier, and cost back onto the Sutton shipment.
The shipping queue lists awaiting-carrier Sutton shipments and can be filtered by ShipStation tracking status
(`unknown` → Sutton `awaiting_pickup`; `in_transit` / `delivered` / `error` → Sutton `shipped`).
On every load (and when the iframe becomes visible again) the queue re-fetches Sutton
`shipments` (up to 100, in a vertically scrolling table) so the Carrier column, packages,
and Sutton status match Sutton. Each pack container can use a ShipStation package type
from the queue: V2 lists account custom packages and the mapped carrier's packages
(including flat-rate boxes); V1 lists carrier packages only. The choice is stored in D1
and sent on push. It is not written to the Sutton sales order or shipment. After push the
picker locks; pull and the five-minute poll refresh the queue from the ShipStation package.
If the shipment carrier is empty, the table and push path use the sales
order’s current `shippingCarrierField`. Do not alias `shipment(id)` per row — that
exceeds Sutton’s GraphQL cost cap (`QUERY_TOO_EXPENSIVE`).
Operators can download
the PDF from the shipping queue once a label exists. Packing-slip PDFs use Sutton
`Order.shippingFees`, which this app sets from ShipStation label postage on writeback and
again when the slip is downloaded. Sutton `shippingCarrierField` writeback
uses aliases + conservative fuzzy match on the **service** (not the brand), plus carrier-mapping
overrides (service map, then carrier default). Unmatched pulled
services stay unset, appear in a main-page alert, and can be mapped from the Carrier configuration
modal. Operators pick/pack and create the Sutton
shipment first. Return labels, in-app rate shop, shipping-class mapping, and shipping-fee
capture stay out of the UI.

Source for `npm run new-app -- my-app --from shipstation-template`. Connect and sync only
work after a consumer publishes to Sutton (Worker, D1, secrets).

## Data & permissions

- `manifest.permissions`: `UPDATE_ORGANIZATION` (admin gate via `currentPermissions`),
  `READ_ORDER` / `UPDATE_ORDER` / `CREATE_ORDER`,   `READ_SHIPMENT` / `CREATE_SHIPMENT` /
  `UPDATE_SHIPMENT`, `CREATE_PACK_CONTAINER` / `READ_PACK_CONTAINER`, `READ_PICKED_ITEM`,
  `READ_ITEM` / `READ_ITEM_COST_INFO`, `READ_INVENTORY`, `READ_COMPANY` /
  `READ_COMPANY_DETAILS` / `CREATE_COMPANY`, `READ_CONTACT`, `READ_ORGANIZATION_LOCATION`,
  `READ_ORGANIZATION_DYNAMIC_FIELD`.
  Keys from MCP `appPermissions`. The Worker uses `JWT_TOKEN` (a Clerk user JWT) for the
  same operations on the 5-minute poll. **Sutton staff generate this token and place it in
  the organization’s app secrets.** A Settings → API Tokens `da_` key is not sufficient
  (`apiPermissions` has no `UPDATE_SHIPMENT`).
- D1 `SHIPSTATION_DB` — publish binding only (not shown in the UI). `0001_init.sql` plus
  `0002_order_sync.sql`, `0003_app_config.sql`, `0004_activity_log.sql`,
  `0006_api_version.sql`, `0007_drop_legacy_app_secrets.sql`, `0008_shipment_map.sql`,
  `0009_label_rates.sql`, `0010_carrier_digit_map.sql`, `0011_tracking_status.sql`,
  `0012_push_mode.sql`, `0013_carrier_service_map.sql`, `0014_manual_push_default.sql`,
  `0015_activity_log_created_index.sql`, and `0016_package_selection.sql`. Do not edit `0001` after a
  consumer has published.
- **All secrets are organization-level Sutton app secrets**, managed only in Sutton's built-in
  App Secrets UI: `SHIPSTATION_API_KEY`, `SHIPSTATION_API_SECRET` (V1),
  `JWT_TOKEN`. Key alone = V2; key + secret = V1.
  The app never accepts, writes, returns, or logs their values. Sutton injects them into the
  Worker as `env.KEY`. There is **no D1 fallback** for these keys (legacy `app_config` rows
  are deleted on publish via `0007`) so removing a secret in Sutton drops setup progress to
  match. The published app is a template for many organizations, so **no secret is ever
  shared across organizations**. Do not use a `DIGIT_` prefix — Sutton reserves it for
  platform bindings.
- `GET /setup` reports `items[].source` (`appSecret` when live) plus `shipStationApiMode`
  (`v1` | `v2` | `missing`). Setup progress counts **required** items only.
- `POST /connection` no longer takes a key: it reads `SHIPSTATION_API_KEY` (and
  `SHIPSTATION_API_SECRET` for V1), validates with a live carrier list, then creates the local
  connection row (`api_version`) and syncs carriers.
  `api_key_encrypted` is written as `''` for new rows and only read as a
  **legacy V2 fallback** for keys pasted before this switch.
  The auto-generated `ENCRYPTION_KEY` row stays only to decrypt those legacy values.
- There is no operator Disconnect control. Connect replaces a leftover connection row when
  secrets are restored. Removing the ShipStation key itself is done in Sutton.
- Sutton GraphQL URL is always `https://api.digit-software.com/graphql`.
- Optional secret `FAIRE_API_KEY` — enables the Faire adapter stub (`src/backend/channels/faire.js`).
- `GET /setup` is read-only: per-item `present` / `source` / `enables` plus `ready`,
  `usable`, `apiTokenPresent`. `POST /setup` only returns a message
  pointing at Sutton app secrets.
- Partial config is **not** a blocking screen. The app always renders; `FeatureStatus.tsx`
  shows per-feature Working / Limited / Not yet with what each one still needs, and the
  queue's push button is disabled with a reason when `JWT_TOKEN` is not live.
- Org settings: `default_fulfillment_method` is `manual` (the default: Push to ShipStation only)
  or `scheduled` (5-minute outbound push). Default weight (ounces). Carrier maps live in a dedicated modal
  with two tabs: **Sutton carriers → push** (each Sutton option on exactly one confirmed ShipStation
  service) and **ShipStation services → writeback** (one Sutton `shippingCarriers` option per
  ShipStation service, with an optional per-carrier Sutton default).
- Schedule `poll-outbound-push` every 300s (outbound push only when fulfillment method is scheduled, plus unlabeled-map
  label pull). The shipping queue **Pull from ShipStation** button only pulls labels
  via `POST /sync/poll`. Outbound push is **Push to ShipStation** (`POST /sync/push`) or the
  five-minute job when fulfillment method is scheduled.
- Schedule `prune-activity` every 300s. It deletes activity rows older than one calendar
  month, and only during 12:00–12:09 AM Pacific, because the platform has no clock cron.
- **Tracking writeback uses `JWT_TOKEN`.** Sutton staff generate a Clerk JWT and place it
  in the org’s app secrets. That identity has the user’s live permissions, including
  `UPDATE_SHIPMENT`. Settings → API Tokens (`da_`) cannot update shipments. Pull from ShipStation still
  applies staged `pendingWritebacks[]` in the iframe as a fallback when the operator is
  present.
- **Rate limits:** the poll lists Sutton shipments (`awaiting_carrier`) with `SHIPMENT_LIST_QUERY` and hands each node to
  `pushShipment` as `preloaded`, so ineligible shipments cost no extra Sutton query, and a run stops
  after `MAX_PUSHES_PER_RUN` (25). `digitGraphql` retries a 429 twice with backoff (honoring
  `Retry-After`) and then returns "Sutton API rate limit reached". Keep per-order Sutton calls
  out of any loop you add here — that is what caused "Too many requests" before.
- **Gotcha:** Org-admin is UI-only. Anyone who can open the app can hit `/proxy/backend`.
- **Gotcha:** `0001` still has unused rate/label-cost columns. Do not expose them in GET/PATCH
  JSON until a Phase 2 recipe re-adds that UI.

## Prompts

```
Make the following updates:
- Remove leftover secrets (PUBLIC_WEBHOOK_URL, SHIPSTATION_WEBHOOK_TOKEN)
- Ensure that all webhook related functionality is removed from the application
- In org settings
  - Update default fulfillment method to have two options:
    - Scheduled push: Use shipstation api to push from shipment queue every 5 mins
    - Manual push: only push to shipstation on refresh button click
  - Remove Sync mode completely: only offer Sutton to Shipstation workflow
  - Remove any settings that are not currently used by the app like Push and Lane tag ID
  - Remove default package dimensions
```

```
Refactor the ShipStation app so push only creates the shipment/order, operators pick rates
in ShipStation, and tracking/price come back via 5-minute API poll plus an on-demand
Refresh. Remove auto rate-shop and auto-buy labels for V1 and V2. Do not subscribe
ShipStation webhooks on connect.
```

```
Write a plan to take the template app through phase 1 outlined in the markdown pasted
below. Even though the other phases are out of scope, engineer the app with them in mind.
Ideally the app will meet the common needs of customers out of the box but be easily
extendable when pulled into their own llms.
```

```
the plan looks mostly good. But update the template to remove settings that are for phase
two or three. The app ui and usage flow should only meet phase 1 needs.
```

```
also make sure changes to to my forked repository branch called shipstation-template
```

```
Implement the plan as specified, it is attached for your reference. Do NOT edit the plan
file itself.
```

```
I am unable to enter the api token without also entering the webhook url. I want to be
able to set this up one token at a time.
```

```
Allow user to run the app with just the tokens that have been provided. Make it clear
which functionlity is working.
```

```
why doesn't this app use the shipstation api key? Or is that what is saved as
APP_SECRET_ENCRYPTION_KEY
```

```
Can we programatically add the tokens the the digit app secrets?
```

```
Use the built in digit infrastructure to save tokens rather than the textbox input.
```

```
There is a misunderstanding of how the digit infrastructure works. All Secrets are at the
organization level not the published app. Which is what I want. No secrets should be shared
across the published app. The published app is a template meant to serve many organizations.
Store the shipstation app in the same way that the digit api token and the public webhook
url are stored
```

```
GraphQL error
Too many requests, please try again later.

Support info
```

```
Change the copy in the informational from "These are this organization’s app secrets in
Sutton. Add the missing values under Sutton → Apps → this app → Secrets, then reload. Values
are managed by Sutton and are never entered or shown inside this app." to "These are this
organization’s app secrets in Sutton. Add the missing values by clicking 'Manage Custom
Apps' and then 'Edit' for the ShipStation integration, then reload. Values are managed by
Sutton and are never entered or shown inside this app."
```

```
In the shipstation template consider error handling. Write out a plan to handle errors and
make troubleshooting easier. For example, I clicked "push selected" and the item I had
selected disappeared. The user needs a way to see a log of what actions have been taken
and an indication that the action went through successfully and waht that means. Make
error handling robust and verbose.
```

```
add information about error handling to the shipstation extention skill as well
```

```
Implement the plan as specified, it is attached for your reference. Do NOT edit the plan
file itself.
```

```
Make SOs in fulfillment queue links
```

```
Ready and status columns appear to be duplicates
```

```
make the selection column frozen
```

```
rename shipstation column to shipstation id
```

```
publish
```

```
rename push column to status
```

```
republish
```

```
Use the /frontend-design skill to redsign the app while still following the conventions laid out in this repo
```

```
ShipStation App UI Redesign

Implement the plan as specified, it is attached for your reference. Do NOT edit the plan file itself.
```

```
Move the Finish Setup and What You Can Do section to a separate page or modal
```

```
make faild chip color different than missing
```

```
The chip is way too big and the red is too bright
```

```
app flashes and then disappears. This error is in the console
js?id=AW-16540468916:848 Cross-Origin-Opener-Policy policy would block the window.postMessage call.
...
ReferenceError: motionFadeIn is not defined
```

```
write a plan to refactor the app to accept both v2 and v1 shipstation api keys
```

```
Use option A for question 1 and option A for question 2
```

```
Implement the plan as specified, it is attached for your reference. Do NOT edit the plan file itself.
```

```
even when I remove the shipstation api key the app shows that the set up is still "1 of 3"
when it should be "0 of 3"
```

```
seperate v1 and v2 capabilities so that it is clear that the user will get either v1 OR v2
but not both.
```

```
when I reload the app and remove the secrets it still shows "1 out of 3" and now it shows
the whole fulfillment queue as well.
```

```
why is it still showing that shipstation is live when on the connect shipstation page?

I'm getting this error when I try to connect: This organization already has a ShipStation
account connected. Disconnect it first to reconnect.
```

```
This still didn't fix the issue. I removed all shipstation api keys and the chip and modal
are still saying the app is connected to shipstation
```

```
It's still not working. When I try to connect to shipstation it doesn't raise an error
indicating that thre is no shipstation api key present
```

```
still not working
```

```
on a new branch called - ui-fixes write a plan to complete the following tasks:
- ensure that text is visible on both dark and light mode
- remove duplicate text from fulfillment log re: digit api key
- In settings modal under "What you can do" remove duplicate shipstation v1 and v2 entries.
- In settings modal under Finish Setup instead of splitting V1 an V2 shipstation token info, use a toggle to toggle between the two.
```

```
UI fixes (dark/light, duplicates, V1/V2 toggle)

Implement the plan as specified, it is attached for your reference. Do NOT edit the plan file itself.
```

```
Refactor the app so that the queue pulls data from the Shipments table in digit
```

```
make sure to use the /frontend-design /create-digit-app skills when forging this plan
```

```
Shipping Queue from Sutton Shipments

Implement the plan as specified, it is attached for your reference. Do NOT edit the plan file itself.
```

```
build out app so that when a shipment is sent to shipstation the shipping lable is returned and downloadable from the download icon in the shipping queue
```

```
{
  "mcpServers": {
    "shipstation-docs": {
      "url": "https://docs.shipstation.com/mcp"
    }
  }
}
```

```
ShipStation label purchase and queue download

Implement the plan as specified, it is attached for your reference. Do NOT edit the plan file itself.
```

```
does the app reset the digit shipping order with the correct carrier information from shipstation?
```

```
write a plan to update the carrier to what is returned by shipstation. there may need to be some fuzzy matching involved
```

```
Sutton carrier writeback from ShipStation

Implement the plan as specified, it is attached for your reference. Do NOT edit the plan file itself.
```

```
Investigate why clicking the 'Download packing slip' icon button results in an error: failed to fetch
```

```
I can't run this locally I have to run through the Sutton platform. Maybe we can build a button into the app for testing purposes that allows me to download the log and then I could provide attach it to this chat
```

```
Have the shipstation template app show shipped shipments in the queue. Allow the user to filter by status
```

```
match the digit shipment statuses to what the shipstation api returns as `Tracking status`
```

```
the fulfillment queue should show the digit shipment status and the shipstation tracking status (column labeled Tracking status)
```

```
Container-Aware ShipStation Refactor

Implement the plan as specified, it is attached for your reference. Do NOT edit the plan file itself.

To-do's from the plan have already been created. Do not create them again. Mark them as in_progress as you work, starting with the first one. Don't stop until you have completed all the to-dos.
```

```
I want to create a workflow in this template that addresses the following use case.

Our customers use ShipStation to manage shipments. In ShipStation customers are able to save custom package types so they do not have to continually type in the dimensions. Further they have access to carrier specific packages. For example FedEx might offer a box that has a flat rate rather than being priced by dimensions and/or weight. The problem is that a user cannot preconfigure shipping containers or select carrier specific package types using the built in Sutton container selection workflow.

Build a package configuration workflow into the shipment queue. This workflow should pull in the customer saved and carrier specific packaging container types and allow the user to select them as need per package. This does not need to update what is stored in the Sutton Sales order or Shipment object.
```

```
carrier specific packages are not showing up in the dropdown.

The following is from the shipstation api docs:

Yes — the sandbox pre-provisioned carriers do include carrier package types like USPS flat rate boxes. Let me pull your connected carriers to check exactly what's available.The session key is returning 401 so I can't pull your specific carrier list directly. Here's what you need to know:

Yes, carrier packages are available in sandbox. Pre-provisioned sandbox carriers — including USPS via stamps_com — support carrier-defined package types like:

USPS flat rate boxes (small, medium, large)
USPS flat rate envelopes (regular, legal, padded)
USPS regional rate boxes (A, B)
FedEx and UPS carrier packaging if those carriers are pre-provisioned on your account
To see the full list for your sandbox carriers, call GET /v1/carriers/{carrier_id}/packages — it returns every package type supported by that carrier.

Once you have your carrier IDs (from GET /v1/carriers), the packages endpoint will show the package_code values you use when creating labels, for example flat_rate_box, flat_rate_envelope, etc.
```

```
make sure that carriers are re pulled on refresh
```

```
add to the activity log when app pulls in new carriers and packages from shipstation
```

```
Also include API updates to Sutton objects like SOs and SHPs
```

```
Indicate that packages types are loading in the drop down. Currently it makes it look like there are no carrier package types.
```

```
A customer's shipstation integration is showing this error

Backend unavailable
The app backend is temporarily unavailable. Try again shortly.

Support info
code=BACKEND_UNAVAILABLE status=502 kind=platform detail=App backend is not available.

It doesn't seem to be able to pull package types from shipstation. No error is logged when the error is shown
```

```
why is the shipstation carrier pull failing
```

```
add a stored package catalog that feeds the drop down. Every night run a worker that pulls in package types and updates the table as needed.
```

```
This warning is not useful: Package types are stored in this app and refresh every night. The first copy has not been saved yet. Those package types are missing from the dropdown. Retry, or use Sutton dimensions.
```

```
Packages are not proliferating into the dropdown
```

```
9/24/2026, 2:02:42 PM schedule catalog_pull error
In app
D1_ERROR: too many SQL variables at offset 562: SQLITE_ERROR
```

## Context supplied

- Phase 1: COM-01–COM-08 plus CS-12/13/14/16 and CS-01 as a Faire recipe/stub.
- Strip FR-3 return-email, address-block, and shipping-fee capture from UI and Worker JSON.
  Leave unused `0001` connection columns at SQL defaults. Default package weight lives on
  `org_settings` (`0009_label_rates.sql`). Do not auto rate-shop or buy labels from Sutton.
- Sutton native pick/pack/PDF; operators create a Sutton shipment (`awaiting_carrier`). The shipping
  queue lists awaiting-carrier, unknown (`awaiting_pickup`), and in-transit/delivered (`shipped`)
  Sutton shipments (filter by mapped ShipStation `tracking_status`). Worker push is V2
  `POST /v2/shipments` with `create_sales_order: true`, or V1 `POST /orders/createorder`,
  and always includes the mapped ShipStation carrier + service from the Sutton shipment’s
  `shippingCarrierField`. Shipments without a mapped Sutton carrier are not pushed.
  Operators buy labels in ShipStation. Poll/`POST /sync/poll` uses `GET /v2/labels` (V2) or
  `GET /orders/{id}` (V1) then Sutton writeback. Shipping-label download uses `POST /sync/label`;
  packing-slip download uses `POST /sync/packing-slip`, where the Worker calls
  `generateSalesOrderPdf`, fetches the presigned PDF URL outside the iframe CSP, and returns
  base64. Both finish with `DigitHost.download`. This app does not register or receive
  ShipStation webhooks. Sutton `shippingCarrierFieldId` is set from the ShipStation service on
  writeback (service map, then carrier default, then service-string auto-match). Pulled labels
  whose service still does not resolve show a warning on the main page.
- `JWT_TOKEN` because the scheduled poll has no iframe Sutton session. Sutton staff generate
  this Clerk JWT and place it in the organization’s app secrets. Do not use `da_` API tokens.

```
why am I getting this error in the app:
"Writing ShipStation label se-200223533 back to Sutton failed: [NOT_AUTHORIZED] User is not
authorized to access updateShipment on Mutation"
```

- Cause: `apiPermissions` (API-token scopes) offers `READ_SHIPMENT` but no `UPDATE_SHIPMENT` /
  `CREATE_SHIPMENT`, while `appPermissions` has all three. The Worker writeback used the token,
  so it could never succeed. Fix: poll stages the label as `label_ready` + `pendingWritebacks[]`,
  the frontend runs `updateShipment` on the operator's session, then `POST
  /sync/writeback-complete`.

```
Change the api token secret to JWT_TOKEN and make a note that Sutton staff will have to
generate this token and place it in the account for the user
```

- Rename `API_TOKEN_DIGIT` → `JWT_TOKEN`. Sutton staff generate a Clerk JWT and store it as
  that org app secret. Do not use Settings → API Tokens (`da_`).

```
Pull in carrier information in the following ways.
- Use carrier chip on the main page as a button click to pop up a carrier settings modal.
- Put carrier mapping in that modal. Rework the UI to make it more clear which Shipstation carriers are being matched.
- Show alert if there is a carrier being pulled in that doesn't match.
```

- Carrier count in the command bar is a chip that opens a dedicated mapping modal (org admins).
  Each ShipStation carrier shows name, code, Sutton match, and Auto/Manual/Unmatched. Pulled
  label carriers that still do not resolve are listed separately, warned on the main page, and
  omitted from `unmappedCarriers` once they match or are mapped. Fulfillment method and default
  weight stay in Settings. Creating Sutton carrier options is out of scope.

```
testing shows that there are two unmatched but no alert to the user. Show a little red alert
icon on the chip to let users know mapping is needed.
```

- The alert counted only `unmappedCarriers` (carriers seen on a purchased label), so synced
  carriers with no Sutton match showed Unmatched in the modal with no page alert. The chip and
  alert now key off every `ssCarriers[]` row without a `digitOptionId`; the chip turns red with
  an error icon and tooltip. A carrier already used on a label escalates the alert to `error`
  ("those shipments have no Sutton carrier"); otherwise it is a `warning`. When
  `digitCarriersError` is set, unmatched state is suppressed (nothing can match) and the load
  error itself is shown on the page.

```
Make the carrier mapping UI tighter. Consider a more table like format
```

- The modal is a dense MUI `Table` (ShipStation / Sutton shipping carrier / Match) instead of
  stacked cards, with a `mapped of total` count. Rows sort unmatched-first by server state so
  they do not jump while editing. Catalog and label-only carriers share one table; label-only
  rows are tagged `from label` under the code. `TablePagination` appears past 10 rows.

```
The carrier matching feature needs to take into account that Sutton considers different services offered by a carrier as unique carriers.

The following describes how shipstation handles this:
Shipping service (ground, air, express, etc.) is selected via the service_code field on your shipment.

Every carrier has its own set of service codes. You set one service_code per shipment, and it determines the speed, price, and handling. Common examples:

UPS

ups_ground — standard ground delivery
ups_2nd_day_air — 2-day air
ups_next_day_air — overnight
ups_next_day_air_saver — overnight, cheaper cutoff
ups_worldwide_express — international express
FedEx

fedex_ground — standard ground
fedex_home_delivery — residential ground
fedex_2day — 2-day air
fedex_priority_overnight — next day by 10:30am
fedex_standard_overnight — next day by 3pm
fedex_international_priority — international express
USPS (via Stamps.com)

usps_priority_mail — 1–3 days
usps_priority_mail_express — overnight/2-day
usps_ground_advantage — standard ground/parcel

 Outline how to reconcile this in the carrier config modal
```

- Mapping grain is ShipStation **service** (`service_code`) → Sutton `shippingCarriers`.
  Resolution: manual service map, then manual carrier default, then auto-match on the
  service name/code with a brand gate (never `stamps_com` → `USPS`). The modal filters by
  ShipStation carrier, has a Default Sutton carrier control, and a service table. Chip/alert
  count unmatched services. `carrier_digit_map` unique is
  `(connection_id, ss_carrier_code, ss_service_code)` (`0013`). Label pull stores
  `service_code` / `service_name` on the order map. Sutton `shippingClass` is not written.

```
Make some minor ui updates to shipstation template:
- Move the "connected" and "disconnect" chips to be on the left had side of the page to make it clearer that we are talking about a shipstation connection
- Make the carriers chip more obviously clickable. Rename to Carrier configuration.
- Move the digit status dropdown filter to be more integrated with the queue. Same with Refresh.
- Change "Refresh" button to "Pull from Shipstation"
```

- `ConnectionBar` splits into a connection cluster (title, status chip) on the left and org
  actions (Setup and capabilities, Carrier configuration, Settings, Connect) on the right.
  Status now always renders a chip, including the admin-with-key "Not connected" case that
  previously showed only the Connect button.
- The carrier chip is an outlined `Button` (truck icon, `error` color plus count when services
  are unmapped) labeled **Carrier configuration**, matching the modal title.
- The queue's Sutton status filter and pull action moved out of `SectionHeader` into a
  `queueToolbar` row directly above the table, above the sticky push bar.
- **Refresh** is **Pull from ShipStation** (`Pulling…` while polling) everywhere it is named:
  queue notices, tooltips, eligibility copy, `FeatureStatus`, org-settings hints, and the
  Worker's activity-log and push messages. The route (`POST /sync/poll`) and the
  `source: 'refresh'` activity value are unchanged.

```
Actually remove the disconnect button completely. No one should have to disconnect their account.
```

- Removed the Disconnect / Clear connection button from `ConnectionBar`, the confirm
  dialog, and the credentials-missing Clear connection action. Operators restore
  `SHIPSTATION_API_KEY` and click Connect; Connect already retires the previous D1
  connection row. `DELETE /connection` remains on the Worker but is unused by the UI.

```
Flesh out the Sutton -> Shipstation and Shipstation -> Sutton workflows. Use the
shipstation mcp to learn about the shipstation api when needed.

Confirm functionality that is already there and write a plan to implement the rest.

Before pushing to Shipstation the customer needs a way to either select a carrier
and service or to select that they want to use rate shopping. If they haven't
selected to use rate shopping and a carrier/service are not selected an error
should be rised and push to shipstation should be prevented. If a carrier is
selected in digit that is not mapped to shipstation an error should be raised
and push should be blocked.
```

```
actually flesh out this workflow with no rate shopping selected. Is anything
missing. Outline the steps to test the workflow
```

```
Sutton ↔ ShipStation workflows (no rate shopping)

Implement the plan as specified, it is attached for your reference. Do NOT edit
the plan file itself.
```

- Rate shopping stays out of scope. Push requires a Sutton `shippingCarrierField`
  that reverse-maps via a **service-level** `carrier_digit_map` row to exactly one
  ShipStation carrier + service. Missing, unmapped, or ambiguous Sutton carriers
  are eligibility skips (Blocked; checkbox off). V2 create sends `carrier_id` +
  `service_code`; V1 createorder sends `carrierCode` + `serviceCode`. Carrier
  defaults (`ss_service_code = ''`) do not satisfy push. Queue shows a Carrier
  column from Sutton. Writeback SS → Sutton is unchanged.

```
Change the pull to shipstation button to Push/Pull Shipstation (confirm that it
pushes before doing this)
```

- `POST /sync/poll` already ran outbound push before the label pull, so the queue
  button is **Push/Pull Shipstation** (`Pushing/Pulling…`) and every in-app string
  that named the click follows it.

```
I added a new carrier that was designed to cause a failure. When I refreshed the
app I wasn't alerted that there was a new, mismatched carrier. It was hard for me
to find in the modal ui. It also did not block the push
```

- Push now needs a **confirmed** map: only `source = 'manual'` service rows satisfy
  `resolveSsServiceFromDigitOption`. Auto-persisted `fuzzy` rows resolve to the new
  `unconfirmed` status and block push until a human picks the service.
- `/org-settings` returns `digitCarrierMaps[]` — one row per Sutton shipping carrier
  with `status` (`ok` | `unmapped` | `unconfirmed` | `ambiguous`) and the resolved SS
  carrier/service. The main page shows an **error** alert naming every Sutton carrier
  that cannot push, and the Carrier configuration chip counts push gaps plus
  writeback gaps.
- Carrier configuration shows one row per Sutton option with a grouped
  ShipStation-service picker and a Ready/Confirm/Not mapped chip. Picking a service
  clears that option's other pins so it stays one-to-one.
- Sweep runs no longer swallow blocks: `pollOutboundPush` pushes as the real actor,
  returns `blocked` + `blockedShipments[]`, logs attention-worthy skips to the
  activity log, and the queue notice lists each blocked shipment with its next step.
  Routine skips (already pushed, already shipped, imported) stay quiet.

```
remove writeback for now but keep the logic. It won't be needed until rate shopping
is added
```

- The ShipStation-services → Sutton-carrier writeback mapping tab, its unmatched-service
  alert, and its count in the Carrier configuration button are hidden for now. The
  backend payload, matching helpers, saved mappings, and label writeback behavior remain
  intact for later rate-shopping work. Carrier configuration now exposes only the
  Sutton-carrier → ShipStation-service mapping required to push.

```
make manual pushing/pulling shipstation the default
```

- `normalizeFulfillmentMethod` and org-settings reads treat anything other than explicit
  `scheduled` as `manual`. Settings lists Manual first. Migration `0014_manual_push_default.sql`
  sets existing org rows to `manual` so the five-minute job no longer auto-pushes; it still
  pulls labels. Scheduled remains an opt-in in Settings.

```
My bad - only have the app push to shipstation when push to shipstation is pressed.
The other button should say pull from shipstation like before.
```

- Queue **Push to ShipStation** (`POST /sync/push`) is the only operator path that creates
  ShipStation shipments. **Pull from ShipStation** (`POST /sync/poll`) pulls labels only.
  The five-minute job still pulls labels, and still pushes only when fulfillment method is
  scheduled.

```
the shipstation template queue doesn't repopulate the carrier when it is changed. This table should pull fresh digit information automatically on load.
```

- The shipping queue re-fetches Sutton `shipments` on load and whenever
  the iframe becomes visible again. Display, eligibility, and push use the shipment
  `shippingCarrierField` when set, otherwise the parent sales order’s current carrier.

```
Showing an error even though the table updates correctly:
Support info
code=QUERY_TOO_EXPENSIVE kind=platform detail=Query exceeds the maximum allowed cost.
```

- Removed the aliased `shipment(shipmentId:)` hydrate of every visible row. That second
  query exceeded Sutton’s GraphQL cost cap while the list query already had the updated
  carrier. Freshness is the list refetch on load/visible plus the order-carrier fallback.

```
make sure the cost gets applied to the packing slip
```

- Label postage (`shipment_cost`) is written to Sutton `Order.shippingFees` (`CostInput`)
  on writeback and again immediately before `generateSalesOrderPdf`, so the packing slip
  PDF includes ShipStation shipping cost. Multi-shipment orders sum D1 label costs.

```
make sure all the status chips are clearly visible. For example, "blocked" is not easy to see.
```

- Status chips are filled (not outlined) with theme contrast text and heavier labels so
  Blocked, Ready, Sutton/tracking, connection, setup, and carrier-mapping states stay readable.

```
keep the hover over that explained why a package is blocked
```

- Hovering **Blocked** (and the disabled select checkbox) still shows the ineligibility
  reason and next step. StatusChip forwards Tooltip mouse/focus listeners so the hover
  is not dropped.

```
shipping queue is cut off and paginated. Have it scroll vertically rather than paginate. Try and fit it to the page better.

Also center the files icon to the rows that it is referencing
```

- The shipping queue fills the iframe: table body scrolls vertically (no Previous/Next).
  Files icons are vertically centered on the row and stay sticky on the right.

```
The packing slip does not map the correct carrier to the slip. Make sure that the slip carrier matches the SHP and shipstation carrier
```

- The sales-order packing slip prints `Order.shippingCarrierField`. Before
  `generateSalesOrderPdf`, the purchased ShipStation label is read again and that
  field is set from the label’s mapped Sutton option. The SHP field is only used
  when the label does not resolve, because it can still be the carrier chosen on
  the sales order before the label was bought.

```
the packing slip is still showing fedex
```

- Downloading the slip was copying the SHP’s original FedEx option back onto the
  order. The slip now uses the carrier and service on the purchased label. V1
  orders use the label shipment’s carrier, not the carrier sent at push.

```
Make the Activity Log in the shipstation template more robust.

- User needs to be able to expand it or click to another tab for it
- It should be filterable by type (error, success, warning)
- It should be searchable by date/time/text
- It should be very clear if the error came from Sutton vs Shipstation
```

- The queue keeps a short activity preview with Expand. The Activity tab is the
  full log: type filters (warnings include skipped), search across date, time,
  and text, and a banner on errors and warnings that names Sutton or ShipStation.
  `origin` is derived when the log is read, so older rows get the same label.

```
Remove the log at the bottom of the page and just keep the activity log tab
```

- The queue no longer shows an activity preview. The Activity tab is the only log.

```
Improve the UI of the activity log entries. Show exact error message if there is one. I especially do not like the way that it shows "Shipstation has no update for this shipment"
```

- Entries show the stored message, plus a detail `message` when it is not already
  included. Sutton or ShipStation is a chip. The log no longer adds its own
  sentence in place of that text.

```
instead of a chip that says "this app" have it say "In app" and make it a charcoal grey chip
```

- Events recorded by this template use an “In app” chip in charcoal grey.

```
The activity log should only hold onto entries up to 1 month old. Auto delete entries as they surupass this age every day at 12 AM.
```

- `prune-activity` deletes `activity_log` rows older than one calendar month. The job is
  scheduled every five minutes and performs the delete only from midnight to 12:09 AM
  Pacific.

```
In shipstation template - improve the search and filtering of the shipment queue. Add a group by push status view as well. Should be able to search/filter by carrier, sales order, shipping order, shipstation id, and tracking number
```

- The shipping queue search matches carrier, sales order number, shipping order number,
  ShipStation id, and tracking number. A carrier menu filters the same rows. Sutton
  `shipments(search:)` finds older sales orders and shipping numbers outside the latest
  100; ShipStation id and tracking also search saved maps. List stays the default.
  By push status groups Ready, Blocked, Push failed, In ShipStation, label ready,
  Imported, and Shipped. Tracking status stays on the row and does not split those groups.

```
use /frontend-design to make the search, facets and filters more intuative
```

- The queue find field says it matches carrier, sales order, shipping order, ShipStation id,
  and tracking. Sutton status, carrier, and push status are tally chips instead of menus.
  Carrier and push chips show how many shipments are in each choice. Group rows still
  stacks the list by push status.

```
Plan for an error handling flow that ensures that when a push to shipstation fails that an error is raised but the row is available to try again once data has been updated.

Once a row fails it requires manual push - make sure that this requirement is raised in an icon hover over so the user knows they need to do this
```

- A rejected ShipStation create stays `push_status = error` with `last_error`, and the row
  stays selected. The five-minute job does not send it again. The queue error chip keeps
  the ShipStation message; an info icon says to update the shipment data, then select the
  row and push again. That manual push is still allowed, including after the data changes.

```
When a label is returned it currently marks the sales order as fulfilled. However since multiple shipments can be applied to a single sales order this is not always true. Update the logic to the following: 
- When a label is returned and if there is only one shipment for that sales order, mark the sales order fulfilled
- When a label is returned and if there are multiple shipments for a sales order, check if other shipments have all been marked as shipped. If the are all shipped, mark the sales order as fulfilled. If there are still other unshipped shipments (awaiting carrier, awaiting drop off, awaiting pick up, cancelled), mark the sales order as partially fulfilled.
```

- After the label is written onto the shipment, `writeback-complete` sets the sales order
  status from the other shipments. One shipment, or every other shipment already shipped,
  is fulfilled. Another shipment still awaiting carrier, drop off, or pickup, or cancelled,
  is partially fulfilled. A voided label does not change the sales order status.

```
Remove this from the shipstation settings
```

- The capabilities panel no longer shows Store channels (Store order import and Tracking
  to sales channel). Those cards no longer count toward the features-ready progress.

```
Using the shipstation mcp build me a simple UI for viewing shipments sent to the sandbox. I need an easy way to view my testing shipments and the sandbox doesn't show up in my shipstation profile UI.
```

- The sandbox is a V2 key prefixed `TEST_` on the same endpoints as production, so it is
  invisible in the ShipStation web UI. `tools/sandbox-viewer/` is a local dev-only Node
  server plus one static page that lists sandbox shipments (`listShipments` →
  `GET /v2/shipments`, newest first, Prev/Next paging) and buys a label per row
  (`createLabelForShipment` → `POST /v2/labels/shipment/{id}`), then shows the tracking
  number and label PDF link. Run with `npm run sandbox-viewer` and a local
  `tools/sandbox-viewer/.env.local`; a non-`TEST_` key warns in the console and in a page
  banner. It is not part of the published app — `sutton studio pack` never copies `tools/`, and
  it does not touch D1, Sutton, or app secrets. The browser never calls ShipStation.


```
include the ability to void purchased labels
```

- The sandbox viewer now voids labels (`voidLabel` → `PUT /v2/labels/{label_id}/void`) via
  `POST /api/labels/:labelId/void`, behind a confirm prompt. `GET /v2/shipments` has no
  label id, so `GET /api/shipments` also joins `GET /v2/labels` onto each shipment; that
  fills the Tracking column and gives purchased shipments a label PDF link. A void answered
  with HTTP 200 and `approved: false` is shown as a failure with its message and
  `reason_code`. A voided shipment shows "Label voided" and can buy a label again.

```
For a customer's shipstation integration the app needs to be able to filter out shipments from specific sources. Source should be listed in the sales order table. Source is an optional column so ensure that it is not expected. But if it exists give the user the option to only route specified sources to the queue.
```

- Source is the sales order's commerce integration (`order.externalOrder.connection`), the
  same value as the Source column on the Sutton sales order table. Labels lead with the
  platform (Shopify, WooCommerce, eBay, Amazon) and then the store name, so a Shopify
  store named My Store reads "Shopify · My Store". A sales order with no
  external order is **Manual Entry**. Nothing requires the field: a missing or null
  `externalOrder` is Manual Entry, and orgs without a commerce integration never see the
  setting.
- ShipStation settings has a **Sales order sources** section, shown only when the org has a
  Shopify, WooCommerce, eBay, or Amazon connection. A switch, "Only route selected sources
  to the queue", reveals a checkbox per connection plus Manual Entry. It is off by default.
  Saving with the switch on and nothing selected is rejected.
- With the filter on, shipments from other sources are hidden from the queue and never
  pushed, by an operator or the five-minute schedule. Shipments already in ShipStation stay
  visible so labels and tracking remain reachable. The queue shows how many shipments the
  filter hides, and each row shows its source when any loaded order has one.
- Stored in `org_settings.source_filter_enabled` / `source_filter_keys` (migration
  `0019_source_filter.sql`). The manifest adds `READ_INTEGRATION` for the connection list.
