CREATE TABLE IF NOT EXISTS shipstation_connection (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id TEXT NOT NULL,
  api_key_encrypted TEXT NOT NULL,
  rate_timing TEXT NOT NULL DEFAULT 'shipping',
  rate_mode TEXT NOT NULL DEFAULT 'rate_shop',
  best_rate_strategy TEXT NOT NULL DEFAULT 'cheapest',
  add_cost_to_shipping_fees INTEGER NOT NULL DEFAULT 0,
  auto_send_return_email INTEGER NOT NULL DEFAULT 0,
  block_on_invalid_address INTEGER NOT NULL DEFAULT 0,
  defaults TEXT NOT NULL DEFAULT '{}',
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_shipstation_connection_one_live
  ON shipstation_connection (organization_id)
  WHERE deleted = 0;

CREATE TABLE IF NOT EXISTS shipstation_carrier (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id INTEGER NOT NULL,
  shipstation_carrier_id TEXT NOT NULL,
  carrier_code TEXT,
  name TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (connection_id) REFERENCES shipstation_connection (id)
);

CREATE INDEX IF NOT EXISTS idx_shipstation_carrier_connection
  ON shipstation_carrier (connection_id, deleted);

CREATE TABLE IF NOT EXISTS shipstation_service (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id INTEGER NOT NULL,
  carrier_id INTEGER NOT NULL,
  shipstation_service_code TEXT NOT NULL,
  name TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (connection_id) REFERENCES shipstation_connection (id),
  FOREIGN KEY (carrier_id) REFERENCES shipstation_carrier (id)
);

CREATE INDEX IF NOT EXISTS idx_shipstation_service_connection
  ON shipstation_service (connection_id, deleted);

CREATE TABLE IF NOT EXISTS shipment_label (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id INTEGER NOT NULL,
  carrier_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (connection_id) REFERENCES shipstation_connection (id),
  FOREIGN KEY (carrier_id) REFERENCES shipstation_carrier (id)
);

CREATE TABLE IF NOT EXISTS shipstation_webhook (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id INTEGER NOT NULL,
  shipstation_webhook_id TEXT NOT NULL,
  event TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (connection_id) REFERENCES shipstation_connection (id)
);

CREATE TABLE IF NOT EXISTS org_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id TEXT NOT NULL UNIQUE,
  default_fulfillment_method TEXT NOT NULL DEFAULT 'unspecified',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
