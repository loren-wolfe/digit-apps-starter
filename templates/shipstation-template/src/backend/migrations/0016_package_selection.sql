-- ShipStation package type chosen per Sutton pack container. Not written to Sutton.
CREATE TABLE IF NOT EXISTS package_selection (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id INTEGER NOT NULL,
  organization_id TEXT NOT NULL,
  digit_shipment_id TEXT NOT NULL,
  digit_container_id TEXT NOT NULL,
  source TEXT NOT NULL,
  package_code TEXT NOT NULL,
  package_id TEXT,
  package_name TEXT,
  ss_carrier_id TEXT,
  ss_carrier_code TEXT,
  length REAL,
  width REAL,
  height REAL,
  dimension_unit TEXT,
  weight_value REAL,
  weight_unit TEXT,
  observed_from_shipstation INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (connection_id) REFERENCES shipstation_connection (id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_package_selection_live
  ON package_selection (connection_id, digit_container_id)
  WHERE deleted = 0;

CREATE INDEX IF NOT EXISTS idx_package_selection_shipment
  ON package_selection (connection_id, digit_shipment_id)
  WHERE deleted = 0;
