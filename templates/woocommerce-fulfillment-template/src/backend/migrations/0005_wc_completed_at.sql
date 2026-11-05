-- When the WooCommerce poll saw the order as completed. A row without it came from the
-- Sutton open-order sync and cannot deduct until WooCommerce marks the order completed.
ALTER TABLE fulfillment_syncs ADD COLUMN wc_completed_at TEXT;

-- Rows from the WooCommerce poll (or older WooCommerce webhooks) were completed orders.
UPDATE fulfillment_syncs
   SET wc_completed_at = created_at
 WHERE webhook_event_id IN (
   SELECT id FROM webhook_events WHERE source <> 'sutton_poll'
 );

-- Rows the old Sutton reconcile queued for Approve now wait for WooCommerce instead.
UPDATE fulfillment_syncs
   SET status = 'awaiting_completion'
 WHERE wc_completed_at IS NULL
   AND status IN ('pending_approval', 'ready');
