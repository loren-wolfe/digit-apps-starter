# WooCommerce fulfillment template

## What it does

Operator queue that mirrors the open Sutton sales orders Rutter creates from WooCommerce, and
deducts stock only once WooCommerce marks an order completed. A scheduled job
(`woocommerce-poll`, every 20 minutes — `manifest.json` `backend.schedules`) runs three steps:

1. **WooCommerce step.** Polls `GET /wp-json/wc/v3/orders?status=completed`
   ([woocommerce.js](src/backend/woocommerce.js), Basic auth with the WooCommerce REST key).
   - A completed order whose row is still waiting for completion is **promoted in place**: its
     `webhook_events` row is repointed at the completed WooCommerce payload
     (`source = 'woocommerce_poll'`), `wc_completed_at` is set, and the row is re-previewed. It
     lands at `pending_approval`, or auto-applies when automated deductions are on.
   - A completed order with no row yet is stored as a new `woocommerce_poll` event and
     previewed the same way.
2. **Sutton step.** Lists every open Sutton order (`draft`, `requested`, `unfulfilled`,
   `partially_fulfilled`) on the org's one WooCommerce Rutter connection (`rutterConnections`
   auto-discovery; `CONFIG_MISSING` / `CONFIG_AMBIGUOUS` when there is none or more than one).
   Each one not yet in the log, and created on or after the poll start, becomes an
   `awaiting_completion` row (`source = 'sutton_poll'`, payload synthesized from the Sutton
   order) with its items previewed. Rows still awaiting completion whose Sutton order is now
   fulfilled, cancelled, or deleted are marked `skipped` with `SUTTON_ORDER_CLOSED` (at most 100
   lookups per tick). A Sutton-step error is reported in the run summary and does not stop the
   WooCommerce step.
3. **Retry sweep** (below).

The WooCommerce step runs first, so an order completed since the last tick is promoted before
the Sutton step looks at its (possibly just-closed) Sutton order.

**Completion gate.** `fulfillment_syncs.wc_completed_at` (migration `0005_wc_completed_at.sql`)
records when the WooCommerce poll saw the order completed. `applyFulfillment` refuses any row
without it, unless the row already deducted something, with `AWAITING_COMPLETION` (409). That
covers Approve, Retry apply, and auto-apply. Awaiting completion rows offer only Reject in the
UI; Retry on one refreshes it from Sutton and keeps it awaiting. The migration backfills
`wc_completed_at` for every row that did not come from Sutton (`source <> 'sutton_poll'`) and
moves Sutton-only `pending_approval` / `ready` rows to `awaiting_completion`.

Outcomes per completed WooCommerce order:

- **Matched:** `pending_approval` (or applied).
- **No Sutton order yet:** `unmatched`. Never hidden. Retried automatically (see the retry
  sweep below), and with Retry.
- **Sutton order already fulfilled** (for example an old order handled outside this app):
  `skipped` with `ALREADY_FULFILLED_IN_SUTTON`. Nothing is deducted. Delete the row, or Retry if
  the Sutton order is reopened. These do not count toward the automated-deductions circuit
  breaker, and neither do `unmatched` rows.

Approving a row deducts stock at the single default bin chosen on the Configuration tab and
sets Sutton `orderStatus` to `fulfilled`. Each applied line records its `warehouseLocationId`,
so Un-deduct returns stock to the bin it came from even if the default bin changes later. **Run now** (`POST /fulfillment/reconcile-now`)
submits the same job immediately. It returns `MISSING_CONFIG` when the WooCommerce keys are unset.

### Polling window, cursor, and the 250-page limit

- Orders are requested oldest-modified first: `status=completed`, `orderby=modified`,
  `order=asc`, `per_page=100` (the WooCommerce maximum), `dates_are_gmt=true`,
  `modified_after = cursor - 1s`. The 1-second overlap means orders sharing the cursor's
  timestamp are never missed. Overlap orders are already tracked, so they are skipped.
- The cursor is `fulfillment_settings.wc_poll_cursor` (migration `0003_wc_poll_cursor.sql`): the
  `date_modified_gmt` of the last order a tick fully handled (queued, already tracked, or
  recorded as a `failed` row). It is saved when the tick ends, including when the tick throws
  (for example a `WC_API` error on a later page), so finished work is never repeated or lost.
- First run (no cursor): starts at `FULFILLMENT_LOG_SINCE` when set, otherwise 48 hours ago.
  Older completed orders are never pulled in.
- **Poll start** (`fulfillment_settings.wc_poll_start`, migration `0004_wc_poll_start.sql`):
  the date the first run started from. When `FULFILLMENT_LOG_SINCE` differs from it, the next
  tick saves the new date and rewinds the cursor to it. Orders already in the log count as
  already tracked.
- **Log cutoff:** the fulfillment log, its facets, and the retry sweep skip rows whose order was
  received before `FULFILLMENT_LOG_SINCE` or, when that is unset, before the poll start. A row
  the poll created after the cutoff stays visible even if its order was placed earlier. An info
  banner on the log names the date and says how to change it.
- **Page limit:** one tick fetches at most **250 pages** (`wcPollMaxPages`, fixed in
  [config.js](src/backend/config.js)), 25,000 orders. When it hits the limit, the summary sets
  `pageLimitReached: true` and the next tick resumes from the saved cursor. The Configuration tab
  shows a notice when the last run stopped there.
- **Order budget:** at most 50 orders previewed per tick, 200ms apart (fixed). Already-tracked
  orders do not use the budget. When the budget runs out, the tick stops fetching and the cursor
  stays before the first unhandled order. `deferred` reports how many matching orders are left.
- Tracking lookups are batched per page (one `IN (...)` query per 90 values, under D1's
  100-parameter limit), so a 250-page tick costs about 250 WooCommerce requests and a few
  hundred D1 queries.
- **Retry sweep:** once the cursor has passed an `unmatched` or `SUTTON_API`-`failed` row, the
  poll will not fetch that order again. Each tick therefore re-previews up to 10 of those rows
  (oldest `updated_at` first, so it rotates through them) with whatever is left of the 50-order
  budget after new orders. This covers Rutter creating the Sutton order after the WooCommerce
  order was completed.
- **Pending-approval backlog:** while automated deductions are on, each tick also deducts up to
  50 rows already at `pending_approval` (completed in WooCommerce, same log cutoff, oldest
  first). That budget is separate from the preview budget. Turning automated deductions on
  submits the poll immediately.
- **Restock sweep:** every tick, whether or not automated deductions are on, rechecks stock for
  up to 20 `failed` / `needs_attention` `STOCK_SHORTAGE` rows (completed in WooCommerce, same
  cutoff). It walks rows by id from `fulfillment_settings.restock_sweep_cursor` (migration
  `0008`), wrapping, so every short row gets a turn. Once every remaining line is covered, the
  row is deducted when automated deductions are on, or flagged `error_detail.stockReady` (Retry
  apply enabled, same as Recheck stock) when they are off. A flagged row that goes short again
  has the flag cleared. Rows whose state did not change are not written. The run summary
  reports `restockDeducted`, `restockReady`, and `restockStillShort`.
- If an order's attempt throws before preview could record anything, `recordPollCandidateError`
  stores a `failed` row with the real WooCommerce payload so Retry works. If even that write
  fails, the tick stops and the cursor stays before that order.
- Retry keeps the stored WooCommerce payload (id, number, dates, line items, meta) and refreshes
  only `sutton_status` and the shipping country from the matched Sutton order.

This app was generalized from an organization-specific WooCommerce fulfillment app. It
keeps every operator feature and screen, but carries no organization's ids, location names,
or migration tooling. The Sutton API token and WooCommerce REST keys are operator-supplied
secrets, surfaced in the read-only **Secrets and capabilities** dialog. The fulfillment warehouse
is chosen in the app.

### Features (unchanged from the baseline)

- Fulfillment log: status/location/date filters, sort, server-side pagination, bulk Retry and
  Delete, per-row apply events. Activity log across all orders. Bulk Retry uses the same
  per-row retry as the poll's retry sweep, so the two can run at the same time without
  creating duplicate rows. The bulk summary counts rows that return to Skipped because the Sutton
  order is already fulfilled separately from rows that are still unmatched.
- Row actions: Approve, Retry, Resume apply, Recheck stock, Retry order status, Mark resolved,
  Reject, Delete (skipped only), Remove from log / Restore (unmatched), Mark errant / Un-deduct,
  Rerun (after un-deduct).
- Alias items resolve to their fulfillment item. Virtual kits (items tagged via the Kit Type
  custom field) deduct their default BOM components, nested kits included, with cycle and
  tracking-method checks.
- **No partial fulfillment.** If any line or kit group on an order is short at its location,
  nothing on the order is deducted: the apply throws `STOCK_SHORTAGE` before the first
  adjustment, with per-line detail. Manual applies land at `needs_attention`; automated ones at
  `failed`. Retry apply is refused while any line is still short. Rows that already hold applied
  lines from before this rule (or a `PARTIAL_APPLY` mid-run failure) still resume only their
  remaining lines, and only once all of those are covered.
- Automated inventory deductions toggle on the Configuration tab (DB-backed,
  `fulfillment_settings`). It is the only auto-apply control for the scheduled poll and for
  Retry. While it is on, each poll also deducts rows already at `pending_approval` (up to 50 per
  tick). Turning it on submits the poll immediately. A circuit breaker turns it off after N
  consecutive non-shortage failures (default 5); stock shortages never count.
- Mark errant / Un-deduct: compensating adjustments under a separate "WooCommerce Fulfillment
  Reversal" reason (auto-created), partial-failure safe, requires a note. Rerun deducts again
  without changing the Sutton order status (it stays fulfilled).
- Remove from log: hides an unmatched row with nothing deducted (`status = removed`). The poll
  still sees it and does not insert the order again. Restore puts it back as unmatched.
- Duplicate-row consolidation and skipped-duplicate cleanup every tick; one row per order.
- Rate-limit safety: a fixed cap of 50 previewed orders and 250 WooCommerce pages per tick, a
  fixed 200ms gap between orders, and 429 retry with backoff in both `suttonGraphql()` and the
  WooCommerce client. `WC_STORE_URL` strips a pasted `/wp-json` prefix and retries the site
  origin after a 404 on a page path.

### What changed versus the baseline

- **Warehouse:** one location for every order, chosen on the Configuration tab and stored in
  `fulfillment_settings.warehouse_location_id` (migration `0002_warehouse_location.sql`). The
  picker lists active bins and work centers (`warehouseLocations`, `status: active`,
  `types: [bin, workCenter, userDefined]`, sorted by `locationCode`, 50 at a time, search
  narrows the page). A saved selection wins over the `WAREHOUSE_LOCATION_ID` secret, which is
  no longer required and is only a fallback until someone saves on that tab. The shipping
  country is recorded for display only and no longer gates a row; `missing_address` is not
  produced. A sync that has not deducted stores `warehouse_location = 'PRIMARY'`, which the
  queue's **Location** column (also the Location filter and group-by) shows as the current default bin's code. Once an apply deducts stock,
  `warehouse_location` is set to the bin code(s) the stock came from.
- **Adjustment reason:** found by the name `WooCommerce Fulfillment` or created on the first
  apply, then cached in `fulfillment_settings.adjustment_reason_id`. There is no env override.
- **Kit Type:** found by the item custom field name `Kit Type` and option value `Virtual Kit`
  (case-insensitive), cached in `fulfillment_settings.kit_type_field_id` /
  `virtual_kit_option_id`. `KIT_TYPE_FIELD_ID` / `VIRTUAL_KIT_OPTION_ID` override either part.
  If none resolves, kit expansion is off and lines deduct as plain items.
  The setup dialog and the capabilities list do not show a kit pathway, and the fulfillment
  log hides the Kit column while kit expansion is off.
  `/fulfillment/config` re-resolves and refreshes the cache.
- **Order source:** open Sutton orders on the WooCommerce Rutter connection populate the queue
  as Awaiting completion. Completed WooCommerce orders polled over REST are the only trigger
  for deducting stock. Rutter is what creates the Sutton orders.
- **Last poll note:** under the log-start line, the fulfillment log shows the last finished
  `woocommerce-poll` run (time, scheduled or Run now, and failed/cancelled if so) or "running
  now", plus the next scheduled tick or a paused notice, and (unless a poll is running) "To poll
  now, open the Configuration tab and click Run now." It reads `GET /fulfillment/reconcile`
  every 30 seconds and after Run now.
- **Queue search:** the **Order number** box on the fulfillment queue sends `q` to
  `GET /fulfillment/syncs`. It matches part of the WooCommerce order number, the WooCommerce
  order id, or the Sutton SO number, ignores case and a leading `#`, and combines with the
  other filters.
- **Removed:** legacy-database import (`/admin/import` and scripts) and the one-time legacy
  kit-preview refresh. `0001_init.sql` is the fresh schema and must not be edited after
  publish. Later schema changes are new numbered files (`0002_warehouse_location.sql`,
  `0003_wc_poll_cursor.sql`, `0004_wc_poll_start.sql`, `0005_wc_completed_at.sql`,
  `0006_item_bins.sql`, `0007_drop_item_bins.sql`, `0008_restock_sweep_cursor.sql`).

## Secrets and capabilities

One integration (WooCommerce REST, with Rutter creating the Sutton orders) with one way of
connecting, so there are no profiles. `GET /setup` is read-only: it returns the key catalog with
presence and validity, never values, and rejects writes with 400 pointing at Sutton Studio
Settings. The fulfillment warehouse is not a secret; it is chosen on the Configuration tab, along
with the WooCommerce poll (Run now, cursor, page-limit notice) and automated deductions. The
toolbar shows `Setup {present} of 4` while any required key is missing, and an always-visible
**Secrets and capabilities** button.
Secrets and environment variables are separate lists of keys plus a status chip. An optional
secret that is unset stays out of the Secrets list. Environment variables are always listed,
optional ones as **Not set**, each with its description, so `FULFILLMENT_LOG_SINCE` is visible
after setup is complete. The WooCommerce capabilities include a **Log start date** card with
the effective start date (`/fulfillment/config` `logSince`), whether it came from
`FULFILLMENT_LOG_SINCE` or the first poll, and how to change it. With the variable unset the
card shows **Not set**, says the default (the first poll's start date) is in use, and is left
out of the "features ready" count.
The `API_TOKEN_SUTTON` entry also carries a `note` ("This token will be provided by a Sutton
employee."), shown with the key in the Secrets quickview and the Finish setup checklist.
`WC_CONSUMER_KEY` and `WC_CONSUMER_SECRET` carry notes that they come from WooCommerce and the
key only needs Read permission (the worker only sends GET requests to WooCommerce).
It carries a `permissions` list (from the schema's `Permissions:
requires …` notes), shown under that secret in the always-visible Secrets quickview (the Finish
setup checklist points there instead of repeating it):
read Order, Integration, Item, Bom, Custom Field, Inventory, Warehouse Location, Organization
Dynamic Field; write Update Inventory, Update Order, and Create (or Update) Organization
Dynamic Field. `READ_INTEGRATION` (for `rutterConnections`) is not in the `apiPermissions`
list a Digit API token can be granted, so a scoped API token may not be able to list open
orders. The Finish setup checklist
shows only to `UPDATE_ORGANIZATION` admins while setup is incomplete.

## Data & permissions

- `manifest.permissions`: `READ_ORDER`, `UPDATE_ORDER`, `READ_INVENTORY`, `UPDATE_INVENTORY`,
  `CREATE_INVENTORY`, `READ_WAREHOUSE_LOCATION`, `READ_ITEM`,
  `READ_ORGANIZATION_DYNAMIC_FIELD`, `UPDATE_ORGANIZATION_DYNAMIC_FIELD` (the last for
  auto-creating adjustment reasons). The frontend calls `currentPermissions`, `organization`,
  and `warehouseLocations` (the Configuration tab picker) via `/proxy/digit`. All other Sutton
  calls go out from the Worker with `API_TOKEN_SUTTON`. `READ_WAREHOUSE_LOCATION` covers both
  the picker and the worker's `warehouseLocation` lookup that checks a saved id.
- Sutton GraphQL URL is always `https://api.digit-software.com/graphql`.
- D1 binding `WOOCOMMERCE_FULFILLMENT_DB`. `0001_init.sql` creates `webhook_events` (order
  payload snapshots), `fulfillment_syncs`, `fulfillment_apply_events`, and
  `fulfillment_settings` (single row: auto-deduct state, breaker counter, cached Sutton ids).
  `0002_warehouse_location.sql` adds `warehouse_location_id`. `0003_wc_poll_cursor.sql` adds
  `wc_poll_cursor`. `0008_restock_sweep_cursor.sql` adds `restock_sweep_cursor`. Do not edit a
  published migration; add new numbered files.
- Platform `__JOBS` binding runs the `woocommerce-poll` schedule and the manual Run now. The
  schedule was renamed from `sutton-reconcile`.
- WooCommerce REST is called from the Worker only (never the browser) with Basic auth. Errors
  carry the HTTP status, never the response body or credentials.

## Secrets (Sutton app Secrets — never logged or returned)

| Key | Required | Role |
| --- | --- | --- |
| `API_TOKEN_SUTTON` | Yes | Bearer token for Worker → Sutton GraphQL (organization API token). |
| `WC_CONSUMER_KEY` | Yes | WooCommerce REST consumer key (`ck_…`) with Read access. |
| `WC_CONSUMER_SECRET` | Yes | WooCommerce REST consumer secret (`cs_…`). |
| `WAREHOUSE_LOCATION_ID` | No | Fallback UUID used only until a warehouse is saved on the Configuration tab. Do not ask operators to set this. |

## Environment variables

| Key | Required | Role |
| --- | --- | --- |
| `WC_STORE_URL` | Yes | WooCommerce store origin without `/wp-json`, e.g. `https://shop.example.com`. |
| `FULFILLMENT_LOG_SINCE` | No | ISO date. The poll start and the log cutoff. Changing it makes the next poll re-read from it. Unset uses the first poll's 48-hour lookback. |

Each `woocommerce-poll` tick fetches at most 250 pages of 100 completed orders, previews at most 50 orders, and waits 200ms between orders. All three numbers are fixed in code. Anything past a limit waits for the next tick, from the saved cursor.

## Pack and publish

```bash
npm run pack -w templates/woocommerce-fulfillment-template   # from repo root → app.zip
```

The app must already exist in Sutton; resolve its id with MCP `apps`, then
`generateAppUploadLink` → POST `app.zip` → `publishApp` → poll `appPublish`.

## Prompt history

- "create a new folder called [app name] in the apps folder and write a new
  woocommerce app using the existing app as a baseline. It should capture all the main
  features/UI. the only difference is that this app needs to be generalized so that the user
  can input the secrets, etc that are needed for the app to run themselves. Use
  /third-party-setup-capabilities to convey this information. Ensure no secrets or IDs are
  shared from the [original customer] specific app." (customer name redacted)
- Decisions: Rutter-only (no WooCommerce REST keys); a single warehouse via
  `WAREHOUSE_LOCATION_ID`; adjustment reason and Kit Type resolved by name with optional
  env id overrides.
- "Make the following update to the woocommerce template app.

  Instead of supplying the warehouse ID allow user to select the warehouse in the configuration tab"
- Decision: the warehouse is saved in D1 from a Configuration tab picker (`warehouseLocations`),
  not typed in as a secret. `WAREHOUSE_LOCATION_ID` stays as a fallback for orgs that already
  set it, until a selection is saved. Saving uses the same client-side permission gate as the
  automated-deductions switch.
- "Move \"Sutton reconcile\" and \"automated deduction\" from the settings modal to the configuration tab"
- Decision: Run now and the automated-deductions switch live on the Configuration tab. Setup
  and capabilities stays a read-only secrets and feature-status dialog. The fulfillment-log
  chip that re-enables a tripped circuit breaker stays on that log.
- "Instead of showing this information in the banner add it to the secrets and capabilities section."
  (the Kit Type / Virtual Kit info banner on the fulfillment log)
- Decision: that notice renders in the capabilities section of the setup dialog when the Kit
  Type field is missing. It is no longer a banner on the fulfillment log.
- "Refactor both woocommerce apps to poll woocommerce using the endpoint `GET /wp-json/wc/v3/orders?status=completed`"
- "Be aware of the 250 page limit on polling"
- "only apply this to the template for now"
- Decisions: the WooCommerce poll replaces the Sutton open-order reconcile entirely (no
  fallback). This reverses the earlier "Rutter-only, no WooCommerce REST keys" decision:
  `WC_STORE_URL`, `WC_CONSUMER_KEY`, and `WC_CONSUMER_SECRET` are now required. A D1 cursor
  (`wc_poll_cursor`) bounds each poll; the first run looks back 48 hours or starts at
  `FULFILLMENT_LOG_SINCE`. One tick reads at most 250 pages and resumes from the cursor next
  tick. Completed orders whose Sutton order is already fulfilled are parked at `skipped`. The
  schedule is renamed `woocommerce-poll`. The original customer app is unchanged for now.
- "unless VIRTUAL KIT is turned on, remove any references to the kits"
- Decision: the Kit column in a row's Inventory table shows only when the Kit Type field with
  its Virtual Kit option resolves. A row whose lines were already expanded from a kit keeps
  the column, so that history stays visible.
- "Hide orders from queue that are past the poll start date. Make it clear on the queue page
  that orders beyond x date are not shown here and to change use FULFILLMENT LOG SINCE"
- Decision: the log cutoff is `FULFILLMENT_LOG_SINCE`, else the saved poll start. Changing the
  setting moves the poll start and rewinds the cursor. Rows the poll created after the cutoff
  stay visible, and the retry sweep skips hidden rows.
- "I want this to be refactored so the fulfillment queue reflects the sales orders in Sutton and
  then applies the auto-deduct to completed orders using the woo commerce poll"
- Decisions: Rutter's order sync stays on. Each poll adds open Rutter-linked Sutton orders as
  `awaiting_completion`; only a WooCommerce `completed` order can deduct (no early Approve, a
  server-side gate on `wc_completed_at`). A Sutton order fulfilled, cancelled, or deleted before
  WooCommerce completes it is marked `skipped` (`SUTTON_ORDER_CLOSED`) and kept in the log.
- "refactor the template so that the user can select a bin for the items to be deducted from"
- "I do not want an item specific bin selection. I want to select a single default bin for all
  items to be deducted from."
- Decision: per-item bins were removed. The Configuration tab's single selection (now labelled
  "Default bin") is used for every item. `0006_item_bins.sql` had already shipped, so
  `0007_drop_item_bins.sql` drops the unused table.
- "include the ability to search the fulfillment queue by woocommerce and sutton number"
- Decision: one **Order number** search box (partial match) on the queue covers WooCommerce
  order numbers and Sutton SO numbers.
- "Add info about FULFILLMENT_LOG_SINCE to secrets and capabilities modal"
- Decision: the Environment variables list always shows optional variables with their
  description, and a WooCommerce "Log start date" card shows the effective date and its source.
- "what access does the sutton api token need to have? Include that in the secrets and capabilities modal"
- Decision: list the 11 token permissions under API_TOKEN_SUTTON in the modal, grouped Read/Write
  with what each is for.
- "Show a note about the last polling time on the fullfilment log page"
- Decision: a second grey caption line under the log-start line, from `/fulfillment/reconcile`.
- "change fullfillment log column from Bin to Location"
- Decision: also renamed the matching filter and Group by option on that page; Activity log and Configuration still say Bin.
- "Sections should have a standard format with the same heading size" (Configuration tab)
- Decision: shared SectionHeader (eyebrow, h3 title, description) for every section.
- "Woocommerce poll should go in the automation section, the automation section should go below the fullfilment section"
- Decision: Configuration order is Fulfillment (Default bin), then Automation ("WooCommerce automation") with Automated deductions and WooCommerce poll as SubsectionHeader parts.
- "Change \"Default Bin\" to \"Default Location\" as well as every other instance of \"bin\" to \"location\" in this section"
- Decision: all user-facing "bin" text in the Configuration Fulfillment section now says "location"; the API location type filter `bin` is unchanged.
- "Lots of redundancy in this section" / "Seperate out this information to display above the relevant subsection" / "I want it to be clearer that these are subheader sections" (Configuration Automation)
- Decision: Automation header has no intro; each part is an outlined Subsection with its own description. Switch label is On/Off (accessible name stays "Automated deductions"); poll description is a short bulleted list.
- "fulfillment log page is constantly flashing a loading screen. fix this."
- Cause: with an empty log, each 4s refetch swapped the empty message for "Loading log…". Fix: Fulfillment log and Activity log show "Loading log…" only before the first response.
- "Mine the original customer woocommerce app for features to bring into this template"
- Decisions: keep one default location. Port all-or-nothing deduction, the pending-approval
  auto-deduct backlog, the restock sweep (with `0008_restock_sweep_cursor.sql`), turn-on poll
  submit, Remove from log / Restore, Rerun after Un-deduct, WooCommerce `storeBase` URL
  hardening, and the received-to date filter that includes the full calendar day. Do not port
  that app's per-country location split, hardcoded Kit Type ids, or pending-only bulk selection.
