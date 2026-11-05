-- Stored ShipStation package types for the queue dropdown.
-- A nightly job refreshes this table. The dropdown reads it and does not call ShipStation.
CREATE TABLE IF NOT EXISTS package_catalog (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id INTEGER NOT NULL,
  source TEXT NOT NULL,
  ss_carrier_id TEXT NOT NULL DEFAULT '',
  carrier_code TEXT NOT NULL DEFAULT '',
  package_code TEXT NOT NULL,
  package_id TEXT,
  package_name TEXT NOT NULL,
  description TEXT,
  length REAL,
  width REAL,
  height REAL,
  dimension_unit TEXT,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (connection_id) REFERENCES shipstation_connection (id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_package_catalog_live
  ON package_catalog (connection_id, source, ss_carrier_id, package_code)
  WHERE deleted = 0;

CREATE INDEX IF NOT EXISTS idx_package_catalog_connection
  ON package_catalog (connection_id, deleted);

-- pulled_on is the Pacific date of the last successful refresh. Null means it has not succeeded.
CREATE TABLE IF NOT EXISTS package_catalog_sync (
  connection_id INTEGER PRIMARY KEY,
  pulled_on TEXT,
  last_attempt_at TEXT,
  FOREIGN KEY (connection_id) REFERENCES shipstation_connection (id)
);
