DROP INDEX IF EXISTS idx_shipstation_order_map_digit;

CREATE UNIQUE INDEX IF NOT EXISTS idx_shipstation_order_map_shipment
  ON shipstation_order_map (connection_id, digit_shipment_id)
  WHERE deleted = 0 AND digit_shipment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_shipstation_order_map_order
  ON shipstation_order_map (connection_id, digit_order_id)
  WHERE deleted = 0;
