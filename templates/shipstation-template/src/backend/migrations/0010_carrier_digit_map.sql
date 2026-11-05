CREATE TABLE IF NOT EXISTS carrier_digit_map (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id INTEGER NOT NULL,
  ss_carrier_code TEXT NOT NULL,
  digit_option_id TEXT,
  source TEXT NOT NULL DEFAULT 'fuzzy',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (connection_id) REFERENCES shipstation_connection (id),
  UNIQUE (connection_id, ss_carrier_code)
);

CREATE INDEX IF NOT EXISTS idx_carrier_digit_map_connection
  ON carrier_digit_map (connection_id);
