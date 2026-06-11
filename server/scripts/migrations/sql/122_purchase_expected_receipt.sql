-- Migration: 122_purchase_expected_receipt.sql
-- Черновик приёмки «Ожидается»: план поставки до фактической приёмки.

BEGIN;

ALTER TABLE purchase_receipts DROP CONSTRAINT IF EXISTS purchase_receipts_status_check;
ALTER TABLE purchase_receipts ADD CONSTRAINT purchase_receipts_status_check
  CHECK (status IN ('draft', 'expected', 'scanning', 'completed', 'cancelled'));

ALTER TABLE purchase_receipt_items
  ADD COLUMN IF NOT EXISTS expected_quantity INTEGER,
  ADD COLUMN IF NOT EXISTS unit_price NUMERIC(12, 2);

ALTER TABLE purchase_receipt_items DROP CONSTRAINT IF EXISTS purchase_receipt_items_expected_quantity_check;
ALTER TABLE purchase_receipt_items ADD CONSTRAINT purchase_receipt_items_expected_quantity_check
  CHECK (expected_quantity IS NULL OR expected_quantity >= 0);

COMMENT ON COLUMN purchase_receipt_items.expected_quantity IS 'Ожидаемое кол-во (черновик «Ожидается»); scanned_quantity — факт при приёмке';
COMMENT ON COLUMN purchase_receipt_items.unit_price IS 'Ожидаемая закупочная цена (черновик «Ожидается»)';

COMMIT;
