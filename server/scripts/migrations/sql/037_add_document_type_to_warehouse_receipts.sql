-- Migration: 037_add_document_type_to_warehouse_receipts.sql
-- Description: Тип документа приёмки: приёмка (ПТ) или возврат поставщику (ВН)

BEGIN;

ALTER TABLE warehouse_receipts
  ADD COLUMN IF NOT EXISTS document_type VARCHAR(20) NOT NULL DEFAULT 'receipt';

COMMENT ON COLUMN warehouse_receipts.document_type IS 'Тип: receipt — приёмка на склад, return — возврат поставщику';

COMMIT;
