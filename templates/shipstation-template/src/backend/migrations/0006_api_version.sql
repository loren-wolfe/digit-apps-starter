-- api_version: 'v2' (api.shipstation.com + api-key) or 'v1' (ssapi + Basic).
-- Set on connect from whether SHIPSTATION_API_SECRET is present.
ALTER TABLE shipstation_connection ADD COLUMN api_version TEXT NOT NULL DEFAULT 'v2';
