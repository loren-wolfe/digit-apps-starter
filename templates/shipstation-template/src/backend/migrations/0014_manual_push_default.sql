-- Default outbound push is operator-initiated (Push to ShipStation).
-- Scheduled remains available in Settings. The five-minute poll still pulls labels.
UPDATE org_settings
SET default_fulfillment_method = 'manual',
    updated_at = datetime('now')
WHERE default_fulfillment_method IS NULL
   OR default_fulfillment_method != 'manual';
