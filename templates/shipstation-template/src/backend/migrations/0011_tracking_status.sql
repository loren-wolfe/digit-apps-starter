ALTER TABLE shipstation_order_map ADD COLUMN tracking_status TEXT;
ALTER TABLE shipstation_order_map ADD COLUMN channels_notified INTEGER NOT NULL DEFAULT 0;
