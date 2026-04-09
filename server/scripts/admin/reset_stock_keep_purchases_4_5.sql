-- Admin script: reset stock/history but keep purchases #4 and #5
-- ВНИМАНИЕ: необратимо. Удаляет историю движений, все приёмки и инвентаризации.
-- Оставляет закупки: 4 и 5. Пересчитывает incoming только по их строкам.
--
-- Что будет сделано:
-- - stock_movements: очищается полностью
-- - inventory_sessions(+lines): удаляются полностью
-- - warehouse_receipts(+lines): удаляются полностью
-- - supplier_returns(+items): удаляются полностью
-- - purchase_receipts(+items): удаляются полностью (в т.ч. по закупкам 4 и 5)
-- - purchases: удаляются все, кроме 4 и 5
-- - product_warehouse_stock: quantity=0
-- - products: quantity=0, reserved_quantity=0, incoming_quantity пересчитан по закупкам 4 и 5

BEGIN;

-- 1) Удаляем историю движений
TRUNCATE TABLE stock_movements RESTART IDENTITY CASCADE;

-- 2) Удаляем инвентаризации
TRUNCATE TABLE inventory_session_lines, inventory_sessions RESTART IDENTITY CASCADE;

-- 3) Приёмки по закупкам (сканирование) — удаляем полностью
-- Важно: purchase_receipts может ссылаться на warehouse_receipts (warehouse_receipt_id),
-- поэтому сначала чистим purchase_receipts, затем warehouse_receipts.
TRUNCATE TABLE purchase_receipt_items, purchase_receipts RESTART IDENTITY CASCADE;

-- 4) Возвраты поставщику (излишки и т.п.)
TRUNCATE TABLE supplier_return_items, supplier_returns RESTART IDENTITY CASCADE;

-- 5) Удаляем складские документы приёмки/возвраты (единая модель)
TRUNCATE TABLE warehouse_receipt_lines, warehouse_receipts RESTART IDENTITY CASCADE;

-- 6) Оставляем только закупки №4 и №5
DELETE FROM purchases
WHERE id NOT IN (4, 5);

-- 7) Сбрасываем принятое по строкам оставшихся закупок (т.к. приёмки удалены)
UPDATE purchase_items
SET received_quantity = 0,
    updated_at = CURRENT_TIMESTAMP
WHERE purchase_id IN (4, 5);

-- 8) Обнуляем фактические остатки по складам (quantity пересчитается триггером в products)
UPDATE product_warehouse_stock
SET quantity = 0;

-- 9) Обнуляем quantity/reserved/incoming на товарах
UPDATE products
SET quantity = 0,
    reserved_quantity = 0,
    incoming_quantity = 0,
    updated_at = CURRENT_TIMESTAMP;

-- 10) Пересчитываем incoming только по закупкам №4 и №5
UPDATE products p
SET incoming_quantity = x.inc,
    updated_at = CURRENT_TIMESTAMP
FROM (
  SELECT
    product_id,
    SUM(GREATEST(0, expected_quantity - COALESCE(received_quantity, 0)))::int AS inc
  FROM purchase_items
  WHERE purchase_id IN (4, 5)
  GROUP BY product_id
) x
WHERE p.id = x.product_id;

COMMIT;

