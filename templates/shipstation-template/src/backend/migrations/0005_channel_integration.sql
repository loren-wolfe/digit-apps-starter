CREATE TABLE IF NOT EXISTS channel_connection (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  external_store_id TEXT,
  config_json TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_channel_connection_org_channel
  ON channel_connection (organization_id, channel_id)
  WHERE deleted = 0;

CREATE TABLE IF NOT EXISTS channel_order_map (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  digit_order_id TEXT,
  external_order_id TEXT NOT NULL,
  push_status TEXT NOT NULL DEFAULT 'pending',
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_order_map_unique
  ON channel_order_map (organization_id, channel_id, external_order_id);

CREATE INDEX IF NOT EXISTS idx_channel_order_map_digit
  ON channel_order_map (organization_id, channel_id, digit_order_id);

CREATE TABLE IF NOT EXISTS webhook_delivery (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_delivery_unique
  ON webhook_delivery (channel_id, delivery_id);

ALTER TABLE activity_log ADD COLUMN channel_id TEXT;
ALTER TABLE activity_log ADD COLUMN external_order_id TEXT;
