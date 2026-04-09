-- Migration: 079_purchase_receipts_warehouse_receipt_id.sql
-- Связь приёмки по закупке (purchase_receipts) с документом складской приёмки (warehouse_receipts)
--
-- Примечание: миграция продублирована с новым номером, т.к. в проекте уже есть 078,
-- а runner учитывает только номер версии.

BEGIN;

ALTER TABLE purchase_receipts
  ADD COLUMN IF NOT EXISTS warehouse_receipt_id BIGINT REFERENCES warehouse_receipts(id) ON DELETE SET NULL;

COMMENT ON COLUMN purchase_receipts.warehouse_receipt_id IS 'ID складской приёмки (warehouse_receipts), созданной из этой purchase_receipt';

COMMIT;

