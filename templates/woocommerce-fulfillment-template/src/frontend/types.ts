export type FulfillmentConfig = {
  /** Mirrors the Configuration toggle. The scheduled poll and Retry deduct only while this is true. */
  autoApply: boolean;
  /** Log cutoff: FULFILLMENT_LOG_SINCE, else the date the WooCommerce poll started reading from. */
  logSince: string | null;
  logSinceSource: 'env' | 'poll_start' | null;
  /** Key stored on every sync's `warehouse_location` (one configured warehouse). */
  warehouseLocationKey: string;
  warehouseLocationId: string | null;
  /** `selection` is saved on the Configuration tab. `secret` is the WAREHOUSE_LOCATION_ID fallback. */
  warehouseLocationSource: 'selection' | 'secret' | null;
  /** Sutton `locationCode` of the configured warehouse, once resolved. */
  warehouseLocationCode: string | null;
  warehouseLocationConfigured: boolean;
  warehouseLocationError: string | null;
  /** Null when the lookup could not run (e.g. no API token yet). */
  adjustmentReasonConfigured: boolean | null;
  adjustmentReasonValue: string;
  adjustmentReasonTermId: string | null;
  /** Null when the lookup could not run. */
  kitTypeFieldConfigured: boolean | null;
  kitTypeFieldName: string;
  virtualKitOptionValue: string;
  kitTypeFieldId: string | null;
  virtualKitOptionId: string | null;
  /** WC_STORE_URL, WC_CONSUMER_KEY, and WC_CONSUMER_SECRET are all set — needed for the
   * "woocommerce-poll" schedule. */
  wooCommerceConfigured: boolean;
  /** `date_modified_gmt` (ISO) of the last completed WooCommerce order the poll handled.
   * Null until the first tick finishes. */
  wcPollCursor: string | null;
  /** Most WooCommerce pages (100 orders each) one tick fetches. */
  wcPollMaxPages: number;
};

/** One tick-schedule, as reported by the platform scheduler (`appJobs().schedules()`). */
export type SuttonSchedule = {
  name: string;
  everySeconds: number;
  /** Epoch ms of the next tick. */
  nextDueAt: number;
  running: boolean;
  /** Tripped after too many consecutive failures; fix the handler and republish to resume. */
  autoPaused: boolean;
  consecutiveFailures: number;
  lastRun: { startedAt: number; endedAt: number; ok: boolean; error?: string } | null;
};

export type ReconcileRunSummary = {
  trigger?: string;
  /** Completed WooCommerce orders this tick handled (previewed, retried, or already tracked). */
  scanned: number;
  queued: number;
  unmatched: number;
  /** Matched Sutton order was already fulfilled; parked at Skipped, nothing deducted. */
  alreadyFulfilled?: number;
  /** Existing Unmatched / transient Failed rows re-previewed this tick. */
  retried?: number;
  skippedExisting: number;
  /** Awaiting completion rows the WooCommerce poll saw completed this tick. */
  completed?: number;
  /** Sutton step: open Rutter-linked orders, Awaiting completion rows added, rows whose Sutton
   * order closed before WooCommerce completed it, and open orders left for a later tick. */
  suttonOpen?: number;
  awaitingAdded?: number;
  suttonClosed?: number;
  suttonDeferred?: number;
  /** Completed orders left for a later tick (order budget or page limit hit). Never dropped. */
  deferred: number;
  pagesFetched?: number;
  /** True when this tick stopped at the page limit; the next tick resumes from the cursor. */
  pageLimitReached?: boolean;
  cursorBefore?: string | null;
  cursorAfter?: string | null;
  /** Duplicate in-limbo rows for the same Sutton order found and skipped this tick. */
  deduped: number;
  /** How many candidates this run auto-applied (deducted + fulfilled) instead of parking at
   * pending_approval — only nonzero while the auto-deduct toggle is on. */
  autoDeducted: number;
  /** True if the auto-deduct circuit breaker tripped (or was already tripped) partway
   * through this run — any remaining candidates fell back to pending_approval. */
  autoDeductDisabledThisRun: boolean;
  /** Pending approval rows this tick deducted because automated deductions were on. */
  pendingDeducted?: number;
  /** Eligible pending approval rows left for a later tick (budget, or the breaker tripped). */
  pendingDeferred?: number;
  /** Stock-shortage rows deducted because every line was back in stock. */
  restockDeducted?: number;
  /** Stock-shortage rows newly flagged ready for Retry apply (automated deductions off). */
  restockReady?: number;
  /** Stock-shortage rows rechecked that are still short (left unchanged). */
  restockStillShort?: number;
  errors: {
    wcOrderId?: number | null;
    orderNumber?: string | null;
    syncId?: number;
    step?: string;
    error?: string;
    code?: string | null;
  }[];
  startedAt: string;
  finishedAt: string | null;
};

/** `GET /fulfillment/auto-deduct` — the Configuration toggle. It is the only auto-apply
 * control (scheduled poll and single-row Retry) and carries the circuit breaker's state.
 * `FulfillmentConfig.autoApply` mirrors `enabled` for the fulfillment-log subtitle. */
export type AutoDeductStatus = {
  enabled: boolean;
  consecutiveFailures: number;
  threshold: number;
  /** "Turned off by operator" (manual) vs. "Auto-disabled after N consecutive failures (...)"
   * (circuit breaker) — null while enabled or never yet disabled. */
  disabledReason: string | null;
  disabledAt: string | null;
};

/** One run of the "woocommerce-poll" job (schedule tick or manual "Run now" submit). */
export type SuttonJobRun = {
  runId: string;
  name: string;
  kind: 'job' | 'schedule';
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  result: ReconcileRunSummary | null;
  error: string | null;
};

/** `GET /fulfillment/reconcile` — read-only status for the scheduled WooCommerce poll. */
export type ReconcileStatus = {
  schedule: SuttonSchedule | null;
  recentRuns: SuttonJobRun[];
  config: FulfillmentConfig;
};

export type InventoryLine = {
  /** Unique per deduction row — distinguishes the same item deducted standalone vs. via a kit. */
  lineKey?: string;
  itemId: string;
  itemName: string;
  quantity: number;
  adjustmentId?: string | null;
  documentNumber?: string | null;
  /** Present when this line is a kit's BOM component rather than a direct order line. */
  kitItemId?: string | null;
  kitItemName?: string | null;
  kitSku?: string | null;
  kitLineQuantity?: number | null;
  /** Present only on entries in `reversed_items` — the adjustment this reversal gave back. */
  originalAdjustmentId?: string | null;
  originalDocumentNumber?: string | null;
};

export type ApplyEvent = {
  id: number;
  sync_id: number;
  trigger: string;
  phase: string;
  item_id: string | null;
  quantity: number | null;
  adjustment_id: string | null;
  document_number: string | null;
  ok: boolean;
  error_code: string | null;
  message: string | null;
  created_at: string;
};

export type FulfillmentSync = {
  id: number;
  webhook_event_id: number | null;
  wc_order_id: number | null;
  /** When the WooCommerce poll saw the order completed. Null while Awaiting completion; the
   * row cannot deduct until it is set. */
  wc_completed_at: string | null;
  order_number: string | null;
  digit_so_id: string | null;
  digit_order_number: string | null;
  shipping_country: string | null;
  warehouse_location: string | null;
  status: string;
  error: string | null;
  error_code: string | null;
  error_detail: {
    shortages?: {
      lineKey?: string;
      itemId: string;
      itemName: string;
      need: number;
      have: number;
      kitItemId?: string | null;
      kitItemName?: string | null;
      kitSku?: string | null;
      kitLineQuantity?: number | null;
    }[];
    stockReady?: boolean;
  } | null;
  items_preview: InventoryLine[] | null;
  applied_items: InventoryLine[] | null;
  /** Compensating (positive) adjustments issued by "Mark errant / Un-deduct", one per
   * reversed applied line. Only present once `status === 'reversed'` (or partially populated
   * if a reversal attempt failed partway through and was never retried to completion). */
  reversed_items: InventoryLine[] | null;
  reversed_at: string | null;
  reversed_by: string | null;
  review_note: string | null;
  approved_at: string | null;
  order_received_date: string | null;
  updated_at: string;
  order_status_applied: boolean;
};

export type SyncsPage = {
  nodes: FulfillmentSync[];
  /** `totalCount` is the full count matching the current filters (not just this page) —
   * needed to compute a last page / let the user jump to an arbitrary page number. */
  pageInfo: { hasMore: boolean; limit: number; totalCount: number };
};

/** One row of the global, cross-order activity log (`GET /fulfillment/log`). Carries its
 * parent sync's order/location/status alongside the event itself, since — unlike the
 * per-order event list — a row here can't rely on the surrounding UI to already know which
 * order it belongs to. */
export type ActivityLogEntry = {
  id: number;
  sync_id: number;
  trigger: string;
  phase: string;
  item_id: string | null;
  quantity: number | null;
  adjustment_id: string | null;
  document_number: string | null;
  stock_before: number | null;
  ok: boolean;
  error_code: string | null;
  message: string | null;
  created_at: string;
  wc_order_id: number | null;
  order_number: string | null;
  digit_order_number: string | null;
  digit_so_id: string | null;
  warehouse_location: string | null;
  sync_status: string;
};

export type ActivityLogPage = {
  nodes: ActivityLogEntry[];
  pageInfo: { hasMore: boolean; limit: number };
};

export const ERROR_TITLES: Record<string, string> = {
  STOCK_SHORTAGE: 'Not enough stock',
  PARTIAL_APPLY: 'Partial inventory apply',
  ORDER_STATUS_FAILED: 'Inventory deducted; order not marked fulfilled',
  UNMATCHED: 'WooCommerce order not found',
  MISSING_ADDRESS: 'Unrecognized shipping country',
  CONFIG_MISSING: 'Missing configuration',
  STALE_ITEMS: 'Order items changed since preview',
  ALREADY_APPLIED: 'Already applied',
  ALREADY_FULFILLED_IN_SUTTON: 'Sutton order already fulfilled',
  IN_PROGRESS: 'Apply already in progress',
  INCOMPLETE_ITEMS: 'Order has incomplete line items',
  SUTTON_API: 'Sutton API error',
  LOCATION_UNRESOLVED: 'Warehouse location unresolved',
  ORDER_NOT_FOUND: 'Sutton order no longer found',
  ALIAS_UNRESOLVED: 'Alias item not resolved',
  KIT_BOM_MISSING: 'Kit has no default BOM',
  KIT_CYCLE: 'Virtual kit contains itself',
  COMPONENT_NOT_STANDARD: 'Kit component not standard-tracked',
};

export const ERROR_STATUSES = new Set([
  'needs_attention',
  'failed',
  'unmatched',
  'missing_address',
]);

/**
 * D1 `datetime('now')` stores UTC as `YYYY-MM-DD HH:MM:SS` with no zone, which `new Date`
 * would read as local time.
 */
export function parseTimestamp(value: string): Date {
  const sqliteUtc = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;
  return new Date(sqliteUtc.test(value) ? `${value.replace(' ', 'T')}Z` : value);
}

/** Fallback label for a row that has not deducted yet; the UI prefers the default bin's Sutton locationCode. */
export const LOCATION_LABEL: Record<string, string> = {
  PRIMARY: 'Default bin',
};

export const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: 'pending', label: 'Pending' },
  { value: 'awaiting_completion', label: 'Awaiting completion' },
  { value: 'pending_approval', label: 'Pending approval' },
  { value: 'ready', label: 'Ready' },
  { value: 'applying', label: 'Applying' },
  { value: 'fulfilled', label: 'Fulfilled' },
  { value: 'needs_attention', label: 'Needs attention' },
  { value: 'failed', label: 'Failed' },
  { value: 'unmatched', label: 'Unmatched' },
  { value: 'missing_address', label: 'Missing address' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'skipped', label: 'Skipped' },
  { value: 'reversed', label: 'Reversed' },
  { value: 'removed', label: 'Removed' },
];

export const LOCATION_OPTIONS: { value: string; label: string }[] = [
  ...Object.entries(LOCATION_LABEL).map(([value, label]) => ({ value, label })),
  { value: '__unspecified', label: 'Unspecified' },
];

export type SyncFacets = {
  statuses: string[];
  statusCounts: Record<string, number>;
  locations: string[];
  locationCounts: Record<string, number>;
  hasUnspecifiedLocation: boolean;
  unspecifiedLocationCount: number;
};

export type SortField = 'received' | 'updated' | 'status' | 'location' | 'so';
export type SortDir = 'asc' | 'desc';
export type GroupField = 'none' | 'status' | 'location';
