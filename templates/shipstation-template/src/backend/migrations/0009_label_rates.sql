ALTER TABLE org_settings ADD COLUMN default_weight_oz REAL NOT NULL DEFAULT 16;
ALTER TABLE org_settings ADD COLUMN default_length_in REAL;
ALTER TABLE org_settings ADD COLUMN default_width_in REAL;
ALTER TABLE org_settings ADD COLUMN default_height_in REAL;
ALTER TABLE org_settings ADD COLUMN rate_strategy TEXT NOT NULL DEFAULT 'cheapest';

ALTER TABLE shipstation_order_map ADD COLUMN label_pdf_base64 TEXT;
