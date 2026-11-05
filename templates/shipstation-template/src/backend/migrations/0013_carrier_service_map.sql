-- Map Digit shipping-carrier options at ShipStation service grain.
-- Existing carrier_digit_map rows become carrier defaults (ss_service_code = '').

CREATE TABLE carrier_digit_map_v13 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id INTEGER NOT NULL,
  ss_carrier_code TEXT NOT NULL,
  ss_service_code TEXT NOT NULL DEFAULT '',
  digit_option_id TEXT,
  source TEXT NOT NULL DEFAULT 'fuzzy',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (connection_id) REFERENCES shipstation_connection (id),
  UNIQUE (connection_id, ss_carrier_code, ss_service_code)
);

INSERT INTO carrier_digit_map_v13 (
  id, connection_id, ss_carrier_code, ss_service_code, digit_option_id, source, updated_at
)
SELECT id, connection_id, ss_carrier_code, '', digit_option_id, source, updated_at
FROM carrier_digit_map;

DROP TABLE carrier_digit_map;

ALTER TABLE carrier_digit_map_v13 RENAME TO carrier_digit_map;

CREATE INDEX IF NOT EXISTS idx_carrier_digit_map_connection
  ON carrier_digit_map (connection_id);

ALTER TABLE shipstation_order_map ADD COLUMN service_code TEXT;
ALTER TABLE shipstation_order_map ADD COLUMN service_name TEXT;
