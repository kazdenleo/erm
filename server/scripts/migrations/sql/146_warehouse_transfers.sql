-- Migration: 146_warehouse_transfers.sql
-- Description: Документы перемещения между складами (warehouse_receipts.document_type = transfer)

ALTER TABLE warehouse_receipts
  ADD COLUMN IF NOT EXISTS to_warehouse_id BIGINT REFERENCES warehouses(id) ON DELETE SET NULL;

COMMENT ON COLUMN warehouse_receipts.to_warehouse_id IS 'Склад-получатель (для document_type = transfer)';

CREATE INDEX IF NOT EXISTS idx_warehouse_receipts_transfer_list
  ON warehouse_receipts (document_type, organization_id, warehouse_id, created_at DESC);
