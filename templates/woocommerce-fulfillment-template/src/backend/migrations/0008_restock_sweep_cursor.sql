-- Last fulfillment_syncs.id the poll's restock sweep checked. Each tick resumes after it
-- (wrapping to the start), so every stock-shortage row is rechecked in turn.
ALTER TABLE fulfillment_settings ADD COLUMN restock_sweep_cursor INTEGER;
