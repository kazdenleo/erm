-- Migration: 074_reset_stock_and_history.sql
-- Description: Обнулить фактические остатки и очистить историю складских документов/движений.
-- NOTE: Это необратимо. После применения остатки нужно заново зафиксировать инвентаризацией.

BEGIN;

-- История движений остатков
TRUNCATE TABLE stock_movements RESTART IDENTITY;

-- Инвентаризации
TRUNCATE TABLE inventory_session_lines, inventory_sessions RESTART IDENTITY;

-- Приёмки/возвраты поставщику (складские документы)
TRUNCATE TABLE warehouse_receipt_lines, warehouse_receipts RESTART IDENTITY;

-- Возвраты поставщику (новая модель)
TRUNCATE TABLE supplier_return_items, supplier_returns RESTART IDENTITY;

-- Фактический остаток и резерв по всем товарам
UPDATE products
SET
  quantity = 0,
  reserved_quantity = 0,
  updated_at = CURRENT_TIMESTAMP;

COMMIT;

