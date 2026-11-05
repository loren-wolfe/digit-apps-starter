-- date_modified_gmt of the last completed WooCommerce order the poll handled.
-- The next tick fetches orders modified after it.
ALTER TABLE fulfillment_settings ADD COLUMN wc_poll_cursor TEXT;
