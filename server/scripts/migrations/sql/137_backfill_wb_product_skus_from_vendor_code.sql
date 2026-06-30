-- Migration: 137_backfill_wb_product_skus_from_vendor_code.sql
-- Заполнить product_skus.wb из products.mp_wb_vendor_code (для сопоставления заказов FBS).

BEGIN;

INSERT INTO product_skus (product_id, marketplace, sku)
SELECT p.id, 'wb', TRIM(p.mp_wb_vendor_code)
FROM products p
WHERE p.mp_wb_vendor_code IS NOT NULL
  AND TRIM(p.mp_wb_vendor_code) <> ''
  AND NOT EXISTS (
    SELECT 1 FROM product_skus ps
    WHERE ps.product_id = p.id AND ps.marketplace = 'wb'
  )
ON CONFLICT (product_id, marketplace) DO NOTHING;

COMMIT;
