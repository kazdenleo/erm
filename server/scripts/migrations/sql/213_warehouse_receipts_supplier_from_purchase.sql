-- Приёмки по закупке без поставщика в шапке: берём поставщика из закупки.
UPDATE warehouse_receipts r
SET supplier_id = pur.supplier_id
FROM purchase_receipts pr
JOIN purchases pur ON pur.id = pr.purchase_id
WHERE pr.warehouse_receipt_id = r.id
  AND r.supplier_id IS NULL
  AND pur.supplier_id IS NOT NULL;
