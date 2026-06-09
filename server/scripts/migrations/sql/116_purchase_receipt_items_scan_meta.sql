-- Migration: 116_purchase_receipt_items_scan_meta.sql
-- Метаданные сканирования по сканерам (сортировка «недавно отсканированные»).

BEGIN;

ALTER TABLE purchase_receipt_items
  ADD COLUMN IF NOT EXISTS scan_meta JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN purchase_receipt_items.scan_meta IS
  'JSON: byScanner — { scannerId: timestampMs }, lastScanAt, lastScannerId';

COMMIT;
