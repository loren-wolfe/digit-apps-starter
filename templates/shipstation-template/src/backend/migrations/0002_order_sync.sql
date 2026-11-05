ALTER TABLE org_settings ADD COLUMN sync_mode TEXT NOT NULL DEFAULT 'digit_to_ss';
ALTER TABLE org_settings ADD COLUMN push_when TEXT NOT NULL DEFAULT 'fully_packed';
ALTER TABLE org_settings ADD COLUMN lane_tag_id TEXT;

CREATE TABLE IF NOT EXISTS shipstation_order_map (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id INTEGER NOT NULL,
  organization_id TEXT NOT NULL,
  digit_order_id TEXT NOT NULL,
  digit_shipment_id TEXT,
  ss_shipment_id TEXT,
  ss_label_id TEXT,
  source TEXT NOT NULL DEFAULT 'digit',
  push_status TEXT NOT NULL DEFAULT 'pending',
  last_error TEXT,
  tracking_number TEXT,
  carrier_name TEXT,
  ship_date TEXT,
  shipment_cost_amount REAL,
  shipment_cost_currency TEXT,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (connection_id) REFERENCES shipstation_connection (id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_shipstation_order_map_digit
  ON shipstation_order_map (connection_id, digit_order_id)
  WHERE deleted = 0;

CREATE INDEX IF NOT EXISTS idx_shipstation_order_map_ss
  ON shipstation_order_map (connection_id, ss_shipment_id)
  WHERE deleted = 0;
