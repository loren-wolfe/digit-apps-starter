-- Map fulfillment method onto scheduled vs manual push. Unused sync/push-when/lane/dims
-- columns stay in the table but are no longer read by the app.
UPDATE org_settings
SET default_fulfillment_method = CASE
      WHEN default_fulfillment_method = 'manual' THEN 'manual'
      ELSE 'scheduled'
    END,
    sync_mode = 'digit_to_ss',
    updated_at = datetime('now');
