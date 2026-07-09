-- Migration: 140_purchase_receipts_cancelled_at.sql
-- Отменённые приёмки по закупке остаются в списке (не удаляются).

BEGIN;

ALTER TABLE purchase_receipts
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;

COMMENT ON COLUMN purchase_receipts.cancelled_at IS 'Момент отмены завершённой приёмки (откат остатков)';

COMMIT;
