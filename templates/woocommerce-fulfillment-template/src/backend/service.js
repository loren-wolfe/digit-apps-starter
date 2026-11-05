import { appJobs } from "@heysutton/sdk-server";

import { dbAdapter } from "./db.js";
import { fulfillmentConfig, POLL_JOB_NAME, PRIMARY_LOCATION_KEY } from "./config.js";
import {
  findOrderByExternalNumbers,
  findOrderById,
  findOrderStatusesByIds,
  listOpenRutterOrders,
  resolveWooCommerceRutterConnectionId,
  OPEN_ORDER_STATUSES,
  markOrderFulfilled,
  deductInventoryAtLocation,
  reverseInventoryAdjustment,
  findWarehouseLocationById,
  fetchStockAtLocation,
  adjustmentReasonStatus,
  findOrCreateAdjustmentReasonTermId,
  WOOCOMMERCE_ADJUSTMENT_REASON,
  WOOCOMMERCE_ADJUSTMENT_REVERSAL_REASON,
  fetchItemFulfillmentDetails,
  resolveKitTypeField,
  KIT_TYPE_FIELD_NAME,
  VIRTUAL_KIT_OPTION_VALUE,
} from "./suttonOps.js";
import { isWooCommerceConfigured, listCompletedOrdersPage, WC_PAGE_SIZE } from "./woocommerce.js";

let reconcileInFlight = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * SQL for "this sync is on or after the log cutoff bound at `$n`". A row the poll created, or
 * saw completed, after the cutoff stays visible even when its order was placed earlier,
 * because the poll still acts on it.
 */
export function syncSinceSql(n) {
  return `(order_received_date IS NULL OR order_received_date >= $${n} OR datetime(created_at) >= datetime($${n}) OR datetime(wc_completed_at) >= datetime($${n}))`;
}

export function createFulfillment(env) {
  const db = dbAdapter(env);
  const cfg = fulfillmentConfig(env);

  const EXTERNAL_ORDER_PLATFORM = cfg.externalOrderPlatform;
  const RECONCILE_MAX_PER_RUN = cfg.reconcileMaxPerRun;
  const RECONCILE_PACING_MS = cfg.reconcilePacingMs;
  const WC_POLL_MAX_PAGES = cfg.wcPollMaxPages;
  const WC_POLL_INITIAL_LOOKBACK_HOURS = cfg.wcPollInitialLookbackHours;

  // Orders received before this instant are withheld from the fulfillment log (e.g. a
  // historical backlog already reflected in a physical count). Blank shows everything.
  const LOG_SINCE = cfg.logSince;

  // Statuses that automatic preview must never overwrite (would erase audit /
  // partial state). Explicit retry may still reset rejected/failed rows.
  const TERMINAL_OR_IN_FLIGHT = new Set([
    "fulfilled",
    "applying",
    "needs_attention",
    "skipped",
    // An operator's deliberate "Mark errant / Un-deduct" decision — like `skipped`, never
    // silently reset by a later retry/re-delivery of the same webhook/poll row.
    "reversed",
    // An unmatched row an operator hid. It stays so the poll does not insert the order again.
    "removed",
  ]);

  const ERROR_TITLES = {
    STOCK_SHORTAGE: "Not enough stock",
    PARTIAL_APPLY: "Partial inventory apply",
    ORDER_STATUS_FAILED: "Inventory deducted; order not marked fulfilled",
    UNMATCHED: "Sutton order not found",
    MISSING_ADDRESS: "Unrecognized shipping country",
    CONFIG_MISSING: "Missing configuration",
    STALE_ITEMS: "Order items changed since preview",
    ALREADY_APPLIED: "Already applied",
    ALREADY_FULFILLED_IN_SUTTON: "Sutton order already fulfilled",
    IN_PROGRESS: "Apply already in progress",
    INCOMPLETE_ITEMS: "Order has incomplete line items",
    SUTTON_API: "Sutton API error",
    LOCATION_UNRESOLVED: "Warehouse location unresolved",
    ORDER_NOT_FOUND: "Sutton order no longer found",
    INVALID_STATUS: "Invalid sync status",
    DRY_RUN_DISABLED: "Dry run disabled",
    ALIAS_UNRESOLVED: "Alias item not resolved",
    KIT_BOM_MISSING: "Kit has no default BOM",
    KIT_CYCLE: "Virtual kit contains itself",
    COMPONENT_NOT_STANDARD: "Kit component not standard-tracked",
    WC_API: "WooCommerce API error",
    CONFIG_AMBIGUOUS: "More than one WooCommerce Rutter connection",
    AWAITING_COMPLETION: "Waiting for WooCommerce to complete the order",
    SUTTON_ORDER_CLOSED: "Sutton order closed before WooCommerce completed it",
  };

  // Webhook-event source of rows created from Sutton's open orders. Every other source is a
  // completed WooCommerce order.
  const SUTTON_ORDER_SOURCE = "sutton_poll";

  // Every order deducts from one warehouse. A location saved on the Configuration tab
  // (fulfillment_settings.warehouse_location_id) wins. WAREHOUSE_LOCATION_ID is only a
  // fallback until that selection exists. Resolved once per `createFulfillment(env)` call.
  let warehouseLocationPromise = null;

  async function resolveConfiguredWarehouse() {
    const settings = await getAutoDeductSettingsRow(dbAdapter(env));
    const selected = String(settings?.warehouse_location_id || "").trim();
    if (selected) return { id: selected, source: "selection" };
    const fromSecret = String(cfg.warehouseLocationId || "").trim();
    if (fromSecret) return { id: fromSecret, source: "secret" };
    return { id: "", source: null };
  }

  function getWarehouseLocation() {
    if (!warehouseLocationPromise) {
      warehouseLocationPromise = (async () => {
        const resolved = await resolveConfiguredWarehouse();
        if (!resolved.id) return null;
        return findWarehouseLocationById(env, resolved.id);
      })();
      warehouseLocationPromise.catch(() => {
        warehouseLocationPromise = null;
      });
    }
    return warehouseLocationPromise;
  }

  /** `{ key, id, locationCode }` for the configured warehouse, or throws LOCATION_UNRESOLVED. */
  async function requireWarehouseLocation() {
    const resolved = await resolveConfiguredWarehouse();
    if (!resolved.id) {
      throw makeError(
        "LOCATION_UNRESOLVED",
        "No fulfillment warehouse is selected. Open the Configuration tab and choose the warehouse every order deducts from, then retry."
      );
    }
    const location = await getWarehouseLocation();
    if (!location) {
      const hint =
        resolved.source === "secret"
          ? "The WAREHOUSE_LOCATION_ID secret is not a warehouse location in Sutton. Choose a warehouse on the Configuration tab, then retry."
          : "The selected warehouse is no longer a warehouse location in Sutton. Open the Configuration tab and choose another, then retry.";
      throw makeError("LOCATION_UNRESOLVED", hint);
    }
    return { key: PRIMARY_LOCATION_KEY, id: location.id, locationCode: location.locationCode || "the configured warehouse" };
  }

  /** Every item deducts from the one bin chosen on the Configuration tab. */
  async function planStockLocations(itemIds) {
    const location = await requireWarehouseLocation();
    const stockByItemId = await fetchStockAtLocation(env, { itemIds, warehouseLocationId: location.id });
    return { stockByItemId, locationFor: () => location, locationLabel: location.locationCode };
  }

  // Kit Type field + Virtual Kit option ids. Env overrides win; otherwise resolved by name and
  // cached on fulfillment_settings so previews don't page itemCustomFields every time.
  // `getFulfillmentConfig` always re-resolves and refreshes the cache.
  let kitTypeIdsPromise = null;
  let kitTypeIds = null;
  async function resolveAndCacheKitTypeIds(db) {
    const resolvedKit = await resolveKitTypeField(env, {
      fieldIdOverride: cfg.kitTypeFieldIdOverride || null,
      optionIdOverride: cfg.virtualKitOptionIdOverride || null,
    });
    await updateAutoDeductSettingsRow(db, {
      kit_type_field_id: resolvedKit?.fieldId || null,
      virtual_kit_option_id: resolvedKit?.optionId || null,
    });
    return resolvedKit;
  }
  function getKitTypeIds() {
    if (!kitTypeIdsPromise) {
      kitTypeIdsPromise = (async () => {
        const db = dbAdapter(env);
        const settings = await getAutoDeductSettingsRow(db);
        const hasOverride = Boolean(cfg.kitTypeFieldIdOverride || cfg.virtualKitOptionIdOverride);
        if (!hasOverride && settings?.kit_type_field_id && settings?.virtual_kit_option_id) {
          return { fieldId: settings.kit_type_field_id, optionId: settings.virtual_kit_option_id };
        }
        return resolveAndCacheKitTypeIds(db);
      })();
      kitTypeIdsPromise.catch(() => {
        kitTypeIdsPromise = null;
      });
    }
    return kitTypeIdsPromise;
  }

  function logFulfillment(fields) {
    console.log(JSON.stringify({ msg: "fulfillment", ...fields, ts: new Date().toISOString() }));
  }

  /** Woo dates are usually naive GMT (`date_created_gmt`). Treat those as UTC. */
  function parseWooDate(raw) {
    if (raw == null || raw === "") return null;
    const s = String(raw).trim();
    if (!s) return null;
    const iso = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(s) ? s : `${s}Z`;
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  function orderReceivedDateFromPayload(payload) {
    if (!payload || typeof payload !== "object") return null;
    return parseWooDate(
      payload.date_created || payload.date_created_gmt || payload.date_paid || payload.date_paid_gmt
    );
  }

  function candidateExternalOrderNumbers(payload, { wcOrderId, orderNumber } = {}) {
    const candidates = new Set();
    if (payload.id != null) candidates.add(String(payload.id));
    if (payload.number) candidates.add(String(payload.number));
    for (const meta of payload.meta_data || []) {
      if (
        (meta.key === "_order_number" ||
          meta.key === "_order_number_formatted" ||
          meta.key === "_order_number_meta") &&
        meta.value
      ) {
        candidates.add(String(meta.value));
      }
    }
    // Fall back to the webhook_events row's own wc_order_id/order_number columns when the
    // payload JSON itself doesn't carry usable id/number fields. Those columns are what the
    // UI displays as the order number, so matching must search by them too.
    if (wcOrderId != null) candidates.add(String(wcOrderId));
    if (orderNumber) candidates.add(String(orderNumber));
    return [...candidates];
  }

  function jsonOrNull(value) {
    if (value == null) return null;
    return typeof value === "string" ? value : JSON.stringify(value);
  }

  async function upsertSyncRow(db, fields) {
    const { rows } = await db.query(
      `INSERT INTO fulfillment_syncs
         (webhook_event_id, wc_order_id, order_number, order_received_date, digit_so_id, digit_order_number,
          shipping_country, warehouse_location, items_preview, status, error, error_code,
          error_detail, applied_items, matched_external_numbers, order_status_applied,
          review_note, approved_at, approved_by, wc_completed_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, now())
       ON CONFLICT (webhook_event_id) DO UPDATE SET
         wc_order_id = EXCLUDED.wc_order_id,
         order_number = EXCLUDED.order_number,
         order_received_date = COALESCE(EXCLUDED.order_received_date, fulfillment_syncs.order_received_date),
         digit_so_id = EXCLUDED.digit_so_id,
         digit_order_number = EXCLUDED.digit_order_number,
         shipping_country = EXCLUDED.shipping_country,
         warehouse_location = EXCLUDED.warehouse_location,
         items_preview = COALESCE(EXCLUDED.items_preview, fulfillment_syncs.items_preview),
         status = EXCLUDED.status,
         error = EXCLUDED.error,
         error_code = EXCLUDED.error_code,
         error_detail = EXCLUDED.error_detail,
         applied_items = COALESCE(EXCLUDED.applied_items, fulfillment_syncs.applied_items),
         matched_external_numbers = EXCLUDED.matched_external_numbers,
         order_status_applied = EXCLUDED.order_status_applied,
         review_note = EXCLUDED.review_note,
         approved_at = EXCLUDED.approved_at,
         approved_by = EXCLUDED.approved_by,
         wc_completed_at = COALESCE(fulfillment_syncs.wc_completed_at, EXCLUDED.wc_completed_at),
         updated_at = now()
       WHERE fulfillment_syncs.status NOT IN ('fulfilled', 'applying', 'needs_attention', 'skipped', 'reversed')
       RETURNING *`,
      [
        fields.webhookEventId,
        fields.wcOrderId ?? null,
        fields.orderNumber ?? null,
        fields.orderReceivedDate ?? null,
        fields.suttonSoId ?? null,
        fields.suttonOrderNumber ?? null,
        fields.shippingCountry ?? null,
        fields.warehouseLocation ?? null,
        jsonOrNull(fields.itemsPreview),
        fields.status,
        fields.error ?? null,
        fields.errorCode ?? null,
        jsonOrNull(fields.errorDetail),
        jsonOrNull(fields.appliedItems),
        jsonOrNull(fields.matchedExternalNumbers),
        fields.orderStatusApplied ?? false,
        fields.reviewNote ?? null,
        fields.approvedAt ?? null,
        fields.approvedBy ?? null,
        fields.wcCompletedAt ?? null,
      ]
    );
    // ON CONFLICT ... WHERE can suppress the UPDATE; RETURNING is then empty.
    // Fall back to the existing protected row so callers still get a sync.
    if (!rows.length) {
      const existing = await db.query(
        "SELECT * FROM fulfillment_syncs WHERE webhook_event_id = $1",
        [fields.webhookEventId]
      );
      return existing.rows[0] || null;
    }
    return rows[0];
  }

  /**
   * `warehouse_location` for a row that has deducted stock: the bin(s) it came from. A row that
   * has not deducted keeps PRIMARY_LOCATION_KEY, which the UI shows as the current default bin.
   */
  function binUsed(appliedItems, fallback) {
    const codes = [...new Set((appliedItems || []).map((line) => line.locationCode).filter(Boolean))];
    return codes.length ? codes.join(", ") : fallback;
  }

  async function updateSyncById(db, id, fields) {
    const columns = Object.keys(fields);
    if (!columns.length) return null;
    const setClauses = columns.map((col, i) => `${col} = $${i + 1}`);
    const jsonbCols = new Set([
      "items_preview",
      "error_detail",
      "applied_items",
      "matched_external_numbers",
    ]);
    const values = columns.map((col) =>
      jsonbCols.has(col) && fields[col] != null && typeof fields[col] !== "string"
        ? JSON.stringify(fields[col])
        : fields[col]
    );
    values.push(id);
    const { rows } = await db.query(
      `UPDATE fulfillment_syncs SET ${setClauses.join(", ")}, updated_at = now()
       WHERE id = $${values.length} RETURNING *`,
      values
    );
    return rows[0];
  }

  async function recordApplyEvent(db, syncId, event) {
    await db.query(
      `INSERT INTO fulfillment_apply_events
         (sync_id, trigger, phase, item_id, quantity, adjustment_id, document_number,
          stock_before, ok, error_code, message)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        syncId,
        event.trigger,
        event.phase,
        event.itemId ?? null,
        event.quantity ?? null,
        event.adjustmentId ?? null,
        event.documentNumber ?? null,
        event.stockBefore ?? null,
        event.ok ?? false,
        event.errorCode ?? null,
        event.message ?? null,
      ]
    );
  }

  // ---------------------------------------------------------------------------------------
  // Automated inventory deductions — operator-togglable settings + circuit breaker.
  //
  // DB-backed setting an operator flips from the Configuration tab. It is the only auto-apply
  // control: the scheduled reconcile and a single-row Retry both deduct when it is on, and
  // both leave a matched order at pending_approval when it is off. Approve still deducts
  // either way. A stored FULFILLMENT_AUTO_APPLY value is ignored.
  // ---------------------------------------------------------------------------------------

  const AUTO_DEDUCT_DEFAULTS = {
    auto_deduct_enabled: false,
    auto_deduct_consecutive_failures: 0,
    auto_deduct_failure_threshold: 5,
    auto_deduct_disabled_reason: null,
    auto_deduct_disabled_at: null,
  };

  // STOCK_SHORTAGE never counts toward the breaker: it's a routine business condition with
  // its own graceful needs_attention + manual-rerun path (Recheck stock / Retry apply), not a
  // sign that automation itself is broken. Tripping the breaker on stock shortages would turn
  // automation off every time a SKU simply runs low, defeating the point of automating it.
  const AUTO_DEDUCT_BREAKER_EXCLUDED_CODES = new Set(['STOCK_SHORTAGE']);

  async function getAutoDeductSettingsRow(db) {
    const { rows } = await db.query('SELECT * FROM fulfillment_settings WHERE id = 1', []);
    return rows[0] || null;
  }

  async function updateAutoDeductSettingsRow(db, fields) {
    const columns = Object.keys(fields);
    if (!columns.length) return getAutoDeductSettingsRow(db);
    const setClauses = columns.map((col, i) => `${col} = $${i + 1}`);
    const values = columns.map((col) => fields[col]);
    const { rows } = await db.query(
      `UPDATE fulfillment_settings SET ${setClauses.join(', ')}, updated_at = now() WHERE id = 1 RETURNING *`,
      values
    );
    return rows[0] || null;
  }

  function formatAutoDeductStatus(settings) {
    const row = settings || AUTO_DEDUCT_DEFAULTS;
    return {
      enabled: Boolean(row.auto_deduct_enabled),
      consecutiveFailures: row.auto_deduct_consecutive_failures || 0,
      threshold: row.auto_deduct_failure_threshold || AUTO_DEDUCT_DEFAULTS.auto_deduct_failure_threshold,
      disabledReason: row.auto_deduct_disabled_reason || null,
      disabledAt: row.auto_deduct_disabled_at || null,
    };
  }

  /** Manual on/off from the UI. Turning on clears the breaker's counter and any prior
   * disabled-reason so re-enabling always starts from a clean slate. Turning off records a
   * reason distinct from the breaker's own message, so the UI can tell "an operator chose to
   * turn this off" apart from "this tripped the circuit breaker on its own". */
  async function setAutoDeductEnabledRow(db, { enabled, by } = {}) {
    if (enabled) {
      return updateAutoDeductSettingsRow(db, {
        auto_deduct_enabled: true,
        auto_deduct_consecutive_failures: 0,
        auto_deduct_disabled_reason: null,
        auto_deduct_disabled_at: null,
        auto_deduct_updated_by: by || null,
      });
    }
    return updateAutoDeductSettingsRow(db, {
      auto_deduct_enabled: false,
      auto_deduct_disabled_reason: 'Turned off by operator',
      auto_deduct_disabled_at: new Date(),
      auto_deduct_updated_by: by || null,
    });
  }

  /**
   * Called once per auto-applied reconcile candidate with that candidate's outcome. Resets
   * the consecutive-failure counter on success, increments it on a real failure, and — once
   * the counter reaches auto_deduct_failure_threshold — flips auto_deduct_enabled off so a
   * systemic problem (bad Sutton config, a mis-set-up kit affecting every order, etc.) can't
   * silently keep firing failed auto-applies tick after tick with nobody noticing. Never
   * called for STOCK_SHORTAGE outcomes — see AUTO_DEDUCT_BREAKER_EXCLUDED_CODES above.
   */
  async function recordAutoDeductOutcome(db, { ok, errorCode } = {}) {
    if (!ok && AUTO_DEDUCT_BREAKER_EXCLUDED_CODES.has(errorCode)) return null;
    if (ok) {
      return updateAutoDeductSettingsRow(db, { auto_deduct_consecutive_failures: 0 });
    }
    const settings = await getAutoDeductSettingsRow(db);
    const current = settings || AUTO_DEDUCT_DEFAULTS;
    const nextCount = (current.auto_deduct_consecutive_failures || 0) + 1;
    const threshold = current.auto_deduct_failure_threshold || AUTO_DEDUCT_DEFAULTS.auto_deduct_failure_threshold;
    if (nextCount >= threshold) {
      logFulfillment({
        phase: 'auto_deduct_breaker_tripped',
        consecutiveFailures: nextCount,
        threshold,
        lastErrorCode: errorCode || null,
      });
      return updateAutoDeductSettingsRow(db, {
        auto_deduct_enabled: false,
        auto_deduct_consecutive_failures: nextCount,
        auto_deduct_disabled_reason: `Auto-disabled after ${nextCount} consecutive failures (last: ${
          errorCode || 'UNKNOWN'
        })`,
        auto_deduct_disabled_at: new Date(),
      });
    }
    return updateAutoDeductSettingsRow(db, { auto_deduct_consecutive_failures: nextCount });
  }

  /** `GET /fulfillment/auto-deduct` — current toggle state for the UI. */
  async function getAutoDeductStatus() {
    const db = dbAdapter(env);
    const settings = await getAutoDeductSettingsRow(db);
    return formatAutoDeductStatus(settings);
  }

  /** `POST /fulfillment/auto-deduct` — manual operator on/off. Turning it on submits the
   * poll immediately so rows already at pending approval start deducting, instead of waiting
   * for the next 20-minute tick. A missing scheduler (local dev) does not undo the toggle. */
  async function setAutoDeduct(enabled, { by } = {}) {
    const db = dbAdapter(env);
    const updated = await setAutoDeductEnabledRow(db, { enabled, by });
    if (enabled && isWooCommerceConfigured(env)) {
      try {
        await appJobs({ env }).submit({ name: POLL_JOB_NAME });
      } catch (err) {
        logFulfillment({ phase: "auto_deduct_poll_submit_failed", error: err.message });
      }
    }
    return formatAutoDeductStatus(updated);
  }

  function incompleteOrderLines(order) {
    return (order.items || []).filter((orderItem) => !orderItem.item?.id || !orderItem.quantity);
  }

  function humanError(code, message) {
    const title = ERROR_TITLES[code] || code || "Error";
    return `${title} — ${message}`;
  }

  function makeError(code, message, detail) {
    const err = new Error(humanError(code, message));
    err.code = code;
    err.detail = detail || null;
    return err;
  }

  // Unlike makeError, does not pre-wrap the message with its ERROR_TITLES prefix.
  // Used for errors thrown out of resolveOrderLines(), which may surface through
  // either previewFulfillmentEvent's or runApplyBody's own catch block — both of
  // which already apply the humanError prefix themselves (runApplyBody guards
  // against double-wrapping; previewFulfillmentEvent does not).
  function makeRawError(code, message, detail) {
    const err = new Error(message);
    err.code = code;
    err.detail = detail || null;
    return err;
  }

  /** True when every component in a kit's default BOM is standard-tracked (the only tracking method this app can deduct). */
  function assertComponentStandardTracked(component, kitItem) {
    if (component.trackingMethod === "standard") return;
    throw makeRawError(
      "COMPONENT_NOT_STANDARD",
      `"${component.name}" is a component of kit "${kitItem.name}" (${kitItem.sku || kitItem.id}) but is tracked as "${component.trackingMethod || "unknown"}", not "standard". Kit fulfillment only supports standard-tracked components today — fix the item's tracking method in Sutton, then retry preview.`
    );
  }

  /** True when an item's customFields mark it as a Virtual Kit via the Kit Type field.
   * Always false when the org has no Kit Type field (see getKitTypeIds). */
  function isKitItem(itemNode) {
    if (!kitTypeIds) return false;
    const fields = itemNode?.customFields || [];
    return fields.some(
      (field) =>
        field && field.fieldId === kitTypeIds.fieldId && field.fieldValueOption?.id === kitTypeIds.optionId
    );
  }

  function kitLabel(item) {
    return `"${item?.name || "Unknown item"}" (${item?.sku || item?.id || "unknown"})`;
  }

  /**
   * Resolve an order-line's matched item to the item it should actually be deducted
   * against: substitutes alias items to their fulfillmentItem, then checks the Kit Type
   * custom field on the resolved item. Returns `null` when the item is an alias with no
   * fulfillment item configured — callers should error out rather than guess.
   */
  function resolveFulfillmentItem(itemNode) {
    if (itemNode?.trackingMethod === "alias") {
      return itemNode.fulfillmentItem || null;
    }
    return itemNode;
  }

  /**
   * Fetch fulfillment details for any ids not already in `detailsById`. Ids Sutton does
   * not return are stored as null so a later nested-kit level does not refetch them.
   */
  async function loadItemDetails(detailsById, itemIds) {
    const missing = [...new Set((itemIds || []).filter(Boolean))].filter((id) => !detailsById.has(id));
    if (!missing.length) return;
    const fetched = await fetchItemFulfillmentDetails(env, missing);
    for (const id of missing) {
      detailsById.set(id, fetched.get(id) || null);
    }
  }

  /**
   * A BOM line only carries id/name/sku/trackingMethod, which is not enough to tell a
   * nested Virtual Kit from a real component. Prefer the fetched item (and follow one
   * alias hop). Fall back to the BOM snapshot when the lookup missed — same transient-gap
   * treatment as a plain order line.
   */
  function resolveBomComponent(component, detailsById) {
    const details = detailsById.get(component.id);
    if (!details) return component;
    const resolved = resolveFulfillmentItem(details);
    if (!resolved) {
      throw makeRawError(
        "ALIAS_UNRESOLVED",
        `"${component.name || details.name}" (${component.id}) is an alias item with no fulfillment item configured in Sutton. Set its fulfillment item, then retry preview.`
      );
    }
    return resolved;
  }

  function mergeLeaf(leaves, leaf) {
    const existing = leaves.get(leaf.itemId);
    if (existing) {
      existing.quantity += leaf.quantity;
      return;
    }
    leaves.set(leaf.itemId, { itemId: leaf.itemId, itemName: leaf.itemName, quantity: leaf.quantity });
  }

  /**
   * Walk a Virtual Kit's default BOM. A component that is itself a Virtual Kit is expanded
   * the same way, and quantities multiply down the chain, until every remaining component
   * is not a Virtual Kit. Leaves reached by more than one path are summed into one row.
   * `chain` is the kits already entered on this path, so a loop fails instead of recursing.
   */
  async function expandKitToLeaves(kitItem, multiplier, detailsById, chain) {
    if (chain.some((item) => item.id === kitItem.id)) {
      throw makeRawError(
        "KIT_CYCLE",
        `Virtual kit cycle: ${[...chain, kitItem].map(kitLabel).join(" → ")}. A kit cannot contain itself, directly or through another kit. Remove the loop in Sutton, then retry preview.`
      );
    }

    const bom = (kitItem.boms || [])[0];
    const bomLines = bom?.items?.nodes || [];
    if (!bom || !bomLines.length) {
      throw makeRawError(
        "KIT_BOM_MISSING",
        `${kitLabel(kitItem)} is a Virtual Kit with no default BOM, or an empty default BOM. Add a default BOM with its components in Sutton, then retry preview.`
      );
    }

    await loadItemDetails(
      detailsById,
      bomLines.map((bomLine) => bomLine.item?.id)
    );

    const nextChain = [...chain, kitItem];
    const leaves = new Map();
    for (const bomLine of bomLines) {
      const component = bomLine.item;
      if (!component?.id) continue;
      const componentQty = (Number(bomLine.quantity) || 0) * multiplier;
      const resolved = resolveBomComponent(component, detailsById);

      if (isKitItem(resolved)) {
        const nested = await expandKitToLeaves(resolved, componentQty, detailsById, nextChain);
        for (const leaf of nested.values()) mergeLeaf(leaves, leaf);
        continue;
      }

      assertComponentStandardTracked(resolved, kitItem);
      mergeLeaf(leaves, { itemId: resolved.id, itemName: resolved.name, quantity: componentQty });
    }

    return leaves;
  }

  /**
   * Expands an order's line items into deduction rows: one row per plain item, or one
   * row per non-kit component of a Virtual Kit (including components that sit inside
   * nested Virtual Kits). Component quantity is the BOM quantity times every kit quantity
   * above it, times the order-line quantity. Each row carries a `lineKey`, unique per
   * deduction row even when the same item is deducted more than once in an order (ordered
   * standalone and via a kit, or via two kits) so later apply/resume logic never conflates
   * two distinct sources for the same item. Runs at both preview time and apply time (as
   * the "freshness" recompute), so a kit's BOM / Kit Type / alias resolution is always
   * re-read from Sutton, not cached.
   */
  async function resolveOrderLines(order) {
    kitTypeIds = await getKitTypeIds();
    const orderLines = (order.items || []).filter((orderItem) => orderItem.item?.id && orderItem.quantity);
    const uniqueIds = [...new Set(orderLines.map((orderItem) => orderItem.item.id))];
    const detailsById = new Map();
    await loadItemDetails(detailsById, uniqueIds);

    const rows = [];
    for (const orderLine of orderLines) {
      const rawItemId = orderLine.item.id;
      const rawItemName = orderLine.item.name;
      const quantity = orderLine.quantity;
      const details = detailsById.get(rawItemId);

      // No fulfillment details found for an item Sutton otherwise matched on the order —
      // fall back to the order's own id/name rather than block a plain, non-kit line on
      // what is most likely a transient lookup gap.
      if (!details) {
        rows.push({ lineKey: rawItemId, itemId: rawItemId, itemName: rawItemName, quantity });
        continue;
      }

      const resolved = resolveFulfillmentItem(details);
      if (!resolved) {
        throw makeRawError(
          "ALIAS_UNRESOLVED",
          `"${rawItemName}" (${rawItemId}) is an alias item with no fulfillment item configured in Sutton. Set its fulfillment item, then retry preview.`
        );
      }

      if (!isKitItem(resolved)) {
        rows.push({ lineKey: resolved.id, itemId: resolved.id, itemName: resolved.name, quantity });
        continue;
      }

      const leaves = await expandKitToLeaves(resolved, quantity, detailsById, []);
      for (const leaf of leaves.values()) {
        rows.push({
          lineKey: `${resolved.id}:${leaf.itemId}`,
          itemId: leaf.itemId,
          itemName: leaf.itemName,
          quantity: leaf.quantity,
          kitItemId: resolved.id,
          kitItemName: resolved.name,
          kitSku: resolved.sku || null,
          kitLineQuantity: quantity,
        });
      }
    }

    return rows;
  }

  /** Stable identity for a deduction row, with a fallback for pre-kit-support rows that predate `lineKey`. */
  function effectiveLineKey(line) {
    return line?.lineKey || line?.itemId || null;
  }

  /** Groups deduction rows into their all-or-nothing unit: a kit's full component set, or a lone regular line. */
  function groupKeyFor(line) {
    return line.kitItemId || effectiveLineKey(line);
  }

  function groupPendingLines(lines) {
    const groups = new Map();
    for (const line of lines) {
      const key = groupKeyFor(line);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(line);
    }
    return groups;
  }

  /**
   * Splits pending lines into groups that can be fully covered by remaining stock vs.
   * groups that are short on at least one member. Groups are evaluated in the order
   * they appear so two groups competing for the same component (e.g. a direct order line
   * and a kit that also uses it) don't both "pass" against the same static stock snapshot
   * — the earlier group claims stock first, and a later group short on what's left is
   * reported honestly rather than silently over-deducting.
   */
  function computeShortGroupsAndCoverable(pendingLines, stockByItemId) {
    const remainingStock = new Map(stockByItemId);
    const groups = groupPendingLines(pendingLines);
    const shortGroups = [];
    const coverableLines = [];
    for (const [groupKey, groupLines] of groups) {
      const shortfalls = [];
      for (const line of groupLines) {
        const available = remainingStock.get(line.itemId) || 0;
        if (available < Number(line.quantity)) shortfalls.push({ line, available });
      }
      if (shortfalls.length) {
        shortGroups.push({ groupKey, lines: groupLines, shortfalls });
        continue;
      }
      for (const line of groupLines) {
        remainingStock.set(line.itemId, (remainingStock.get(line.itemId) || 0) - Number(line.quantity));
      }
      coverableLines.push(...groupLines);
    }
    return { shortGroups, coverableLines };
  }

  function appliedMap(appliedItems) {
    const map = new Map();
    for (const line of appliedItems || []) {
      const key = effectiveLineKey(line);
      if (key && line.adjustmentId) map.set(key, line);
    }
    return map;
  }

  function pendingLinesFromSync(sync) {
    const alreadyApplied = appliedMap(sync.applied_items);
    return (sync.items_preview || []).filter((line) => {
      const key = effectiveLineKey(line);
      return key && !alreadyApplied.has(key);
    });
  }

  /** Per-shortfall label matching the "Short N × Item at Location" phrasing operators see. */
  function shortfallLabel(line, available, locationCode) {
    const need = Number(line.quantity) || 0;
    const short = Math.max(need - (Number(available) || 0), 0);
    const kitSuffix = line.kitItemId
      ? ` (component of kit ${line.kitSku || line.kitItemName} x${line.kitLineQuantity})`
      : "";
    return `Short ${short} × ${line.itemName} at ${locationCode}${kitSuffix}`;
  }

  function flattenShortfalls(shortGroups) {
    const flat = [];
    for (const group of shortGroups || []) {
      for (const shortfall of group.shortfalls || []) flat.push(shortfall);
    }
    return flat;
  }

  function groupShortageDetail(shortGroups, stockByItemId, { stockReady = false } = {}) {
    const flat = flattenShortfalls(shortGroups);
    return {
      shortages: flat.map(({ line, available }) => ({
        lineKey: effectiveLineKey(line),
        itemId: line.itemId,
        itemName: line.itemName,
        need: line.quantity,
        have: available,
        kitItemId: line.kitItemId || null,
        kitItemName: line.kitItemName || null,
        kitSku: line.kitSku || null,
        kitLineQuantity: line.kitLineQuantity || null,
      })),
      stockByItem: Object.fromEntries(stockByItemId),
      stockReady,
    };
  }

  function groupShortageMessage(plan, shortGroups, { unchanged = false } = {}) {
    const flat = flattenShortfalls(shortGroups);
    const detail = flat
      .map(({ line, available }) => shortfallLabel(line, available, plan.locationFor(line.itemId).locationCode))
      .join("; ");
    if (unchanged) {
      return `Stock is unchanged: ${detail}. Add or transfer stock, then recheck. Nothing was deducted for this order.`;
    }
    return `${detail}. Add or transfer stock, then recheck or retry. Nothing was deducted for this order — partial fulfillment is not allowed, so every line waits until all of them are in stock.`;
  }

  function shortagesUnchanged(prevDetail, shortGroups) {
    const prev = Array.isArray(prevDetail?.shortages) ? prevDetail.shortages : [];
    if (!prev.length) return false;
    const flat = flattenShortfalls(shortGroups);
    if (!flat.length) return false;
    return flat.every(({ line, available }) => {
      const key = effectiveLineKey(line);
      const match = prev.find((s) => (s.lineKey || s.itemId) === key);
      return match && Number(match.have) === Number(available);
    });
  }

  async function evaluatePendingStock(sync) {
    const pendingLines = pendingLinesFromSync(sync);
    const plan = await planStockLocations(pendingLines.map((line) => line.itemId));
    const { shortGroups, coverableLines } = computeShortGroupsAndCoverable(pendingLines, plan.stockByItemId);
    return { plan, pendingLines, stockByItemId: plan.stockByItemId, shortGroups, coverableLines };
  }

  async function persistStillShort(db, sync, stock, { trigger, unchanged }) {
    const message = humanError(
      "STOCK_SHORTAGE",
      groupShortageMessage(stock.plan, stock.shortGroups, { unchanged })
    );
    await recordApplyEvent(db, sync.id, {
      trigger,
      phase: "preflight",
      ok: false,
      errorCode: "STOCK_SHORTAGE",
      message,
    });
    const status =
      sync.status === "pending_approval" || sync.status === "ready" || sync.status === "applying"
        ? "needs_attention"
        : sync.status;
    return updateSyncById(db, sync.id, {
      status,
      error: message,
      error_code: "STOCK_SHORTAGE",
      error_detail: groupShortageDetail(stock.shortGroups, stock.stockByItemId, { stockReady: false }),
    });
  }

  /** Latest sync row (if any) tracking this Sutton order, by digit_so_id. */
  async function findSyncBySuttonSoId(db, suttonSoId) {
    if (!suttonSoId) return null;
    const { rows } = await db.query(
      "SELECT * FROM fulfillment_syncs WHERE digit_so_id = $1 ORDER BY updated_at DESC LIMIT 1",
      [suttonSoId]
    );
    return rows[0] || null;
  }

  // D1 rejects statements with more than 100 bound parameters.
  const D1_IN_CHUNK = 90;

  function wooOrderNumbers(wcOrder) {
    return [...new Set([wcOrder?.number, wcOrder?.id].filter((v) => v != null && v !== "").map(String))];
  }

  /** For one page of WooCommerce orders, every sync that already refers to each order (by
   * WooCommerce id or order number), newest first. One batched lookup per page instead of one
   * query per order. The poll checks every row, not just the latest, so an older
   * needs_attention row still blocks a second pending row. */
  async function listSyncsTrackingWooOrders(db, wcOrders) {
    const ids = [...new Set(wcOrders.map((o) => wooOrderFields(o).wcOrderId).filter((v) => v != null))];
    const numbers = [...new Set(wcOrders.flatMap(wooOrderNumbers))];
    const found = new Map();
    const collect = async (column, values) => {
      for (let i = 0; i < values.length; i += D1_IN_CHUNK) {
        const { rows } = await db.query(`SELECT * FROM fulfillment_syncs WHERE ${column} = ANY($1::text[])`, [
          values.slice(i, i + D1_IN_CHUNK),
        ]);
        for (const row of rows) found.set(row.id, row);
      }
    };
    await collect("wc_order_id", ids);
    await collect("order_number", numbers);

    const all = [...found.values()];
    const byOrder = new Map();
    for (const wcOrder of wcOrders) {
      const { wcOrderId } = wooOrderFields(wcOrder);
      const orderNumbers = new Set(wooOrderNumbers(wcOrder));
      const rows = all
        .filter(
          (row) =>
            (wcOrderId != null && Number(row.wc_order_id) === wcOrderId) ||
            (row.order_number != null && orderNumbers.has(String(row.order_number)))
        )
        .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
      byOrder.set(wcOrder, rows);
    }
    return byOrder;
  }

  /** Clears a stale auto-retried row — `unmatched` (broken Rutter link) or `failed` with a
   * transient error code (e.g. SUTTON_API) — once a fresh attempt for the same Sutton order
   * lands any outcome of its own (matched, or failed again). Without this, every auto-retry
   * tick would pile up a new row instead of replacing the stale one. Never touches a row some
   * other status already owns. Hard-deletes the stale row outright rather than marking it
   * `skipped`: a skipped row still shows up in the queue, and there should only ever be one
   * row per Sutton order — the fresh row (`excludeSyncId`) already represents this order going
   * forward, so the stale one has nothing left to explain. */
  async function supersedeUnmatchedSync(db, { suttonSoId, excludeSyncId }) {
    const existing = await findSyncBySuttonSoId(db, suttonSoId);
    if (!existing || existing.id === excludeSyncId || !isAutoRetryCandidate(existing)) return null;
    await db.query("DELETE FROM fulfillment_syncs WHERE id = $1", [existing.id]);
    return { deleted: true, id: existing.id };
  }

  // Statuses a duplicate sweep may delete. An unapplied `needs_attention` row (stock shortage
  // with nothing deducted) is in limbo the same way `pending_approval` is — reconcile was
  // queueing a second pending row beside it, and the old sweep left both on screen because
  // it refused to touch `needs_attention` at all. A needs_attention row that already deducted
  // inventory stays protected, as do fulfilled / applying / reversed / rejected / skipped.
  const DUPLICATE_ELIGIBLE_STATUSES = [
    "unmatched",
    "missing_address",
    "failed",
    "pending_approval",
    "ready",
    "needs_attention",
    "awaiting_completion",
  ];
  const DUPLICATE_PASSIVE_STATUSES = new Set(["reversed", "rejected", "skipped", "removed"]);

  function syncHasAppliedWork(sync) {
    if (!sync) return false;
    if (Number(sync.order_status_applied)) return true;
    const applied = sync.applied_items;
    if (Array.isArray(applied)) return applied.length > 0;
    return Boolean(applied && applied !== "[]" && applied !== "");
  }

  function isDeletableDuplicate(row) {
    if (!row || syncHasAppliedWork(row)) return false;
    if (DUPLICATE_PASSIVE_STATUSES.has(row.status)) return false;
    if (row.status === "fulfilled" || row.status === "applying") return false;
    return DUPLICATE_ELIGIBLE_STATUSES.includes(row.status);
  }

  // Lower tier wins. Inventory already moved beats a stock-shortage row, which beats a
  // freshly queued pending/ready row, which beats a failed/unmatched retry.
  function compareDuplicateKeeper(a, b) {
    const tier = (row) => {
      if (syncHasAppliedWork(row) || row.status === "fulfilled" || row.status === "applying") return 0;
      if (row.status === "needs_attention") return 1;
      if (row.status === "pending_approval" || row.status === "ready") return 2;
      return 3;
    };
    const byTier = tier(a) - tier(b);
    if (byTier) return byTier;
    // A row WooCommerce has completed beats one still awaiting completion.
    const byCompleted = Number(Boolean(b.wc_completed_at)) - Number(Boolean(a.wc_completed_at));
    if (byCompleted) return byCompleted;
    const byUpdated = String(b.updated_at || "").localeCompare(String(a.updated_at || ""));
    if (byUpdated) return byUpdated;
    return Number(b.id) - Number(a.id);
  }

  /**
   * Removes every OTHER in-limbo row that shares `suttonSoId` with `keepSyncId` — not just
   * stale unmatched/transient-failed ones (see `supersedeUnmatchedSync` above, which only
   * fires from the reconcile loop's own freshly-created row, and marks `skipped` instead of
   * deleting since that narrower case is a well-understood "this specific retry path is
   * stale" signal worth keeping visible). A true duplicate — two independent rows that both
   * happened to match the same Sutton order — has nothing left to explain once resolved: it's
   * not a row an operator needs to audit, just a bookkeeping accident from a race (reconcile
   * queues a fresh poll row for an order while an older, separate row for that SAME
   * order — e.g. an older row an operator is independently retrying by hand — still
   * shows `unmatched`; if the operator's manual Retry succeeds around the same time reconcile's
   * own row also succeeds, neither one is "stale" at the instant it checks the other). So these
   * are hard-deleted rather than left behind as `skipped` clutter in the queue. Cascades to
   * `fulfillment_apply_events` (ON DELETE CASCADE) — safe, since only in-limbo rows (nothing
   * ever applied) are eligible here. The underlying `webhook_events` row is left alone; it's
   * just a raw inbound/poll log entry, not shown in the queue itself.
   */
  async function supersedeDuplicateSyncs(db, { suttonSoId, keepSyncId }) {
    await consolidateDuplicateSyncs(db);
    if (keepSyncId) {
      const { rows } = await db.query("SELECT * FROM fulfillment_syncs WHERE id = $1", [keepSyncId]);
      if (rows[0]) return rows[0];
    }
    if (!suttonSoId) return null;
    const { rows } = await db.query(
      `SELECT * FROM fulfillment_syncs
        WHERE digit_so_id = $1
          AND status NOT IN ('skipped', 'reversed', 'rejected')
        ORDER BY
          CASE
            WHEN status = 'needs_attention' THEN 0
            WHEN status IN ('pending_approval', 'ready', 'fulfilled', 'applying') THEN 1
            ELSE 2
          END,
          updated_at DESC,
          id DESC
        LIMIT 1`,
      [suttonSoId]
    );
    return rows[0] || null;
  }

  /**
   * One live row per order. Groups rows that share a Sutton order id, a WooCommerce order
   * id, or the same WooCommerce number + Sutton number pair (the pair the queue shows twice),
   * keeps the row that already represents the order, and deletes the other unapplied copies.
   * A needs_attention shortage with nothing deducted wins over a pending duplicate. A row
   * that already deducted inventory, or a fulfilled/applying row, is never deleted. Reversed,
   * rejected, and skipped rows are left for their own paths.
   */
  async function consolidateDuplicateSyncs(db) {
    const { rows } = await db.query(
      `SELECT * FROM fulfillment_syncs
        WHERE digit_so_id IS NOT NULL
           OR wc_order_id IS NOT NULL
           OR (order_number IS NOT NULL AND digit_order_number IS NOT NULL)`
    );
    if (rows.length < 2) return 0;

    const parent = new Map();
    const find = (id) => {
      let root = id;
      while (parent.get(root) !== root) root = parent.get(root);
      let cursor = id;
      while (cursor !== root) {
        const next = parent.get(cursor);
        parent.set(cursor, root);
        cursor = next;
      }
      return root;
    };
    const union = (a, b) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    };
    const link = (index, key, id) => {
      if (key == null || key === "") return;
      if (index.has(key)) union(index.get(key), id);
      else index.set(key, id);
    };

    for (const row of rows) parent.set(row.id, row.id);
    const bySo = new Map();
    const byWc = new Map();
    const byPair = new Map();
    for (const row of rows) {
      link(bySo, row.digit_so_id, row.id);
      if (row.wc_order_id != null) link(byWc, `wc:${row.wc_order_id}`, row.id);
      if (row.order_number && row.digit_order_number) {
        link(byPair, `${row.order_number}\0${row.digit_order_number}`, row.id);
      }
    }

    const groups = new Map();
    for (const row of rows) {
      const root = find(row.id);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(row);
    }

    const loserIds = [];
    for (const groupRows of groups.values()) {
      const anchors = groupRows.filter((row) => !DUPLICATE_PASSIVE_STATUSES.has(row.status));
      if (anchors.length < 2) continue;
      const keeper = [...anchors].sort(compareDuplicateKeeper)[0];
      for (const row of anchors) {
        if (row.id !== keeper.id && isDeletableDuplicate(row)) loserIds.push(row.id);
      }
    }
    if (!loserIds.length) return 0;

    const { rows: deleted } = await db.query(
      `DELETE FROM fulfillment_syncs WHERE id = ANY($1) RETURNING id`,
      [loserIds]
    );
    if (deleted.length) {
      logFulfillment({ phase: "consolidate_duplicates", deleted: deleted.length });
    }
    return deleted.length;
  }

  async function dedupeDigitSoIdCollisions(db) {
    return consolidateDuplicateSyncs(db);
  }

  /**
   * Enforces "only one row per Sutton order" for `skipped` rows specifically, which
   * `dedupeDigitSoIdCollisions` deliberately leaves alone (see `DUPLICATE_ELIGIBLE_STATUSES`
   * comment — `skipped` there is treated as an explicit terminal decision worth keeping
   * visible). In practice, though, a `skipped` row sharing a Sutton order with ANOTHER row is
   * never a decision an operator needs to see: either it's a stale auto-retry that should have
   * been deleted outright (now fixed in `supersedeUnmatchedSync`, but this sweep also cleans up
   * ones produced any other way), or a manual "Mark resolved" on a row that later gained a
   * live duplicate. A skipped row should never be the
   * one kept over a live row for the same order, regardless of which is more recently updated —
   * so, per Sutton order:
   *   - If any OTHER row exists (any status) alongside one or more `skipped` rows, every
   *     `skipped` row for that order is deleted — the other row already represents the order.
   *   - If EVERY row for that order is `skipped` (e.g. several stale auto-retries queued up
   *     with nothing fresh landing yet), the most recently updated one is kept so the order
   *     doesn't vanish from the queue, and the rest are deleted.
   */
  async function deleteSkippedDuplicates(db) {
    const { rows } = await db.query(
      `SELECT id, digit_so_id, status FROM fulfillment_syncs
        WHERE digit_so_id IN (
          SELECT digit_so_id FROM fulfillment_syncs
           WHERE digit_so_id IS NOT NULL
           GROUP BY digit_so_id
          HAVING COUNT(*) > 1
        )
        ORDER BY digit_so_id, updated_at DESC, id DESC`
    );
    const groups = new Map();
    for (const row of rows) {
      if (!groups.has(row.digit_so_id)) groups.set(row.digit_so_id, []);
      groups.get(row.digit_so_id).push(row);
    }
    const loserIds = [];
    for (const groupRows of groups.values()) {
      const skipped = groupRows.filter((row) => row.status === "skipped");
      if (!skipped.length) continue;
      const nonSkipped = groupRows.filter((row) => row.status !== "skipped");
      if (nonSkipped.length) {
        loserIds.push(...skipped.map((row) => row.id));
      } else {
        // Every row for this order is `skipped` — rows are already sorted most-recent-first,
        // so keep the first and delete the rest.
        loserIds.push(...skipped.slice(1).map((row) => row.id));
      }
    }
    if (!loserIds.length) return 0;
    const { rows: deleted } = await db.query(
      `DELETE FROM fulfillment_syncs WHERE id = ANY($1) RETURNING id`,
      [loserIds]
    );
    return deleted.length;
  }

  async function findExistingAppliedSync(db, { suttonSoId, wcOrderId, excludeSyncId }) {
    if (!suttonSoId && !wcOrderId) return null;
    const { rows } = await db.query(
      `SELECT * FROM fulfillment_syncs
        WHERE id <> $1
          AND status IN ('fulfilled', 'applying', 'needs_attention')
          AND (
            ($2::text IS NOT NULL AND digit_so_id = $2)
            OR ($3::bigint IS NOT NULL AND wc_order_id = $3)
          )
        ORDER BY updated_at DESC
        LIMIT 1`,
      [excludeSyncId, suttonSoId || null, wcOrderId ?? null]
    );
    return rows[0] || null;
  }

  // Claim the sync for apply with a conditional status transition so concurrent
  // callers cannot both mutate Sutton.
  async function claimSyncForApply(db, syncId, allowedStatuses) {
    const { rows } = await db.query(
      `UPDATE fulfillment_syncs
          SET status = 'applying', error = NULL, error_code = NULL, error_detail = NULL, updated_at = now()
        WHERE id = $1 AND status = ANY($2::text[])
        RETURNING *`,
      [syncId, allowedStatuses]
    );
    return rows[0] || null;
  }

  function suttonOrderClosedMessage(order) {
    const what = order
      ? `Sutton order ${order.orderNumber || order.id} is ${order.orderStatus}`
      : "The Sutton order was deleted";
    return humanError(
      "SUTTON_ORDER_CLOSED",
      `${what} in Sutton, and WooCommerce had not marked the order completed, so nothing was deducted. Retry if the Sutton order is reopened.`
    );
  }

  // STEP 1 — PREVIEW. Matches the order, resolves the location, computes what
  // would be deducted. When triggerAutoApply is set (the Configuration toggle is on),
  // immediately kicks off applyFulfillment after a successful match.
  async function previewFulfillmentEvent(webhookEvent, { triggerAutoApply = false, knownOrder = null } = {}) {
    const db = dbAdapter(env);
    const payload = webhookEvent.payload || {};

    const wcOrderId = webhookEvent.wc_order_id ?? payload.id ?? null;
    const orderNumber = webhookEvent.order_number || payload.number || String(wcOrderId || "");
    const orderReceivedDate = orderReceivedDateFromPayload(payload);
    const base = { webhookEventId: webhookEvent.id, wcOrderId, orderNumber, orderReceivedDate };

    // Protect terminal / in-flight rows from being reset by a re-delivery or retry.
    const existing = await db.query(
      "SELECT * FROM fulfillment_syncs WHERE webhook_event_id = $1",
      [webhookEvent.id]
    );
    if (existing.rows[0] && TERMINAL_OR_IN_FLIGHT.has(existing.rows[0].status)) {
      logFulfillment({
        phase: "preview_skipped",
        syncId: existing.rows[0].id,
        status: existing.rows[0].status,
        orderNumber,
        reason: "terminal_or_in_flight",
      });
      return existing.rows[0];
    }

    // A row from Sutton's open orders stays Awaiting completion, and never auto-applies,
    // until the WooCommerce poll sees the order completed.
    base.wcCompletedAt =
      existing.rows[0]?.wc_completed_at ||
      (webhookEvent.source !== SUTTON_ORDER_SOURCE ? new Date().toISOString() : null);
    const completed = Boolean(base.wcCompletedAt);
    if (!completed) triggerAutoApply = false;

    // Accumulates whatever this attempt manages to resolve (country, matched Sutton order,
    // previewed items) as it goes. A failure downstream of a successful step — e.g. the
    // order matches fine but `resolveOrderLines` then throws ALIAS_UNRESOLVED, or a Sutton
    // API error during item-detail fetch — must not throw this away: every early-return
    // branch below (and the catch-all) merges this in, so a row that already found its
    // Sutton order keeps `digit_so_id` even when THIS attempt fails before re-matching (a
    // bad shipping address, a transient error, etc.). Seeded from whatever the row already
    // knew, so e.g. a missing-address failure on a *previously matched* row doesn't wipe out
    // its Sutton order link just because address resolution runs before matching.
    let resolved = existing.rows[0]?.digit_so_id
      ? { suttonSoId: existing.rows[0].digit_so_id, suttonOrderNumber: existing.rows[0].digit_order_number }
      : {};

    try {
      // Match FIRST, then resolve address from the freshly-matched Sutton order's own
      // shippingAddress — not from the stored payload snapshot. The payload's `shipping`
      // field is a point-in-time copy of the WooCommerce order and can go stale (e.g.
      // blank at poll time, filled in later in Sutton). Deriving address from this attempt's live match means a retry
      // always reflects Sutton's current data, instead of re-checking a frozen snapshot that
      // can never change no matter how many times it's retried.
      const candidateNumbers = candidateExternalOrderNumbers(payload, { wcOrderId, orderNumber });
      resolved.matchedExternalNumbers = candidateNumbers;
      // `retrySync` already refetches the order fresh by id (findOrderById) when the row's
      // digit_so_id is known, purely to rebuild an up-to-date payload snapshot. Re-running
      // findOrderByExternalNumbers here against that same order would be a second, redundant
      // Sutton GraphQL round trip doing nothing but confirming what retrySync already just
      // fetched — real cost under a bulk "Retry (N)" sweep, where every extra round trip per
      // row adds up and raises the odds of a slow row tripping the platform's own backend
      // timeout (BACKEND_UNAVAILABLE / 502). Skip straight to using it when supplied.
      const order = knownOrder || (await findOrderByExternalNumbers(env, candidateNumbers, EXTERNAL_ORDER_PLATFORM));
      if (!order) {
        const row = await upsertSyncRow(db, {
          ...base,
          ...resolved,
          status: "unmatched",
          errorCode: "UNMATCHED",
          error: humanError(
            "UNMATCHED",
            `No Sutton order found for any of [${candidateNumbers.join(", ")}]${
              EXTERNAL_ORDER_PLATFORM ? ` on platform "${EXTERNAL_ORDER_PLATFORM}"` : ""
            }. Confirm the order synced into Sutton, then retry preview.`
          ),
        });
        logFulfillment({ phase: "preview", syncId: row?.id, status: "unmatched", orderNumber, candidateNumbers });
        return row;
      }
      resolved.suttonSoId = order.id;
      resolved.suttonOrderNumber = order.orderNumber;

      // Fall back to the freshly-matched order's own createdAt when the stored payload has
      // no usable date_created/date_paid field. Never overrides a real payload-derived date.
      if (!base.orderReceivedDate && order.createdAt) {
        resolved.orderReceivedDate = parseWooDate(order.createdAt);
      }

      // A completed WooCommerce order whose Sutton order was already fulfilled outside this
      // app (common for a backlog of old orders) has nothing to deduct. Park it at `skipped`
      // instead of queueing it for an apply that would only refuse with
      // ALREADY_FULFILLED_IN_SUTTON.
      if (!completed && !OPEN_ORDER_STATUSES.includes(order.orderStatus)) {
        const row = await upsertSyncRow(db, {
          ...base,
          ...resolved,
          status: "skipped",
          errorCode: "SUTTON_ORDER_CLOSED",
          error: suttonOrderClosedMessage(order),
        });
        logFulfillment({ phase: "preview", syncId: row?.id, status: "skipped", errorCode: "SUTTON_ORDER_CLOSED", orderNumber });
        return row;
      }

      if (order.orderStatus === "fulfilled" && !syncHasAppliedWork(existing.rows[0])) {
        const row = await upsertSyncRow(db, {
          ...base,
          ...resolved,
          status: "skipped",
          errorCode: "ALREADY_FULFILLED_IN_SUTTON",
          error: humanError(
            "ALREADY_FULFILLED_IN_SUTTON",
            `Sutton order ${order.orderNumber || order.id} was already fulfilled when this completed WooCommerce order was polled, so nothing was deducted. Delete this row, or Retry if the Sutton order is reopened.`
          ),
        });
        logFulfillment({ phase: "preview", syncId: row?.id, status: "skipped", errorCode: "ALREADY_FULFILLED_IN_SUTTON", orderNumber });
        return row;
      }

      // Recorded for display only — every order deducts from the one configured warehouse.
      const country =
        (order.shippingAddress?.country || payload.shipping?.country || payload.billing?.country || "")
          .toUpperCase() || null;
      resolved.shippingCountry = country;
      resolved.warehouseLocation = PRIMARY_LOCATION_KEY;

      try {
        await requireWarehouseLocation();
      } catch (locationErr) {
        const row = await upsertSyncRow(db, {
          ...base,
          ...resolved,
          status: "failed",
          errorCode: locationErr.code || "LOCATION_UNRESOLVED",
          error: locationErr.message,
        });
        logFulfillment({ phase: "preview", syncId: row?.id, status: "failed", errorCode: "LOCATION_UNRESOLVED", orderNumber });
        return row;
      }

      const incomplete = incompleteOrderLines(order);
      const items = await resolveOrderLines(order);
      resolved.itemsPreview = items;
      if (incomplete.length) {
        const row = await upsertSyncRow(db, {
          ...base,
          ...resolved,
          status: "failed",
          errorCode: "INCOMPLETE_ITEMS",
          error: humanError(
            "INCOMPLETE_ITEMS",
            `${incomplete.length} Sutton order line(s) are missing an item id or quantity and would be silently skipped. Fix the Sutton sales order, then retry preview.`
          ),
          errorDetail: { incompleteCount: incomplete.length },
        });
        logFulfillment({ phase: "preview", syncId: row?.id, status: "failed", errorCode: "INCOMPLETE_ITEMS", orderNumber });
        return row;
      }

      if (!items.length) {
        const row = await upsertSyncRow(db, {
          ...base,
          ...resolved,
          status: "failed",
          errorCode: "INCOMPLETE_ITEMS",
          error: humanError(
            "INCOMPLETE_ITEMS",
            `Sutton order ${order.orderNumber || order.id} has no deductable line items. Fix the sales order in Sutton, then retry preview.`
          ),
        });
        logFulfillment({ phase: "preview", syncId: row?.id, status: "failed", errorCode: "INCOMPLETE_ITEMS", orderNumber });
        return row;
      }

      const readyStatus = !completed ? "awaiting_completion" : triggerAutoApply ? "ready" : "pending_approval";
      let row = await upsertSyncRow(db, {
        ...base,
        orderReceivedDate: resolved.orderReceivedDate ?? base.orderReceivedDate,
        suttonSoId: order.id,
        suttonOrderNumber: order.orderNumber,
        shippingCountry: country,
        warehouseLocation: PRIMARY_LOCATION_KEY,
        matchedExternalNumbers: candidateNumbers,
        itemsPreview: items,
        status: readyStatus,
        error: null,
        errorCode: null,
        errorDetail: null,
        // Do not wipe applied_items on re-preview of a non-terminal row.
        appliedItems: null,
        orderStatusApplied: false,
        reviewNote: null,
        approvedAt: null,
        approvedBy: null,
      });

      logFulfillment({
        phase: "preview",
        syncId: row?.id,
        status: readyStatus,
        orderNumber,
        suttonSoId: order.id,
        autoApply: triggerAutoApply,
      });

      // This attempt just matched `order.id` — if any OTHER row (reconcile-created, a
      // separate older row, etc.) also matched the same Sutton order and is still sitting in
      // an in-limbo status, this is a duplicate that `supersedeUnmatchedSync` alone wouldn't
      // have caught (it only fires from the reconcile loop, and only for stale rows). Delete it
      // here too, from every path that lands a sync in a matched state.
      if (row?.id) {
        const survivor = await supersedeDuplicateSyncs(db, { suttonSoId: order.id, keepSyncId: row.id });
        if (survivor) row = survivor;
      }

      if (triggerAutoApply && row?.status === "ready") {
        row = await applyFulfillment(row.id, { trigger: "auto" });
      }

      return row;
    } catch (err) {
      const row = await upsertSyncRow(db, {
        ...base,
        ...resolved,
        status: "failed",
        errorCode: err.code || "SUTTON_API",
        error: humanError(err.code || "SUTTON_API", err.message),
        errorDetail: err.detail || null,
      });
      logFulfillment({
        phase: "preview",
        syncId: row?.id,
        status: "failed",
        errorCode: err.code || "SUTTON_API",
        orderNumber,
        suttonSoId: resolved.suttonSoId || null,
        error: err.message,
      });
      return row;
    }
  }

  /**
   * Apply inventory deductions + mark Sutton order fulfilled.
   * @param {number} syncId
   * @param {{ trigger?: string, dryRun?: boolean, statusOnly?: boolean, approvedBy?: string }} opts
   */
  async function applyFulfillment(syncId, { trigger = "manual", dryRun, statusOnly, approvedBy } = {}) {
    if (dryRun && cfg.nodeEnv === "production") {
      throw makeError("DRY_RUN_DISABLED", "Dry run approval is a local testing aid and is disabled in production.");
    }

    const db = dbAdapter(env);
    const { rows } = await db.query("SELECT * FROM fulfillment_syncs WHERE id = $1", [syncId]);
    const sync = rows[0];
    if (!sync) return null;

    const logBase = {
      syncId,
      wcOrderId: sync.wc_order_id,
      orderNumber: sync.order_number,
      suttonSoId: sync.digit_so_id,
      warehouseLocation: sync.warehouse_location,
      trigger,
    };

    // Inventory only moves for orders WooCommerce has marked completed. A row that already
    // deducted something (a resume or status-only retry) is past that check.
    if (!sync.wc_completed_at && !syncHasAppliedWork(sync)) {
      throw makeError(
        "AWAITING_COMPLETION",
        `WooCommerce has not marked order #${sync.order_number || sync.wc_order_id || syncId} completed yet. It can be approved once the WooCommerce poll sees it completed.`
      );
    }

    // statusOnly: inventory already fully applied; only retry markOrderFulfilled.
    if (statusOnly) {
      return retryOrderStatusOnly(sync, { trigger: trigger || "status_only", approvedBy });
    }

    if (dryRun) {
      // Dry run never claims the row or writes audit/status — inspect-only.
      return runApplyBody(sync, {
        trigger: "dry_run",
        dryRun: true,
        claim: false,
        approvedBy,
        logBase,
      });
    }

    // Idempotency: already done.
    if (sync.status === "fulfilled" && sync.order_status_applied) {
      logFulfillment({ ...logBase, phase: "skipped", errorCode: "ALREADY_APPLIED" });
      await recordApplyEvent(db, syncId, {
        trigger,
        phase: "skipped",
        ok: true,
        errorCode: "ALREADY_APPLIED",
        message: "Sync already fulfilled; nothing to do.",
      });
      return sync;
    }

    // Known shortage: recheck Sutton stock before claiming. Partial fulfillment is not
    // allowed, so the retry is refused while any line is still short, and the row never
    // flips through applying.
    if (sync.error_code === "STOCK_SHORTAGE") {
      const stock = await evaluatePendingStock(sync);
      if (stock.shortGroups.length) {
        const unchanged = shortagesUnchanged(sync.error_detail, stock.shortGroups);
        await persistStillShort(db, sync, stock, { trigger, unchanged });
        throw makeError(
          "STOCK_SHORTAGE",
          unchanged
            ? "Stock is unchanged — still not enough to fulfill this order. Add or transfer stock, then recheck."
            : groupShortageMessage(stock.plan, stock.shortGroups),
          groupShortageDetail(stock.shortGroups, stock.stockByItemId, { stockReady: false })
        );
      }
    }

    // Resume from needs_attention / failed, or start from ready / pending_approval.
    const claimable = new Set(["needs_attention", "failed", "ready", "pending_approval"]);
    const allowed = claimable.has(sync.status) ? [sync.status] : [];

    if (!allowed.length) {
      if (sync.status === "applying") {
        throw makeError(
          "IN_PROGRESS",
          `Sync #${syncId} is already applying. Wait for it to finish or inspect apply events.`
        );
      }
      throw makeError(
        "INVALID_STATUS",
        `Cannot apply a sync in status "${sync.status}" — expected ready, pending_approval, needs_attention, or failed.`
      );
    }

    const claimed = await claimSyncForApply(db, syncId, allowed);
    if (!claimed) {
      throw makeError(
        "IN_PROGRESS",
        `Could not claim sync #${syncId} for apply (status may have changed). Refresh and try again.`
      );
    }

    return runApplyBody(claimed, {
      trigger,
      dryRun: false,
      claim: true,
      approvedBy,
      logBase,
    });
  }

  async function runApplyBody(sync, { trigger, dryRun, approvedBy, logBase, rerunReversed = false }) {
    const db = dbAdapter(env);
    const syncId = sync.id;
    let appliedItems = [...(sync.applied_items || [])];
    const alreadyApplied = appliedMap(appliedItems);
    let inventoryComplete = false;

    try {
      // Cross-sync idempotency: another sync for the same Sutton SO or WC order.
      if (!dryRun) {
        const other = await findExistingAppliedSync(db, {
          suttonSoId: sync.digit_so_id,
          wcOrderId: sync.wc_order_id,
          excludeSyncId: syncId,
        });
        if (other && other.status === "fulfilled") {
          throw makeError(
            "ALREADY_APPLIED",
            `Sutton order ${sync.digit_order_number || sync.digit_so_id} was already applied via sync #${other.id} (order #${other.order_number}). Skipping to avoid double-deduct. Mark this sync resolved if it is a duplicate delivery.`
          );
        }
        if (other && other.status === "applying") {
          throw makeError(
            "IN_PROGRESS",
            `Another sync (#${other.id}) for this order is currently applying.`
          );
        }
        if (other && other.status === "needs_attention") {
          throw makeError(
            "PARTIAL_APPLY",
            `Another sync (#${other.id}) for this order needs attention (partial apply). Resolve that sync before applying this one, or mark this duplicate resolved.`
          );
        }
      }

      await requireWarehouseLocation();

      const storedCandidates = Array.isArray(sync.matched_external_numbers)
        ? sync.matched_external_numbers.map(String)
        : [];
      const candidateNumbers = [
        ...new Set(
          [...storedCandidates, sync.order_number, sync.wc_order_id].filter(Boolean).map(String)
        ),
      ];
      const order = await findOrderByExternalNumbers(env, candidateNumbers, EXTERNAL_ORDER_PLATFORM);
      if (!order) {
        throw makeError(
          "ORDER_NOT_FOUND",
          `Sutton order ${sync.digit_order_number || sync.digit_so_id || ""} for order #${sync.order_number} could no longer be found — retry preview to refresh before applying.`
        );
      }

      // Already fulfilled in Sutton with no local applied lines — do not re-deduct.
      // An explicit rerun of a reversed row is the exception: the operator undid
      // this row's deductions and asked to deduct them again.
      if (
        !rerunReversed &&
        order.orderStatus === "fulfilled" &&
        alreadyApplied.size === 0 &&
        !sync.order_status_applied
      ) {
        throw makeError(
          "ALREADY_FULFILLED_IN_SUTTON",
          `Sutton order ${order.orderNumber || order.id} is already orderStatus=fulfilled and this sync has no recorded deductions. Refusing to deduct again — mark resolved if inventory was handled outside this module.`
        );
      }

      const incomplete = incompleteOrderLines(order);
      if (incomplete.length && alreadyApplied.size === 0) {
        throw makeError(
          "INCOMPLETE_ITEMS",
          `${incomplete.length} Sutton order line(s) are missing an item id or quantity. Fix the sales order in Sutton, retry preview, then resume.`
        );
      }

      const freshItems = await resolveOrderLines(order);
      const preview = sync.items_preview || [];
      const itemsChanged =
        freshItems.length !== preview.length ||
        freshItems.some((fresh) => {
          const match = preview.find((p) => effectiveLineKey(p) === fresh.lineKey);
          return !match || Number(match.quantity) !== Number(fresh.quantity);
        });
      // Allow resume when we already have partial applied_items even if preview
      // is stale relative to Sutton — but block a fresh apply on stale preview.
      if (itemsChanged && alreadyApplied.size === 0 && !rerunReversed) {
        throw makeError(
          "STALE_ITEMS",
          "This order's items changed since it was previewed — retry preview to refresh, then apply again."
        );
      }

      const linesToDeduct = freshItems.length ? freshItems : preview;
      const pendingLines = linesToDeduct.filter((line) => !alreadyApplied.has(effectiveLineKey(line)));

      let adjustmentReasonTermId = null;
      if (pendingLines.length) {
        try {
          const settings = await getAutoDeductSettingsRow(db);
          adjustmentReasonTermId = await findOrCreateAdjustmentReasonTermId(env, {
            value: WOOCOMMERCE_ADJUSTMENT_REASON,
            cachedId: settings?.adjustment_reason_id || null,
            onResolved: (id) => updateAutoDeductSettingsRow(db, { adjustment_reason_id: id }),
          });
        } catch (reasonErr) {
          throw makeError(reasonErr.code || "SUTTON_API", reasonErr.message);
        }
      }

      // Stock pre-check only for lines we still need to deduct. The whole order is
      // all-or-nothing: if any group (a kit's full component set, or a lone regular line)
      // is short, nothing is deducted and every short group is reported together.
      let coverableLines = pendingLines;
      let plan = null;
      if (pendingLines.length) {
        plan = await planStockLocations(pendingLines.map((line) => line.itemId));
        const computed = computeShortGroupsAndCoverable(pendingLines, plan.stockByItemId);
        if (computed.shortGroups.length) {
          throw makeError(
            "STOCK_SHORTAGE",
            groupShortageMessage(plan, computed.shortGroups),
            groupShortageDetail(computed.shortGroups, plan.stockByItemId, { stockReady: false })
          );
        }
        coverableLines = computed.coverableLines;

        await recordApplyEvent(db, syncId, {
          trigger,
          phase: "preflight",
          ok: true,
          message: dryRun
            ? `Dry run preflight ok — ${coverableLines.length} line(s) would be deducted`
            : `Preflight ok — ${coverableLines.length} line(s) to deduct (${alreadyApplied.size} already applied)`,
        });
      }

      const dryRunCalls = [];
      inventoryComplete = pendingLines.length === 0 && alreadyApplied.size > 0;

      for (const line of coverableLines) {
        const lineLocation = plan.locationFor(line.itemId);
        const stockByItemId = await fetchStockAtLocation(env, {
          itemIds: [line.itemId],
          warehouseLocationId: lineLocation.id,
        });
        const stockBefore = stockByItemId.get(line.itemId) || 0;

        const result = await deductInventoryAtLocation(env, {
          itemId: line.itemId,
          warehouseLocationId: lineLocation.id,
          quantity: line.quantity,
          adjustmentReasonTermId,
          notes: line.kitItemId
            ? `WooCommerce fulfillment sync — order #${sync.order_number} (kit ${
                line.kitSku || line.kitItemName
              })`
            : `WooCommerce fulfillment sync — order #${sync.order_number}`,
          dryRun,
        });

        if (dryRun) {
          dryRunCalls.push(result);
          continue;
        }

        const appliedLine = {
          lineKey: effectiveLineKey(line),
          itemId: line.itemId,
          itemName: line.itemName,
          quantity: line.quantity,
          kitItemId: line.kitItemId || null,
          kitItemName: line.kitItemName || null,
          kitSku: line.kitSku || null,
          kitLineQuantity: line.kitLineQuantity || null,
          adjustmentId: result?.id || null,
          documentNumber: result?.documentNumber || null,
          warehouseLocationId: lineLocation.id,
          locationCode: lineLocation.locationCode,
        };
        appliedItems.push(appliedLine);
        alreadyApplied.set(appliedLine.lineKey, appliedLine);

        // Persist immediately so a later failure does not lose adjustment ids.
        await updateSyncById(db, syncId, { applied_items: appliedItems });
        await recordApplyEvent(db, syncId, {
          trigger,
          phase: "deduct_line",
          itemId: line.itemId,
          quantity: line.quantity,
          adjustmentId: appliedLine.adjustmentId,
          documentNumber: appliedLine.documentNumber,
          stockBefore,
          ok: true,
          message: line.kitItemId
            ? `Deducted ${line.itemName} x${line.quantity} at ${lineLocation.locationCode} — component of kit ${
                line.kitSku || line.kitItemName
              } x${line.kitLineQuantity} (order #${sync.order_number})`
            : `Deducted ${line.itemName} x${line.quantity} at ${lineLocation.locationCode}`,
        });
        logFulfillment({
          ...logBase,
          phase: "deduct_line",
          itemId: line.itemId,
          kitItemId: line.kitItemId || null,
          adjustmentId: appliedLine.adjustmentId,
          quantity: line.quantity,
        });
      }

      if (!dryRun) {
        inventoryComplete =
          linesToDeduct.length > 0 && appliedMap(appliedItems).size >= linesToDeduct.length;
      }

      // Enrich items_preview with adjustment ids for the dashboard status column.
      const appliedPreview = linesToDeduct.map((line) => {
        const applied = alreadyApplied.get(effectiveLineKey(line));
        return applied ? { ...line, ...applied } : { ...line };
      });

      const alreadyFulfilledInSutton = rerunReversed && order.orderStatus === "fulfilled";
      const orderResult = alreadyFulfilledInSutton
        ? { skipped: true, reason: "already_fulfilled" }
        : await markOrderFulfilled(env, order.id, { dryRun });
      if (dryRun) {
        dryRunCalls.push(orderResult);
        return { ...sync, dryRun: true, dryRunCalls };
      }

      await recordApplyEvent(db, syncId, {
        trigger,
        phase: "mark_fulfilled",
        ok: true,
        message: alreadyFulfilledInSutton
          ? `Sutton order ${order.orderNumber || order.id} was already fulfilled; inventory deducted again`
          : `Marked Sutton order ${order.orderNumber || order.id} fulfilled`,
      });

      const fulfilled = await updateSyncById(db, syncId, {
        status: "fulfilled",
        warehouse_location: binUsed(appliedItems, sync.warehouse_location),
        error: null,
        error_code: null,
        error_detail: null,
        items_preview: appliedPreview,
        applied_items: appliedItems,
        order_status_applied: true,
        approved_at: new Date(),
        approved_by: approvedBy || (trigger === "auto" ? "auto" : null),
      });

      await recordApplyEvent(db, syncId, {
        trigger,
        phase: "complete",
        ok: true,
        message: "Apply complete",
      });
      logFulfillment({ ...logBase, phase: "complete", status: "fulfilled" });
      return fulfilled;
    } catch (err) {
      const code = err.code || "SUTTON_API";
      const preflightCodes = new Set([
        "STOCK_SHORTAGE",
        "STALE_ITEMS",
        "CONFIG_MISSING",
        "ORDER_NOT_FOUND",
        "LOCATION_UNRESOLVED",
        "INCOMPLETE_ITEMS",
        "ALREADY_APPLIED",
        "ALREADY_FULFILLED_IN_SUTTON",
        "IN_PROGRESS",
        "INVALID_STATUS",
        "DRY_RUN_DISABLED",
        "PARTIAL_APPLY",
        "ALIAS_UNRESOLVED",
        "KIT_BOM_MISSING",
        "KIT_CYCLE",
        "COMPONENT_NOT_STANDARD",
      ]);

      const allLinesDone =
        inventoryComplete ||
        ((sync.items_preview || []).length > 0 &&
          appliedMap(appliedItems).size >= (sync.items_preview || []).length);

      let errorCode = code;
      let message = err.message;
      if (allLinesDone && !preflightCodes.has(code)) {
        errorCode = "ORDER_STATUS_FAILED";
        const docs = appliedItems
          .map((l) => l.documentNumber || l.adjustmentId)
          .filter(Boolean)
          .join(", ");
        message = humanError(
          "ORDER_STATUS_FAILED",
          `Inventory was deducted (${docs || `${appliedItems.length} line(s)`}) but the Sutton sales order was not marked fulfilled (${err.message}). Use "Retry order status" — do not re-deduct inventory.`
        );
      } else if (appliedItems.length && !preflightCodes.has(code)) {
        errorCode = "PARTIAL_APPLY";
        const done = appliedItems
          .map((l) => `${l.itemName} x${l.quantity}${l.documentNumber ? ` (${l.documentNumber})` : ""}`)
          .join(", ");
        message = humanError(
          "PARTIAL_APPLY",
          `Deducted ${done}; then failed: ${err.message}. Do not re-run a full apply. Reverse those adjustments in Sutton if aborting, or use Resume to deduct remaining lines only.`
        );
      } else if (!String(message).startsWith(ERROR_TITLES[errorCode] || "\0")) {
        message = humanError(errorCode, String(err.message).replace(/^[A-Za-z0-9_ ]+ — /, ""));
      }

      // Apply was attempted — never return to pending_approval (that still looks
      // like "waiting for a first approve"). Partial inventory / order-status
      // failures always need attention. Manual-mode preflight failures (stock
      // shortage, stale items, …) do too. Auto-apply preflight stays `failed`
      // so Retry apply is the primary action in that mode.
      const restoreStatus =
        appliedItems.length || errorCode === "ORDER_STATUS_FAILED" || trigger !== "auto"
          ? "needs_attention"
          : "failed";

      const enrichedPreview = (sync.items_preview || []).map((line) => {
        const applied = appliedMap(appliedItems).get(effectiveLineKey(line));
        return applied ? { ...line, ...applied } : line;
      });

      await recordApplyEvent(db, syncId, {
        trigger,
        phase: "failed",
        ok: false,
        errorCode,
        message,
      });

      const updated = await updateSyncById(db, syncId, {
        status: restoreStatus,
        warehouse_location: binUsed(appliedItems, sync.warehouse_location),
        error: message,
        error_code: errorCode,
        error_detail: err.detail || null,
        applied_items: appliedItems,
        items_preview: enrichedPreview.length ? enrichedPreview : sync.items_preview,
        order_status_applied: false,
      });

      logFulfillment({
        ...logBase,
        phase: "failed",
        errorCode,
        status: restoreStatus,
        appliedCount: appliedItems.length,
        error: err.message,
      });

      return updated;
    }
  }

  async function retryOrderStatusOnly(sync, { trigger, approvedBy }) {
    const db = dbAdapter(env);
    const syncId = sync.id;
    const appliedItems = sync.applied_items || [];
    const preview = sync.items_preview || [];

    if (!appliedItems.length || appliedMap(appliedItems).size < preview.length) {
      throw makeError(
        "INVALID_STATUS",
        "Cannot retry order status only — inventory lines are not fully applied. Use Resume apply instead."
      );
    }

    const claimed = await claimSyncForApply(db, syncId, ["needs_attention", "failed"]);
    if (!claimed) {
      throw makeError(
        "IN_PROGRESS",
        `Could not claim sync #${syncId} for order-status retry.`
      );
    }

    const logBase = {
      syncId,
      wcOrderId: sync.wc_order_id,
      orderNumber: sync.order_number,
      suttonSoId: sync.digit_so_id,
      trigger,
    };

    try {
      const storedCandidates = Array.isArray(sync.matched_external_numbers)
        ? sync.matched_external_numbers.map(String)
        : [];
      const candidateNumbers = [
        ...new Set(
          [...storedCandidates, sync.order_number, sync.wc_order_id].filter(Boolean).map(String)
        ),
      ];
      const order = await findOrderByExternalNumbers(env, candidateNumbers, EXTERNAL_ORDER_PLATFORM);
      if (!order) {
        throw makeError("ORDER_NOT_FOUND", "Sutton order could no longer be found for status retry.");
      }

      if (order.orderStatus === "fulfilled") {
        const fulfilled = await updateSyncById(db, syncId, {
          status: "fulfilled",
          error: null,
          error_code: null,
          error_detail: null,
          order_status_applied: true,
          approved_at: sync.approved_at || new Date(),
          approved_by: approvedBy || sync.approved_by || "status_only",
        });
        await recordApplyEvent(db, syncId, {
          trigger,
          phase: "complete",
          ok: true,
          message: "Sutton order already fulfilled; marked sync complete",
        });
        return fulfilled;
      }

      await markOrderFulfilled(env, order.id);
      await recordApplyEvent(db, syncId, {
        trigger,
        phase: "mark_fulfilled",
        ok: true,
        message: `Marked Sutton order ${order.orderNumber || order.id} fulfilled`,
      });

      const fulfilled = await updateSyncById(db, syncId, {
        status: "fulfilled",
        error: null,
        error_code: null,
        error_detail: null,
        order_status_applied: true,
        approved_at: sync.approved_at || new Date(),
        approved_by: approvedBy || sync.approved_by || "status_only",
      });
      await recordApplyEvent(db, syncId, {
        trigger,
        phase: "complete",
        ok: true,
        message: "Order status retry complete",
      });
      logFulfillment({ ...logBase, phase: "complete", status: "fulfilled" });
      return fulfilled;
    } catch (err) {
      const message = humanError(
        "ORDER_STATUS_FAILED",
        `Inventory remains deducted; order status retry failed: ${err.message}. Retry order status again after fixing Sutton.`
      );
      await recordApplyEvent(db, syncId, {
        trigger,
        phase: "failed",
        ok: false,
        errorCode: "ORDER_STATUS_FAILED",
        message,
      });
      return updateSyncById(db, syncId, {
        status: "needs_attention",
        error: message,
        error_code: "ORDER_STATUS_FAILED",
        error_detail: err.detail || null,
      });
    }
  }

  // Thin wrapper — keeps the existing approve route working during the
  // transition away from the human gate.
  async function approveSync(syncId, { approvedBy, dryRun } = {}) {
    return applyFulfillment(syncId, { trigger: "manual", approvedBy, dryRun });
  }

  async function resumeApply(syncId, { approvedBy } = {}) {
    return applyFulfillment(syncId, { trigger: "resume", approvedBy });
  }

  /** Refresh on-hand qty for a STOCK_SHORTAGE row. Retry apply stays blocked until stock covers every pending line. */
  async function recheckStock(syncId) {
    const db = dbAdapter(env);
    const { rows } = await db.query("SELECT * FROM fulfillment_syncs WHERE id = $1", [syncId]);
    const sync = rows[0];
    if (!sync) return null;
    if (sync.error_code !== "STOCK_SHORTAGE") {
      throw makeError(
        "INVALID_STATUS",
        "Stock recheck is only for orders that failed with a stock shortage."
      );
    }

    const stock = await evaluatePendingStock(sync);
    if (stock.shortGroups.length) {
      const unchanged = shortagesUnchanged(sync.error_detail, stock.shortGroups);
      const updated = await persistStillShort(db, sync, stock, { trigger: "recheck", unchanged });
      return { stockReady: false, unchanged, sync: updated };
    }

    const updated = await persistStockReady(db, sync, stock, { trigger: "recheck" });
    return { stockReady: true, unchanged: false, sync: updated };
  }

  /** Keeps the shortage code but flags the row as fully covered, which enables Retry apply. */
  async function persistStockReady(db, sync, stock, { trigger }) {
    await recordApplyEvent(db, sync.id, {
      trigger,
      phase: "preflight",
      ok: true,
      message: `Stock available — ${stock.pendingLines.length} line(s) can be deducted`,
    });
    return updateSyncById(db, sync.id, {
      error: humanError(
        "STOCK_SHORTAGE",
        `Stock is now available at ${stock.plan.locationLabel}. Retry apply to deduct.`
      ),
      error_code: "STOCK_SHORTAGE",
      error_detail: {
        shortages: [],
        stockByItem: Object.fromEntries(stock.stockByItemId),
        stockReady: true,
      },
    });
  }

  async function retryOrderStatus(syncId, { approvedBy } = {}) {
    return applyFulfillment(syncId, { trigger: "status_only", statusOnly: true, approvedBy });
  }

  /**
   * Hides one unmatched row that has never deducted inventory. The row stays, with status
   * `removed`, so the poll still sees the order and does not insert it again. A conditional
   * update loses to any status change that landed first.
   */
  async function removeUnmatchedSync(syncId) {
    const db = dbAdapter(env);
    const { rows } = await db.query(
      `UPDATE fulfillment_syncs
          SET status = 'removed', updated_at = datetime('now')
        WHERE id = $1
          AND status = 'unmatched'
          AND order_status_applied = 0
          AND (applied_items IS NULL OR applied_items IN ('', '[]'))
        RETURNING *`,
      [syncId]
    );
    if (rows[0]) return rows[0];
    const existing = await db.query("SELECT id, status FROM fulfillment_syncs WHERE id = $1", [syncId]);
    if (!existing.rows.length) return null;
    throw makeError(
      "INVALID_STATUS",
      "Only an unmatched order with nothing deducted can be removed from the log."
    );
  }

  /** Puts one removed row back on the log as unmatched. Does not deduct. */
  async function restoreRemovedSync(syncId) {
    const db = dbAdapter(env);
    const { rows } = await db.query(
      `UPDATE fulfillment_syncs
          SET status = 'unmatched', updated_at = datetime('now')
        WHERE id = $1
          AND status = 'removed'
        RETURNING *`,
      [syncId]
    );
    if (rows[0]) return rows[0];
    const existing = await db.query("SELECT id, status FROM fulfillment_syncs WHERE id = $1", [syncId]);
    if (!existing.rows.length) return null;
    throw makeError("INVALID_STATUS", `Cannot restore from status "${existing.rows[0].status}".`);
  }

  async function markResolved(syncId, { note } = {}) {
    const db = dbAdapter(env);
    const { rows } = await db.query("SELECT * FROM fulfillment_syncs WHERE id = $1", [syncId]);
    if (!rows.length) return null;
    const sync = rows[0];
    if (!["needs_attention", "failed", "unmatched", "missing_address", "skipped"].includes(sync.status)) {
      throw makeError(
        "INVALID_STATUS",
        `Cannot mark resolved from status "${sync.status}".`
      );
    }
    await recordApplyEvent(db, syncId, {
      trigger: "manual",
      phase: "skipped",
      ok: true,
      errorCode: "ALREADY_APPLIED",
      message: note || "Marked resolved by operator",
    });
    return updateSyncById(db, syncId, {
      status: "skipped",
      review_note: note || sync.review_note,
      error: note ? `Resolved: ${note}` : sync.error,
    });
  }

  /**
   * Reverses `skipped` — a status `previewFulfillmentEvent` treats as terminal (see
   * TERMINAL_OR_IN_FLIGHT) and `canRetryPreview` on the frontend doesn't list, so a skipped
   * row has no path back to retryable today. Rows land here two ways: `supersedeUnmatchedSync`
   * auto-skips a stale unmatched/retryable-failed row once a fresh attempt for the same
   * Sutton order lands any outcome, and `markResolved` lets an operator skip one manually.
   * Either way, an operator who decides the row should be looked at again needs a way back —
   * flips it to `unmatched` (the correct starting point: nothing has re-matched it yet) with a
   * clean error slate, so the normal Retry flow re-runs preview from scratch on the next click.
   */
  async function unskipSync(syncId, { note } = {}) {
    const db = dbAdapter(env);
    const { rows } = await db.query("SELECT * FROM fulfillment_syncs WHERE id = $1", [syncId]);
    if (!rows.length) return null;
    const sync = rows[0];
    if (sync.status !== "skipped") {
      throw makeError("INVALID_STATUS", `Cannot unskip from status "${sync.status}" (only "skipped" rows can be unskipped).`);
    }
    return updateSyncById(db, syncId, {
      status: "unmatched",
      review_note: note || sync.review_note,
      error: null,
      error_code: null,
      error_detail: null,
    });
  }

  /**
   * Hard-deletes a `skipped` row from the queue outright, instead of the Unskip path (which
   * flips it back to `unmatched` so it can be retried). Only ever restricted to `skipped` —
   * every other status either represents real inventory work (`fulfilled`/`applying`/
   * `needs_attention`), an active row still worth retrying (`unmatched`/`missing_address`/
   * `failed`/`pending_approval`/`ready`), or an explicit terminal decision worth keeping
   * visible for audit (`rejected`). Cascades to `fulfillment_apply_events` (`ON DELETE
   * CASCADE`) — safe here too, since a `skipped` row never has anything applied against it.
   * The underlying `webhook_events` row is left alone (raw log entry, not shown in the queue).
   */
  async function deleteSync(syncId) {
    const db = dbAdapter(env);
    const { rows } = await db.query("SELECT * FROM fulfillment_syncs WHERE id = $1", [syncId]);
    if (!rows.length) return null;
    const sync = rows[0];
    if (sync.status !== "skipped") {
      throw makeError("INVALID_STATUS", `Cannot delete from status "${sync.status}" (only "skipped" rows can be deleted).`);
    }
    await db.query("DELETE FROM fulfillment_syncs WHERE id = $1", [syncId]);
    return { deleted: true, id: syncId };
  }

  async function rejectSync(syncId, { note } = {}) {
    const db = dbAdapter(env);
    const { rows } = await db.query("SELECT * FROM fulfillment_syncs WHERE id = $1", [syncId]);
    if (!rows.length) return null;
    return updateSyncById(db, syncId, {
      status: "rejected",
      review_note: note || null,
      error: null,
      error_code: null,
      error_detail: null,
    });
  }

  /**
   * "Mark errant / Un-deduct" — reverses the inventory already deducted for this sync by
   * issuing one compensating (positive) inventory adjustment per applied line, via the
   * auto-created/cached WOOCOMMERCE_ADJUSTMENT_REVERSAL_REASON. Inventory only: deliberately
   * never touches the Sutton order's own orderStatus, which stays `fulfilled` in Sutton even
   * after this runs — an operator decided this sync's *inventory* was wrong, not necessarily
   * that the Sutton order itself needs to be reopened, and guessing a status to restore it to
   * is out of scope here.
   *
   * Only valid from `fulfilled` or `needs_attention` (a partial apply can still have
   * reversible lines) and only when at least one applied line has an adjustmentId to reverse.
   * Requires a non-blank `note` — this is a deliberate, audited correction, not a quiet
   * toggle, the same way `markResolved`/`rejectSync` already record a note.
   *
   * Partial-failure safe, mirroring how `runApplyBody` resumes a partial apply via
   * `alreadyApplied`: lines already reversed (tracked in `reversed_items`, keyed by
   * `lineKey`) are skipped on a retry, so a reversal that fails partway through can simply be
   * re-run to finish the remaining lines instead of risking a double reversal.
   */
  async function reverseSync(syncId, { note, approvedBy } = {}) {
    const trimmedNote = String(note || "").trim();
    if (!trimmedNote) {
      throw makeError(
        "INVALID_STATUS",
        "A note is required to mark a sync errant and un-deduct its inventory."
      );
    }

    const db = dbAdapter(env);
    const { rows } = await db.query("SELECT * FROM fulfillment_syncs WHERE id = $1", [syncId]);
    const sync = rows[0];
    if (!sync) return null;

    if (!["fulfilled", "needs_attention"].includes(sync.status)) {
      throw makeError(
        "INVALID_STATUS",
        `Cannot un-deduct a sync in status "${sync.status}" — only "fulfilled" or "needs_attention" syncs with applied inventory can be reversed.`
      );
    }

    const appliedItems = sync.applied_items || [];
    const appliedWithAdjustment = appliedItems.filter((line) => line.adjustmentId);
    if (!appliedWithAdjustment.length) {
      throw makeError("INVALID_STATUS", "This sync has no applied inventory lines to reverse.");
    }

    const alreadyReversed = appliedMap(sync.reversed_items);
    const toReverse = appliedWithAdjustment.filter((line) => !alreadyReversed.has(effectiveLineKey(line)));
    if (!toReverse.length) {
      throw makeError("ALREADY_APPLIED", "Every applied line on this sync has already been reversed.");
    }

    // Stock goes back to the bin each line came from, even if the default bin changed since.
    // Older lines did not record one and came from the configured bin.
    const legacyWarehouseId = toReverse.every((line) => line.warehouseLocationId)
      ? null
      : (await requireWarehouseLocation()).id;

    let reversalReasonTermId;
    try {
      const settings = await getAutoDeductSettingsRow(db);
      reversalReasonTermId = await findOrCreateAdjustmentReasonTermId(env, {
        value: WOOCOMMERCE_ADJUSTMENT_REVERSAL_REASON,
        cachedId: settings?.reversal_adjustment_reason_id || null,
        onResolved: (id) => updateAutoDeductSettingsRow(db, { reversal_adjustment_reason_id: id }),
      });
    } catch (err) {
      throw makeError(err.code || "SUTTON_API", err.message);
    }

    const reversedItems = [...(sync.reversed_items || [])];
    let lastError = null;

    for (const line of toReverse) {
      try {
        const result = await reverseInventoryAdjustment(env, {
          itemId: line.itemId,
          warehouseLocationId: line.warehouseLocationId || legacyWarehouseId,
          quantity: line.quantity,
          adjustmentReasonTermId: reversalReasonTermId,
          notes: `Reversal of WooCommerce fulfillment sync #${sync.id}, order #${sync.order_number} — original adjustment ${
            line.documentNumber || line.adjustmentId
          }`,
        });
        const reversedLine = {
          lineKey: effectiveLineKey(line),
          itemId: line.itemId,
          itemName: line.itemName,
          quantity: line.quantity,
          kitItemId: line.kitItemId || null,
          kitItemName: line.kitItemName || null,
          kitSku: line.kitSku || null,
          kitLineQuantity: line.kitLineQuantity || null,
          originalAdjustmentId: line.adjustmentId || null,
          originalDocumentNumber: line.documentNumber || null,
          adjustmentId: result?.id || null,
          documentNumber: result?.documentNumber || null,
        };
        reversedItems.push(reversedLine);

        // Persist immediately, same as runApplyBody's deduct loop, so a later failure in this
        // same loop never loses a reversal id that already succeeded.
        await updateSyncById(db, syncId, { reversed_items: reversedItems });
        await recordApplyEvent(db, syncId, {
          trigger: "manual",
          phase: "reverse_line",
          itemId: line.itemId,
          quantity: line.quantity,
          adjustmentId: reversedLine.adjustmentId,
          documentNumber: reversedLine.documentNumber,
          ok: true,
          message: `Reversed ${line.itemName} x${line.quantity} (original adjustment ${
            line.documentNumber || line.adjustmentId
          })`,
        });
      } catch (err) {
        lastError = err;
        await recordApplyEvent(db, syncId, {
          trigger: "manual",
          phase: "reverse_line",
          itemId: line.itemId,
          quantity: line.quantity,
          ok: false,
          errorCode: err.code || "SUTTON_API",
          message: `Failed to reverse ${line.itemName} x${line.quantity}: ${err.message}`,
        });
        break; // Stop at the first failure — whatever already succeeded is already persisted above.
      }
    }

    if (lastError) {
      const message = humanError(
        lastError.code || "SUTTON_API",
        `Un-deduct partially completed (${reversedItems.length} of ${appliedWithAdjustment.length} line(s) reversed), then failed: ${lastError.message}. Retry "Un-deduct" to reverse the remaining line(s) — it skips what's already reversed.`
      );
      await updateSyncById(db, syncId, {
        error: message,
        error_code: lastError.code || "SUTTON_API",
      });
      throw makeRawError(lastError.code || "SUTTON_API", message, lastError.detail || null);
    }

    await recordApplyEvent(db, syncId, {
      trigger: "manual",
      phase: "reverse_complete",
      ok: true,
      message: `Marked errant and un-deducted: ${trimmedNote}`,
    });

    return updateSyncById(db, syncId, {
      status: "reversed",
      review_note: trimmedNote,
      error: null,
      error_code: null,
      error_detail: null,
      reversed_items: reversedItems,
      reversed_at: new Date(),
      reversed_by: approvedBy || null,
    });
  }

  /**
   * Deduct a reversed order again. Only the expanded-row action calls this.
   * The previous deduction cycle is cleared so apply does not treat those lines
   * as already deducted. Apply events keep the reversal history.
   */
  async function rerunReversedSync(syncId, { approvedBy } = {}) {
    const db = dbAdapter(env);
    const { rows } = await db.query("SELECT * FROM fulfillment_syncs WHERE id = $1", [syncId]);
    const sync = rows[0];
    if (!sync) return null;
    if (sync.status !== "reversed") {
      throw makeError(
        "INVALID_STATUS",
        `Only a reversed order can be rerun. This order is "${sync.status}".`
      );
    }

    const applied = sync.applied_items || [];
    const withAdjustment = applied.filter((line) => line.adjustmentId);
    if (!withAdjustment.length) {
      throw makeError("INVALID_STATUS", "This reversed order has no recorded deductions to run again.");
    }
    const reversed = appliedMap(sync.reversed_items);
    const unfinished = withAdjustment.filter((line) => !reversed.has(effectiveLineKey(line)));
    if (unfinished.length) {
      throw makeError(
        "PARTIAL_APPLY",
        `Un-deduct is not finished (${unfinished.length} line(s) still deducted). Finish Undo deduction before rerunning.`
      );
    }
    if (!sync.wc_completed_at) {
      throw makeError(
        "AWAITING_COMPLETION",
        `WooCommerce has not marked order #${sync.order_number || sync.wc_order_id || syncId} completed yet, so inventory cannot be deducted again.`
      );
    }

    const { rows: claimedRows } = await db.query(
      `UPDATE fulfillment_syncs
          SET status = 'applying',
              applied_items = '[]',
              reversed_items = '[]',
              order_status_applied = 0,
              error = NULL,
              error_code = NULL,
              error_detail = NULL,
              updated_at = now()
        WHERE id = $1 AND status = 'reversed'
        RETURNING *`,
      [syncId]
    );
    const claimed = claimedRows[0];
    if (!claimed) {
      throw makeError("IN_PROGRESS", "This order is already being rerun.");
    }

    await recordApplyEvent(db, syncId, {
      trigger: "manual",
      phase: "rerun",
      ok: true,
      message: "Rerun after reversal — deducting inventory again",
    });

    return runApplyBody(claimed, {
      trigger: "manual",
      dryRun: false,
      approvedBy,
      rerunReversed: true,
      logBase: {
        syncId,
        wcOrderId: claimed.wc_order_id,
        orderNumber: claimed.order_number,
        suttonSoId: claimed.digit_so_id,
        warehouseLocation: claimed.warehouse_location,
        trigger: "manual",
      },
    });
  }

  async function retrySync(syncId) {
    const db = dbAdapter(env);
    const { rows: syncRows } = await db.query("SELECT * FROM fulfillment_syncs WHERE id = $1", [syncId]);
    let sync = syncRows[0];
    if (!sync) return null;

    // Retry on a `skipped` row is a single action, not Unskip-then-find-the-row-again-then-
    // Retry: clear the skip here so the preview below runs fresh (pulls current Sutton data,
    // re-matches) in one click, exactly like clicking Retry on any other retryable row.
    if (sync.status === "skipped") {
      sync = await updateSyncById(db, syncId, {
        status: "unmatched",
        error: null,
        error_code: null,
        error_detail: null,
      });
    }

    if (TERMINAL_OR_IN_FLIGHT.has(sync.status)) {
      // Explicit retry on needs_attention should re-preview only after clearing
      // protection — force by moving back to failed so upsert can run.
      if (sync.status === "needs_attention") {
        throw makeError(
          "PARTIAL_APPLY",
          "This sync has a partial apply. Use Resume (remaining lines) or Retry order status — do not re-run preview, which would risk losing applied_items context."
        );
      }
      if (sync.status === "fulfilled" || sync.status === "applying") {
        throw makeError("ALREADY_APPLIED", `Cannot retry preview for a sync in status "${sync.status}".`);
      }
      if (sync.status === "reversed") {
        throw makeError(
          "ALREADY_APPLIED",
          "This sync was marked errant and its inventory was already un-deducted. There is no un-reverse — create a fresh order in Sutton if it needs to be fulfilled again."
        );
      }
    }

    const { rows: eventRows } = await db.query("SELECT * FROM webhook_events WHERE id = $1", [
      sync.webhook_event_id,
    ]);
    let webhookEvent = eventRows[0];
    if (!webhookEvent) return null;

    // Once the row knows which Sutton order it belongs to (digit_so_id), refetch that order
    // so the re-preview reflects Sutton's current status and address. The stored WooCommerce
    // payload (id, number, dates, line items, meta) is kept as-is; only `sutton_status` and
    // the shipping country are refreshed. Falls back to the stored snapshot (and matching by
    // external number) if the order can't be refetched.
    let freshOrder = null;
    if (sync.digit_so_id) {
      try {
        freshOrder = await findOrderById(env, sync.digit_so_id);
        if (freshOrder) {
          const stored = webhookEvent.payload && typeof webhookEvent.payload === "object" ? webhookEvent.payload : {};
          const payload = {
            ...stored,
            id: stored.id ?? sync.wc_order_id,
            number: stored.number ?? sync.order_number,
            date_created: stored.date_created || freshOrder.createdAt || null,
            sutton_status: freshOrder.orderStatus || null,
            shipping: {
              ...(stored.shipping || {}),
              country: freshOrder.shippingAddress?.country || stored.shipping?.country || null,
            },
          };
          const { rows: updatedEventRows } = await db.query(
            `UPDATE webhook_events SET payload = $1, order_status = $2 WHERE id = $3 RETURNING *`,
            [payload, payload.status, webhookEvent.id]
          );
          webhookEvent = updatedEventRows[0] || webhookEvent;
        } else {
          logFulfillment({
            phase: "retry_refresh_order_not_found",
            syncId,
            suttonSoId: sync.digit_so_id,
          });
        }
      } catch (err) {
        logFulfillment({
          phase: "retry_refresh_failed",
          syncId,
          suttonSoId: sync.digit_so_id,
          error: err.message,
        });
        // Fall through and retry against the existing stored snapshot rather than failing
        // the whole retry over a refresh-step error.
      }
    }

    // Pass the order we just fetched straight through so previewFulfillmentEvent doesn't
    // re-fetch the identical order a second time via findOrderByExternalNumbers (see comment
    // there) — one fewer Sutton round trip per retried row. Auto-apply follows the same
    // Configuration toggle as the scheduled poll.
    const autoDeductSettings = await getAutoDeductSettingsRow(db);
    return previewFulfillmentEvent(webhookEvent, {
      knownOrder: freshOrder,
      triggerAutoApply: Boolean(autoDeductSettings?.auto_deduct_enabled),
    });
  }

  async function listApplyEvents(syncId) {
    const db = dbAdapter(env);
    const { rows } = await db.query(
      `SELECT * FROM fulfillment_apply_events WHERE sync_id = $1 ORDER BY created_at ASC, id ASC`,
      [syncId]
    );
    return rows;
  }

  /**
   * Every apply-event across every order, newest-or-oldest first, each row carrying enough
   * of its parent sync (order numbers, location, current status) to be meaningful on its own
   * — unlike the per-order log above, this isn't scoped to a single sync, so the UI can't
   * rely on already knowing which order a row belongs to.
   */
  async function listActivityLog({ limit = 50, offset = 0, dir = "desc" } = {}) {
    const db = dbAdapter(env);
    const dirSql = dir === "asc" ? "ASC" : "DESC";
    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const safeOffset = Math.max(Number(offset) || 0, 0);
    const { rows } = await db.query(
      `SELECT
         e.id, e.sync_id, e.trigger, e.phase, e.item_id, e.quantity, e.adjustment_id,
         e.document_number, e.stock_before, e.ok, e.error_code, e.message, e.created_at,
         s.wc_order_id, s.order_number, s.digit_order_number, s.digit_so_id,
         s.warehouse_location, s.status AS sync_status
       FROM fulfillment_apply_events e
       JOIN fulfillment_syncs s ON s.id = e.sync_id
       ORDER BY e.created_at ${dirSql}, e.id ${dirSql}
       LIMIT $1 OFFSET $2`,
      [safeLimit + 1, safeOffset]
    );
    const hasMore = rows.length > safeLimit;
    const nodes = hasMore ? rows.slice(0, safeLimit) : rows;
    return { nodes, pageInfo: { hasMore, limit: safeLimit } };
  }

  /**
   * ISO cutoff for the log, or null when every sync should be listed: FULFILLMENT_LOG_SINCE,
   * else the date the WooCommerce poll started reading from.
   */
  async function getLogSince() {
    if (LOG_SINCE) return { since: LOG_SINCE, source: "env" };
    const settings = await getAutoDeductSettingsRow(dbAdapter(env));
    return settings?.wc_poll_start ? { since: settings.wc_poll_start, source: "poll_start" } : { since: null, source: null };
  }

  /** Saves the Configuration-tab warehouse. The id must be a live Sutton location. */
  async function setWarehouseLocation(warehouseLocationId) {
    const id = String(warehouseLocationId || "").trim();
    if (!id) {
      throw makeRawError("CONFIG_MISSING", "Choose a warehouse location.");
    }
    const location = await findWarehouseLocationById(env, id);
    if (!location) {
      throw makeRawError(
        "LOCATION_UNRESOLVED",
        "That warehouse location was not found in Sutton. Choose another."
      );
    }
    await updateAutoDeductSettingsRow(dbAdapter(env), { warehouse_location_id: location.id });
    warehouseLocationPromise = null;
    return getFulfillmentConfig();
  }

  async function getFulfillmentConfig() {
    const db = dbAdapter(env);
    const settings = await getAutoDeductSettingsRow(db);
    const resolvedWarehouse = await resolveConfiguredWarehouse();
    const settle = (promise) =>
      promise.then(
        (value) => ({ value, error: null }),
        (err) => ({ value: null, error: err.message })
      );
    const [reason, kit, location] = await Promise.all([
      settle(
        adjustmentReasonStatus(env, {
          cachedId: settings?.adjustment_reason_id || null,
        })
      ),
      settle(resolveAndCacheKitTypeIds(db)),
      settle(getWarehouseLocation()),
    ]);
    const logSince = LOG_SINCE || settings?.wc_poll_start || null;
    return {
      autoApply: Boolean(settings?.auto_deduct_enabled),
      logSince,
      logSinceSource: LOG_SINCE ? "env" : logSince ? "poll_start" : null,
      warehouseLocationKey: PRIMARY_LOCATION_KEY,
      warehouseLocationId: resolvedWarehouse.id || null,
      warehouseLocationSource: resolvedWarehouse.source,
      warehouseLocationCode: location.value?.locationCode || null,
      warehouseLocationConfigured: Boolean(location.value),
      warehouseLocationError: location.error,
      adjustmentReasonValue: WOOCOMMERCE_ADJUSTMENT_REASON,
      adjustmentReasonTermId: reason.value?.id || null,
      // Null when the lookup itself failed (e.g. no API token yet) — unknown, not "missing".
      adjustmentReasonConfigured: reason.error ? null : Boolean(reason.value?.configured),
      kitTypeFieldName: KIT_TYPE_FIELD_NAME,
      virtualKitOptionValue: VIRTUAL_KIT_OPTION_VALUE,
      kitTypeFieldConfigured: kit.error ? null : Boolean(kit.value),
      kitTypeFieldId: kit.value?.fieldId || null,
      virtualKitOptionId: kit.value?.optionId || null,
      wooCommerceConfigured: isWooCommerceConfigured(env),
      // date_modified_gmt of the last completed WooCommerce order the poll handled. Null
      // until the first tick finishes.
      wcPollCursor: settings?.wc_poll_cursor || null,
      wcPollMaxPages: WC_POLL_MAX_PAGES,
    };
  }

  // Statuses recordPollCandidateError is safe to overwrite. Never clobber a row that
  // reflects real progress (matched, applying, fulfilled, awaiting manual review, etc.).
  const RECONCILE_ERROR_OVERWRITABLE = new Set(["unmatched", "failed", "missing_address", "awaiting_completion"]);

  // Error codes worth retrying automatically on a later tick rather than waiting for an
  // operator to click Retry. These are transient failures with nothing for a human to fix
  // first (unlike ALIAS_UNRESOLVED or KIT_BOM_MISSING, which need a data fix).
  const RECONCILE_AUTO_RETRY_ERROR_CODES = new Set(["SUTTON_API"]);

  // How many already-polled `unmatched` / transient-`failed` rows one tick re-previews, after
  // new orders have had first claim on the per-tick budget. The cursor has moved past those
  // orders, so this sweep is the only automatic retry they get (e.g. Rutter had not created
  // the Sutton order yet when the WooCommerce order was first polled).
  const POLL_RETRY_SWEEP_MAX = 10;

  // How many stock-shortage rows one tick re-checks. Each check reads stock for that order's
  // remaining lines.
  const RESTOCK_SWEEP_MAX = 20;

  /** True when an existing sync should be retried automatically (an `unmatched` row, or a
   * `failed` row whose error is transient) rather than treated as already handled. */
  function isAutoRetryCandidate(existing) {
    if (!existing) return true;
    if (existing.status === "unmatched") return true;
    return existing.status === "failed" && RECONCILE_AUTO_RETRY_ERROR_CODES.has(existing.error_code);
  }

  function wooOrderFields(wcOrder) {
    const wcOrderId = wcOrder?.id != null && /^\d+$/.test(String(wcOrder.id)) ? Number(wcOrder.id) : null;
    const orderNumber =
      wcOrder?.number != null && wcOrder.number !== ""
        ? String(wcOrder.number)
        : wcOrderId != null
          ? String(wcOrderId)
          : null;
    return { wcOrderId, orderNumber };
  }

  async function insertPollEvent(db, wcOrder, { topic = "order.woocommerce_poll", headers = {} } = {}) {
    const { wcOrderId, orderNumber } = wooOrderFields(wcOrder);
    const { rows } = await db.query(
      `INSERT INTO webhook_events
         (source, topic, wc_order_id, order_number, order_status, signature_valid, headers, payload)
       VALUES ('woocommerce_poll', $1, $2, $3, $4, NULL, $5, $6)
       RETURNING *`,
      [topic, wcOrderId, orderNumber, wcOrder?.status || null, { topic, source: "woocommerce_poll", ...headers }, wcOrder]
    );
    return rows[0];
  }

  /**
   * Persists (or refreshes) a `failed` row for a polled WooCommerce order whose attempt threw
   * before `previewFulfillmentEvent` could record its own failure (e.g. a D1 write error).
   * Without this, the order's only trace would be a count in the job-run summary, and the
   * cursor has already moved past it. The row stores the real WooCommerce payload, so Retry
   * re-previews it like any other row.
   */
  async function recordPollCandidateError(db, wcOrder, err, existingRows) {
    const { wcOrderId, orderNumber } = wooOrderFields(wcOrder);
    const errorCode = err.code || "SUTTON_API";
    const message = humanError(
      errorCode,
      `The WooCommerce poll could not process this order: ${err.message}. Use Retry, or wait for a later scheduled tick.`
    );

    const existing = existingRows?.[0] || null;
    if (existing) {
      if (!RECONCILE_ERROR_OVERWRITABLE.has(existing.status)) return existing;
      return updateSyncById(db, existing.id, { status: "failed", error: message, error_code: errorCode });
    }

    const event = await insertPollEvent(db, wcOrder, {
      topic: "order.woocommerce_poll_error",
      headers: { pollError: err.message },
    });
    return upsertSyncRow(db, {
      webhookEventId: event.id,
      wcOrderId,
      orderNumber,
      orderReceivedDate: orderReceivedDateFromPayload(wcOrder),
      matchedExternalNumbers: candidateExternalOrderNumbers(wcOrder, { wcOrderId, orderNumber }),
      status: "failed",
      errorCode,
      error: message,
      wcCompletedAt: new Date().toISOString(),
    });
  }

  /** A row for this order that the WooCommerce poll has not seen completed yet, and that a
   * completion can still move forward. */
  function rowAwaitingCompletion(existingRows) {
    return (
      existingRows.find(
        (row) => !row.wc_completed_at && !TERMINAL_OR_IN_FLIGHT.has(row.status) && row.status !== "rejected"
      ) || null
    );
  }

  /** The WooCommerce poll saw this order completed: point the row's event at the completed
   * WooCommerce payload and re-preview it, which queues it for Approve or auto-applies it. */
  async function promoteCompletedOrder(db, row, wcOrder, { triggerAutoApply }) {
    const { wcOrderId, orderNumber } = wooOrderFields(wcOrder);
    const { rows: eventRows } = await db.query(
      `UPDATE webhook_events
          SET source = 'woocommerce_poll', topic = 'order.woocommerce_poll', wc_order_id = $1,
              order_number = $2, order_status = $3, payload = $4
        WHERE id = $5
        RETURNING *`,
      [wcOrderId, orderNumber, wcOrder?.status || null, wcOrder, row.webhook_event_id]
    );
    await updateSyncById(db, row.id, { wc_completed_at: new Date().toISOString(), wc_order_id: wcOrderId ?? row.wc_order_id });
    if (!eventRows[0]) return null;
    return previewFulfillmentEvent(eventRows[0], { triggerAutoApply });
  }

  // Bounds the Sutton status lookups for rows whose Sutton order left the open list.
  const CLOSED_CHECK_MAX = 100;

  /**
   * Adds an Awaiting completion row for every open, Rutter-linked Sutton order not yet in the
   * log (newest work first, within `budget`), and marks Awaiting completion rows Skipped once
   * their Sutton order is fulfilled, cancelled, or deleted in Sutton.
   */
  async function syncOpenSuttonOrders(db, { budget, pollStart, pace, handledSyncIds }) {
    const result = { open: 0, added: 0, closed: 0, deferred: 0, budgetUsed: 0 };
    const rutterConnectionId = await resolveWooCommerceRutterConnectionId(env);
    const openOrders = await listOpenRutterOrders(env, { rutterConnectionId });
    result.open = openOrders.length;
    const startMs = pollStart ? Date.parse(pollStart) : null;

    const openIds = openOrders.map((o) => o.id);
    const externalNumbers = [
      ...new Set(openOrders.map((o) => o.externalOrder?.orderNumber).filter((v) => v != null && v !== "").map(String)),
    ];
    const tracked = new Set();
    const collect = async (column, values, keyOf) => {
      for (let i = 0; i < values.length; i += D1_IN_CHUNK) {
        const { rows } = await db.query(`SELECT digit_so_id, order_number FROM fulfillment_syncs WHERE ${column} = ANY($1::text[])`, [
          values.slice(i, i + D1_IN_CHUNK),
        ]);
        for (const row of rows) tracked.add(keyOf(row));
      }
    };
    await collect("digit_so_id", openIds, (row) => `so:${row.digit_so_id}`);
    await collect("order_number", externalNumbers, (row) => `wc:${row.order_number}`);

    for (const order of openOrders) {
      const externalNumber = order.externalOrder?.orderNumber;
      if (externalNumber == null || externalNumber === "") continue;
      if (tracked.has(`so:${order.id}`) || tracked.has(`wc:${externalNumber}`)) continue;
      if (startMs != null && order.createdAt && Date.parse(order.createdAt) < startMs) continue;
      if (result.budgetUsed >= budget) {
        result.deferred += 1;
        continue;
      }
      result.budgetUsed += 1;
      await pace();

      const wcOrderId = /^\d+$/.test(String(externalNumber)) ? Number(externalNumber) : null;
      const payload = {
        id: wcOrderId,
        number: String(externalNumber),
        status: order.orderStatus || null,
        date_created: order.createdAt || null,
        shipping: { country: order.shippingAddress?.country || null },
      };
      const { rows: eventRows } = await db.query(
        `INSERT INTO webhook_events
           (source, topic, wc_order_id, order_number, order_status, signature_valid, headers, payload)
         VALUES ('sutton_poll', 'order.sutton_poll', $1, $2, $3, NULL, $4, $5)
         RETURNING *`,
        [wcOrderId, payload.number, payload.status, { topic: "order.sutton_poll", source: SUTTON_ORDER_SOURCE }, payload]
      );
      const fullOrder = await findOrderById(env, order.id);
      const sync = await previewFulfillmentEvent(eventRows[0], { knownOrder: fullOrder });
      if (sync?.id) handledSyncIds.add(sync.id);
      result.added += 1;
    }

    const openSet = new Set(openIds);
    const { rows: waitingRows } = await db.query(
      `SELECT id, digit_so_id FROM fulfillment_syncs
        WHERE status = 'awaiting_completion' AND wc_completed_at IS NULL AND digit_so_id IS NOT NULL
        ORDER BY updated_at ASC`
    );
    const leftOpenList = waitingRows.filter((row) => !openSet.has(row.digit_so_id) && !handledSyncIds.has(row.id)).slice(0, CLOSED_CHECK_MAX);
    if (leftOpenList.length) {
      const statuses = await findOrderStatusesByIds(env, [...new Set(leftOpenList.map((row) => row.digit_so_id))]);
      const byId = new Map(statuses.map((o) => [o.id, o]));
      for (const row of leftOpenList) {
        const order = byId.get(row.digit_so_id) || null;
        if (order && OPEN_ORDER_STATUSES.includes(order.orderStatus)) continue;
        await updateSyncById(db, row.id, {
          status: "skipped",
          error_code: "SUTTON_ORDER_CLOSED",
          error: suttonOrderClosedMessage(order),
        });
        handledSyncIds.add(row.id);
        result.closed += 1;
      }
    }
    return result;
  }

  /** Where the poll starts when no cursor is saved yet. */
  function initialPollCursor() {
    if (LOG_SINCE) return LOG_SINCE;
    return new Date(Date.now() - WC_POLL_INITIAL_LOOKBACK_HOURS * 3600 * 1000).toISOString();
  }

  /** `modified_after` value: ISO without milliseconds or zone (dates_are_gmt=true). */
  function wcRequestDate(date) {
    return date.toISOString().slice(0, 19);
  }

  /**
   * Scheduled poll of `GET /wp-json/wc/v3/orders?status=completed`, oldest-modified first,
   * starting just before `fulfillment_settings.wc_poll_cursor`. Each completed order not yet
   * tracked is stored as a `webhook_events` row (full WooCommerce payload) and previewed: it
   * is matched to its Rutter-created Sutton order, then lands at `pending_approval` (or
   * auto-applies when automated deductions are on).
   *
   * Limits per tick: at most WC_POLL_MAX_PAGES pages of 100 orders, and at most
   * RECONCILE_MAX_PER_RUN orders previewed. The cursor only advances past orders this tick
   * fully handled, and is saved even when the run throws, so the next tick resumes exactly
   * where this one stopped.
   */
  async function reconcileFromWooCommerce({ trigger = "schedule" } = {}) {
    if (!isWooCommerceConfigured(env)) {
      throw makeError(
        "CONFIG_MISSING",
        "WooCommerce REST is not configured. Set WC_STORE_URL, WC_CONSUMER_KEY, and WC_CONSUMER_SECRET in Settings in Sutton Studio."
      );
    }
    if (reconcileInFlight) {
      throw makeError("IN_PROGRESS", "A WooCommerce poll is already in progress.");
    }

    reconcileInFlight = true;
    const db = dbAdapter(env);
    const summary = {
      trigger,
      // Orders this tick handled: previewed, retried, or already tracked.
      scanned: 0,
      queued: 0,
      unmatched: 0,
      // Matched Sutton order was already fulfilled; parked at `skipped`, nothing deducted.
      alreadyFulfilled: 0,
      // Existing unmatched / transient-failed rows re-previewed this tick.
      retried: 0,
      skippedExisting: 0,
      // Awaiting completion rows the WooCommerce poll saw completed this tick.
      completed: 0,
      // Sutton step: open Rutter orders, Awaiting completion rows added, rows whose Sutton
      // order closed first, and open orders left for a later tick by the budget.
      suttonOpen: 0,
      awaitingAdded: 0,
      suttonClosed: 0,
      suttonDeferred: 0,
      // Completed orders left for a later tick because this run hit the order budget or the
      // page limit. Never dropped: the cursor stays before them.
      deferred: 0,
      pagesFetched: 0,
      pageLimitReached: false,
      deduped: 0,
      autoDeducted: 0,
      autoDeductDisabledThisRun: false,
      // Pending approval rows deducted this tick, and eligible rows left for a later tick.
      pendingDeducted: 0,
      pendingDeferred: 0,
      // Stock-shortage rows deducted once restocked (auto-deduct on), newly flagged ready for
      // Retry apply (auto-deduct off), and rows checked that are still short.
      restockDeducted: 0,
      restockReady: 0,
      restockStillShort: 0,
      cursorBefore: null,
      cursorAfter: null,
      errors: [],
      startedAt: new Date().toISOString(),
      finishedAt: null,
    };

    let cursor = null;
    let cursorDirty = false;
    const advanceCursor = (modified) => {
      if (modified && (!cursor || modified > cursor)) {
        cursor = modified;
        cursorDirty = true;
      }
    };

    try {
      // Self-heal first, before the tracking checks below read `fulfillment_syncs`.
      summary.deduped =
        (await dedupeDigitSoIdCollisions(db)) + (await deleteSkippedDuplicates(db));

      // Kept current via recordAutoDeductOutcome's return value, so a mid-run breaker trip
      // drops every remaining order in this same tick back to pending_approval.
      let autoDeductSettings = await getAutoDeductSettingsRow(db);
      summary.cursorBefore = autoDeductSettings?.wc_poll_cursor || null;
      cursor = summary.cursorBefore || initialPollCursor();
      cursorDirty = !summary.cursorBefore;

      // The start date is what the fulfillment log cuts off at. Changing FULFILLMENT_LOG_SINCE
      // moves it, and the poll re-reads from there. A cursor saved before this column existed
      // stands in as the start.
      const savedStart = autoDeductSettings?.wc_poll_start || null;
      const pollStart = LOG_SINCE || savedStart || summary.cursorBefore || cursor;
      if (pollStart !== savedStart) {
        if (savedStart) {
          cursor = pollStart;
          cursorDirty = true;
        }
        autoDeductSettings = (await updateAutoDeductSettingsRow(db, { wc_poll_start: pollStart })) || autoDeductSettings;
      }
      summary.pollStart = pollStart;

      let budget = RECONCILE_MAX_PER_RUN;
      let paced = 0;
      const pace = async () => {
        if (paced > 0 && RECONCILE_PACING_MS > 0) await sleep(RECONCILE_PACING_MS);
        paced += 1;
      };
      const handledSyncIds = new Set();

      const tally = async (sync, autoDeductActive) => {
        if (!sync) return;
        handledSyncIds.add(sync.id);
        if (sync.status === "unmatched") {
          summary.unmatched += 1;
          return;
        }
        if (sync.status === "awaiting_completion") return;
        if (sync.status === "skipped" && sync.error_code === "SUTTON_ORDER_CLOSED") {
          summary.suttonClosed += 1;
          return;
        }
        if (sync.status === "skipped" && sync.error_code === "ALREADY_FULFILLED_IN_SUTTON") {
          summary.alreadyFulfilled += 1;
          return;
        }
        summary.queued += 1;
        if (sync.digit_so_id) {
          await supersedeUnmatchedSync(db, { suttonSoId: sync.digit_so_id, excludeSyncId: sync.id });
        }
        // Only matched orders count toward the breaker. An order Rutter has not created in
        // Sutton yet says nothing about whether automation itself is healthy.
        if (autoDeductActive && sync.digit_so_id) {
          const ok = sync.status === "fulfilled";
          if (ok) summary.autoDeducted += 1;
          const updatedSettings = await recordAutoDeductOutcome(db, { ok, errorCode: sync.error_code });
          if (updatedSettings) {
            autoDeductSettings = updatedSettings;
            if (!updatedSettings.auto_deduct_enabled) summary.autoDeductDisabledThisRun = true;
          }
        }
      };

      // `cursor - 1s` so orders sharing the cursor's timestamp are never missed. The overlap
      // is absorbed by the tracking check (those orders are already tracked).
      const modifiedAfter = wcRequestDate(new Date(Date.parse(cursor) - 1000));
      let stopped = false;
      let totalMatching = null;

      for (let page = 1; page <= WC_POLL_MAX_PAGES && !stopped; page += 1) {
        const { orders, totalPages, total } = await listCompletedOrdersPage(env, { modifiedAfter, page });
        summary.pagesFetched = page;
        if (total != null) totalMatching = total;
        const trackedByOrder = await listSyncsTrackingWooOrders(db, orders);

        for (const wcOrder of orders) {
          const modified = parseWooDate(wcOrder.date_modified_gmt || wcOrder.date_modified);
          const existingRows = trackedByOrder.get(wcOrder) || [];
          const waiting = rowAwaitingCompletion(existingRows);
          if (waiting) {
            if (budget <= 0) {
              stopped = true;
              break;
            }
            budget -= 1;
            summary.scanned += 1;
            await pace();
            const autoDeductActive = Boolean(autoDeductSettings?.auto_deduct_enabled);
            try {
              const sync = await promoteCompletedOrder(db, waiting, wcOrder, { triggerAutoApply: autoDeductActive });
              summary.completed += 1;
              await tally(sync, autoDeductActive);
            } catch (err) {
              summary.errors.push({ wcOrderId: wcOrder.id ?? null, orderNumber: wcOrder.number ?? null, error: err.message, code: err.code || null });
              try {
                const row = await recordPollCandidateError(db, wcOrder, err, [waiting]);
                if (row?.id) handledSyncIds.add(row.id);
              } catch (recordErr) {
                logFulfillment({ phase: "woocommerce_poll_record_error_failed", wcOrderId: wcOrder.id ?? null, error: recordErr.message });
                stopped = true;
                break;
              }
            }
            advanceCursor(modified);
            continue;
          }

          // Orders at or before the saved cursor are the `cursor - 1s` overlap and were handled
          // by an earlier tick. Any retry they still need comes from the sweep below.
          const seenByEarlierTick =
            existingRows.length > 0 && summary.cursorBefore && modified && modified <= summary.cursorBefore;
          if (seenByEarlierTick || existingRows.some((existing) => !isAutoRetryCandidate(existing))) {
            summary.scanned += 1;
            summary.skippedExisting += 1;
            advanceCursor(modified);
            continue;
          }

          if (budget <= 0) {
            stopped = true;
            break;
          }
          budget -= 1;
          summary.scanned += 1;
          await pace();

          const autoDeductActive = Boolean(autoDeductSettings?.auto_deduct_enabled);
          try {
            let sync;
            if (existingRows.length) {
              // Every existing row is an auto-retry candidate here. Re-preview the newest one
              // rather than inserting a second row for the same WooCommerce order.
              sync = await retrySync(existingRows[0].id);
              summary.retried += 1;
            } else {
              const event = await insertPollEvent(db, wcOrder);
              sync = await previewFulfillmentEvent(event, { triggerAutoApply: autoDeductActive });
            }
            await tally(sync, autoDeductActive);
          } catch (err) {
            summary.errors.push({
              wcOrderId: wcOrder.id ?? null,
              orderNumber: wcOrder.number ?? null,
              error: err.message,
              code: err.code || null,
            });
            try {
              const row = await recordPollCandidateError(db, wcOrder, err, existingRows);
              if (row?.id) handledSyncIds.add(row.id);
            } catch (recordErr) {
              logFulfillment({
                phase: "woocommerce_poll_record_error_failed",
                wcOrderId: wcOrder.id ?? null,
                error: recordErr.message,
              });
              // Nothing persisted for this order: leave the cursor before it so the next tick
              // sees it again.
              stopped = true;
              break;
            }
          }
          advanceCursor(modified);
        }

        const lastPage =
          !orders.length || (totalPages != null ? page >= totalPages : orders.length < WC_PAGE_SIZE);
        if (lastPage) break;
        if (!stopped && page === WC_POLL_MAX_PAGES) summary.pageLimitReached = true;
      }

      if ((stopped || summary.pageLimitReached) && totalMatching != null) {
        summary.deferred = Math.max(totalMatching - summary.scanned, 0);
      }

      // After the WooCommerce step, so an order completed since the last tick is promoted
      // before its Sutton order (which Rutter may then close) is checked.
      try {
        const sutton = await syncOpenSuttonOrders(db, { budget, pollStart, pace, handledSyncIds });
        budget -= sutton.budgetUsed;
        summary.suttonOpen = sutton.open;
        summary.awaitingAdded = sutton.added;
        summary.suttonClosed += sutton.closed;
        summary.suttonDeferred = sutton.deferred;
      } catch (err) {
        summary.errors.push({ step: "sutton_open_orders", error: err.message, code: err.code || null });
      }

      // Re-preview already-polled rows that are waiting on an automatic retry, oldest first so
      // the sweep rotates through them across ticks.
      const sweepBudget = Math.min(budget, POLL_RETRY_SWEEP_MAX);
      if (sweepBudget > 0) {
        const retryCodes = [...RECONCILE_AUTO_RETRY_ERROR_CODES];
        // Rows hidden by the log cutoff are left alone, so the sweep never acts on a row the
        // operator can't see.
        const { rows: retryRows } = await db.query(
          `SELECT id FROM fulfillment_syncs
            WHERE (status = 'unmatched' OR (status = 'failed' AND error_code = ANY($1::text[])))
              AND ${syncSinceSql(3)}
            ORDER BY updated_at ASC
            LIMIT $2`,
          [retryCodes, sweepBudget + handledSyncIds.size, pollStart]
        );
        let swept = 0;
        for (const { id } of retryRows) {
          if (swept >= sweepBudget) break;
          if (handledSyncIds.has(id)) continue;
          swept += 1;
          await pace();
          const autoDeductActive = Boolean(autoDeductSettings?.auto_deduct_enabled);
          try {
            const sync = await retrySync(id);
            summary.retried += 1;
            await tally(sync, autoDeductActive);
          } catch (err) {
            summary.errors.push({ syncId: id, error: err.message, code: err.code || null });
          }
        }
      }

      // Counts toward the breaker only for matched orders. Shortages are excluded inside
      // recordAutoDeductOutcome.
      const recordAutoApply = async (sync) => {
        if (!sync?.digit_so_id) return;
        const ok = sync.status === "fulfilled";
        if (ok) summary.autoDeducted += 1;
        const updatedSettings = await recordAutoDeductOutcome(db, { ok, errorCode: sync.error_code });
        if (updatedSettings) {
          autoDeductSettings = updatedSettings;
          if (!updatedSettings.auto_deduct_enabled) summary.autoDeductDisabledThisRun = true;
        }
      };

      // Re-read the toggle. An operator may have turned it on after this tick started, and
      // the breaker may have turned it off while new orders were applied above.
      autoDeductSettings = (await getAutoDeductSettingsRow(db)) || autoDeductSettings;
      if (autoDeductSettings?.auto_deduct_enabled) {
        // Own budget, separate from the preview budget, so a full WooCommerce page does not
        // leave the backlog sitting at Pending approval. Oldest first. Apply never returns
        // a row to pending_approval, so a later tick continues with whatever is still waiting.
        const { rows: pendingRows } = await db.query(
          `SELECT id FROM fulfillment_syncs
            WHERE status = 'pending_approval'
              AND wc_completed_at IS NOT NULL
              AND ${syncSinceSql(1)}
            ORDER BY datetime(COALESCE(order_received_date, created_at)) ASC, id ASC`,
          [pollStart]
        );
        const batch = pendingRows.slice(0, RECONCILE_MAX_PER_RUN);
        summary.pendingDeferred = pendingRows.length - batch.length;
        for (const { id } of batch) {
          if (!autoDeductSettings?.auto_deduct_enabled) {
            summary.pendingDeferred += 1;
            continue;
          }
          await pace();
          try {
            const sync = await applyFulfillment(id, { trigger: "auto" });
            if (sync?.id) handledSyncIds.add(sync.id);
            if (sync?.status === "fulfilled") summary.pendingDeducted += 1;
            await recordAutoApply(sync);
          } catch (err) {
            summary.errors.push({ syncId: id, error: err.message, code: err.code || null });
          }
        }
      }

      // Restock sweep, on every poll: re-read stock for orders that stopped on a shortage.
      // Once every remaining line is covered, the order is deducted when automated deductions
      // are on, or flagged ready for Retry apply when they are off. A row whose state did not
      // change is not written, so a long-waiting order does not fill its activity log. Walks
      // rows by id from a saved cursor, wrapping, so every short row gets its turn.
      const restockCursor = Number(autoDeductSettings?.restock_sweep_cursor) || 0;
      const restockLimit = RESTOCK_SWEEP_MAX + handledSyncIds.size;
      const shortRowsAfter = async (afterId, throughId, limit) =>
        (
          await db.query(
            `SELECT * FROM fulfillment_syncs
              WHERE error_code = 'STOCK_SHORTAGE'
                AND status IN ('failed', 'needs_attention')
                AND wc_completed_at IS NOT NULL
                AND ${syncSinceSql(1)}
                AND id > $2 AND ($3 IS NULL OR id <= $3)
              ORDER BY id ASC
              LIMIT $4`,
            [pollStart, afterId, throughId, limit]
          )
        ).rows;
      const shortRows = await shortRowsAfter(restockCursor, null, restockLimit);
      if (shortRows.length < restockLimit && restockCursor > 0) {
        shortRows.push(...(await shortRowsAfter(0, restockCursor, restockLimit - shortRows.length)));
      }
      let restockChecked = 0;
      let restockLastId = null;
      for (const row of shortRows) {
        if (restockChecked >= RESTOCK_SWEEP_MAX) break;
        if (handledSyncIds.has(row.id)) continue;
        restockChecked += 1;
        restockLastId = row.id;
        await pace();
        try {
          const stock = await evaluatePendingStock(row);
          const wasReady = Boolean(row.error_detail?.stockReady);
          if (stock.shortGroups.length) {
            summary.restockStillShort += 1;
            if (wasReady) await persistStillShort(db, row, stock, { trigger: "poll", unchanged: false });
            continue;
          }
          if (autoDeductSettings?.auto_deduct_enabled) {
            const sync = await applyFulfillment(row.id, { trigger: "auto" });
            if (sync?.id) handledSyncIds.add(sync.id);
            if (sync?.status === "fulfilled") summary.restockDeducted += 1;
            await recordAutoApply(sync);
          } else if (!wasReady) {
            await persistStockReady(db, row, stock, { trigger: "poll" });
            summary.restockReady += 1;
          }
        } catch (err) {
          summary.errors.push({ syncId: row.id, error: err.message, code: err.code || null });
        }
      }
      if ((restockLastId || 0) !== restockCursor) {
        await updateAutoDeductSettingsRow(db, { restock_sweep_cursor: restockLastId });
      }

      summary.deduped += await consolidateDuplicateSyncs(db);
      summary.finishedAt = new Date().toISOString();
      logFulfillment({
        phase: "woocommerce_poll",
        trigger,
        scanned: summary.scanned,
        queued: summary.queued,
        unmatched: summary.unmatched,
        alreadyFulfilled: summary.alreadyFulfilled,
        retried: summary.retried,
        skippedExisting: summary.skippedExisting,
        completed: summary.completed,
        suttonOpen: summary.suttonOpen,
        awaitingAdded: summary.awaitingAdded,
        suttonClosed: summary.suttonClosed,
        suttonDeferred: summary.suttonDeferred,
        deferred: summary.deferred,
        pagesFetched: summary.pagesFetched,
        pageLimitReached: summary.pageLimitReached,
        deduped: summary.deduped,
        autoDeducted: summary.autoDeducted,
        autoDeductDisabledThisRun: summary.autoDeductDisabledThisRun,
        pendingDeducted: summary.pendingDeducted,
        pendingDeferred: summary.pendingDeferred,
        restockDeducted: summary.restockDeducted,
        restockReady: summary.restockReady,
        restockStillShort: summary.restockStillShort,
        errorCount: summary.errors.length,
      });
      return summary;
    } catch (err) {
      summary.finishedAt = new Date().toISOString();
      summary.errors.push({ error: err.message, code: err.code || null });
      throw err;
    } finally {
      if (cursorDirty && cursor) {
        try {
          await updateAutoDeductSettingsRow(db, { wc_poll_cursor: cursor });
        } catch (saveErr) {
          logFulfillment({ phase: "woocommerce_poll_cursor_save_failed", cursor, error: saveErr.message });
        }
      }
      summary.cursorAfter = cursor;
      reconcileInFlight = false;
    }
  }

  return {
    previewFulfillmentEvent,
    applyFulfillment,
    approveSync,
    resumeApply,
    recheckStock,
    retryOrderStatus,
    removeUnmatchedSync,
    restoreRemovedSync,
    markResolved,
    rejectSync,
    retrySync,
    unskipSync,
    deleteSync,
    listApplyEvents,
    listActivityLog,
    getLogSince,
    getFulfillmentConfig,
    setWarehouseLocation,
    reconcileFromWooCommerce,
    getAutoDeductStatus,
    setAutoDeduct,
    consolidateDuplicateSyncs: async () => {
      const db = dbAdapter(env);
      return consolidateDuplicateSyncs(db);
    },
    reverseSync,
    rerunReversedSync,
  };
}
