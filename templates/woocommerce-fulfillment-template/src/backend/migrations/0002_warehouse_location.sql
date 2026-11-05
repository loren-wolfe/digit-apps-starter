-- Warehouse chosen on the Configuration tab. A saved id wins over the
-- WAREHOUSE_LOCATION_ID secret, which remains only as a fallback.
ALTER TABLE fulfillment_settings ADD COLUMN warehouse_location_id TEXT;
