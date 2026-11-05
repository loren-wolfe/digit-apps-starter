-- Per-item deduction bin chosen on the Configuration tab. An item without a row deducts
-- from the configured warehouse (fulfillment_settings.warehouse_location_id).
CREATE TABLE IF NOT EXISTS item_bins (
  item_id TEXT PRIMARY KEY,
  item_name TEXT,
  item_sku TEXT,
  warehouse_location_id TEXT NOT NULL,
  location_code TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
