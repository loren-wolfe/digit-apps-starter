-- Secrets moved to Digit App Secrets UI. Remove leftover in-app setup rows so
-- GET /setup does not keep counting them after the org deletes the Digit secret.
-- Keep ENCRYPTION_KEY (used only to decrypt legacy shipstation_connection keys).
DELETE FROM app_config
WHERE key IN (
  'API_TOKEN_DIGIT',
  'PUBLIC_WEBHOOK_URL',
  'SHIPSTATION_API_KEY',
  'SHIPSTATION_API_SECRET',
  'SHIPSTATION_WEBHOOK_TOKEN',
  'FAIRE_API_KEY'
);
