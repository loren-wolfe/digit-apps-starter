-- Initial schema (SQLite / D1). Do not edit after first publish; add new numbered files.

CREATE TABLE IF NOT EXISTS webhook_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL DEFAULT 'woocommerce',
  topic TEXT,
  wc_order_id INTEGER,
  order_number TEXT,
  order_status TEXT,
  signature_valid INTEGER,
  headers TEXT,
  payload TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS webhook_events_received_at_idx ON webhook_events (received_at DESC);
CREATE INDEX IF NOT EXISTS webhook_events_wc_order_id_idx ON webhook_events (wc_order_id);

CREATE TABLE IF NOT EXISTS fulfillment_syncs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  webhook_event_id INTEGER REFERENCES webhook_events(id),
  wc_order_id INTEGER,
  order_number TEXT,
  digit_so_id TEXT,
  shipping_country TEXT,
  warehouse_location TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  digit_order_number TEXT,
  items_preview TEXT,
  review_note TEXT,
  approved_at TEXT,
  approved_by TEXT,
  error_code TEXT,
  error_detail TEXT,
  applied_items TEXT,
  matched_external_numbers TEXT,
  order_status_applied INTEGER NOT NULL DEFAULT 0,
  order_received_date TEXT,
  -- "Mark errant / Un-deduct" tracking: mirrors applied_items' shape for the compensating
  -- (positive) adjustments that gave stock back.
  reversed_items TEXT,
  reversed_at TEXT,
  reversed_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS fulfillment_syncs_webhook_event_id_idx
  ON fulfillment_syncs (webhook_event_id);
CREATE INDEX IF NOT EXISTS fulfillment_syncs_status_idx ON fulfillment_syncs (status);
CREATE INDEX IF NOT EXISTS fulfillment_syncs_error_code_idx ON fulfillment_syncs (error_code);
CREATE INDEX IF NOT EXISTS fulfillment_syncs_digit_so_id_idx ON fulfillment_syncs (digit_so_id);
CREATE INDEX IF NOT EXISTS fulfillment_syncs_wc_order_id_idx ON fulfillment_syncs (wc_order_id);

CREATE TABLE IF NOT EXISTS fulfillment_apply_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sync_id INTEGER NOT NULL REFERENCES fulfillment_syncs(id) ON DELETE CASCADE,
  trigger TEXT NOT NULL,
  phase TEXT NOT NULL,
  item_id TEXT,
  quantity REAL,
  adjustment_id TEXT,
  document_number TEXT,
  stock_before REAL,
  ok INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS fulfillment_apply_events_sync_id_idx ON fulfillment_apply_events (sync_id);
CREATE INDEX IF NOT EXISTS fulfillment_apply_events_created_at_idx ON fulfillment_apply_events (created_at DESC);

-- Single-row settings table (id is always 1). Lets an operator flip automated deductions
-- from the UI without a republish, and caches Sutton ids the app resolves by name.
CREATE TABLE IF NOT EXISTS fulfillment_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  auto_deduct_enabled INTEGER NOT NULL DEFAULT 0,
  -- Consecutive non-stock-shortage auto-deduct failures since the last success or re-enable.
  auto_deduct_consecutive_failures INTEGER NOT NULL DEFAULT 0,
  auto_deduct_failure_threshold INTEGER NOT NULL DEFAULT 5,
  -- "Turned off by operator" vs. the circuit breaker's "Auto-disabled after N consecutive
  -- failures (...)" message.
  auto_deduct_disabled_reason TEXT,
  auto_deduct_disabled_at TEXT,
  auto_deduct_updated_by TEXT,
  -- Inventory adjustment reason option ids, found or created by name on first use.
  adjustment_reason_id TEXT,
  reversal_adjustment_reason_id TEXT,
  -- Item custom field "Kit Type" and its "Virtual Kit" option, found by name.
  kit_type_field_id TEXT,
  virtual_kit_option_id TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO fulfillment_settings (id) VALUES (1);
