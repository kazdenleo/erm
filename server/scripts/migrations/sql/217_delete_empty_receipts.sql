-- Приёмки без товаров не храним.

-- 1) Завершённые/отменённые приёмки по закупке, где ничего не отсканировано и нет движений остатков.
DELETE FROM purchase_receipts pr
WHERE pr.status IN ('completed', 'cancelled')
  AND NOT EXISTS (
    SELECT 1 FROM purchase_receipt_items ri
    WHERE ri.receipt_id = pr.id AND COALESCE(ri.scanned_quantity, 0) > 0
  )
  AND NOT EXISTS (
    SELECT 1 FROM stock_movements sm
    WHERE sm.meta->>'purchase_receipt_id' = pr.id::text
  )
  AND NOT EXISTS (
    SELECT 1 FROM supplier_returns sr WHERE sr.purchase_receipt_id = pr.id
  );

-- 2) Складские приёмки (ПТ) без строк и без движений остатков.
--    Документы, привязанные к приёмке по закупке с принятым товаром, не трогаем — строки им досоздаст backfill.
DELETE FROM warehouse_receipts r
WHERE COALESCE(r.document_type, 'receipt') = 'receipt'
  AND NOT EXISTS (SELECT 1 FROM warehouse_receipt_lines l WHERE l.receipt_id = r.id)
  AND NOT EXISTS (
    SELECT 1 FROM stock_movements sm WHERE sm.meta->>'receipt_id' = r.id::text
  )
  AND NOT EXISTS (
    SELECT 1 FROM stock_movements sm WHERE sm.meta->>'warehouse_receipt_id' = r.id::text
  )
  AND NOT EXISTS (
    SELECT 1
    FROM purchase_receipts pr
    JOIN purchase_receipt_items ri ON ri.receipt_id = pr.id
    WHERE pr.warehouse_receipt_id = r.id
      AND COALESCE(ri.scanned_quantity, 0) > 0
  );
