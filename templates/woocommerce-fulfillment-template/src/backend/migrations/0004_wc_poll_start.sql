-- Date the WooCommerce poll started reading from: FULFILLMENT_LOG_SINCE, or the first run's
-- 48-hour lookback. The fulfillment log hides orders received before it.
ALTER TABLE fulfillment_settings ADD COLUMN wc_poll_start TEXT;
