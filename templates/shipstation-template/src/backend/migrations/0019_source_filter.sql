-- Optional source filter. Off by default so every sales order source routes to the queue.
-- source_filter_keys is a JSON array of Sutton commerce connection ids plus 'manual'
-- for orders entered directly in Sutton.
ALTER TABLE org_settings ADD COLUMN source_filter_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE org_settings ADD COLUMN source_filter_keys TEXT;
