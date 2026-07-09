-- Migration: 142_warehouse_writeoffs.sql
-- Description: Документы списания (warehouse_receipts.document_type = writeoff)

BEGIN;

ALTER TABLE warehouse_receipts
  ADD COLUMN IF NOT EXISTS warehouse_id BIGINT REFERENCES warehouses(id) ON DELETE SET NULL;

ALTER TABLE warehouse_receipts
  ADD COLUMN IF NOT EXISTS writeoff_reason VARCHAR(32);

COMMENT ON COLUMN warehouse_receipts.writeoff_reason IS 'Причина списания: Брак или Утеря (для document_type = writeoff)';

CREATE INDEX IF NOT EXISTS idx_warehouse_receipts_writeoff_list
  ON warehouse_receipts (document_type, organization_id, warehouse_id, created_at DESC);

COMMIT;
