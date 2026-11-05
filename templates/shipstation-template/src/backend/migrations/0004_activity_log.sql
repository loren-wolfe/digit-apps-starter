CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  digit_order_id TEXT,
  ss_shipment_id TEXT,
  status TEXT NOT NULL,
  message TEXT NOT NULL,
  detail TEXT
);

CREATE INDEX IF NOT EXISTS idx_activity_log_org_created
  ON activity_log (organization_id, created_at DESC);
