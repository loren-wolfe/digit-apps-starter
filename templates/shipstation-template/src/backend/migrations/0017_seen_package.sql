-- Packages already pulled from ShipStation, so a later refresh only logs newly seen types.
CREATE TABLE IF NOT EXISTS shipstation_seen_package (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id INTEGER NOT NULL,
  source TEXT NOT NULL,
  ss_carrier_id TEXT NOT NULL DEFAULT '',
  package_code TEXT NOT NULL,
  package_name TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (connection_id) REFERENCES shipstation_connection (id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_seen_package_live
  ON shipstation_seen_package (connection_id, source, ss_carrier_id, package_code)
  WHERE deleted = 0;
