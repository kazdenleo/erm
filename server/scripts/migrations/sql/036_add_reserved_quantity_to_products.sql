-- Migration: 036_add_reserved_quantity_to_products.sql
-- Description: Добавляем столбец reserved_quantity (количество в резерве по заказам)

BEGIN;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS reserved_quantity INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN products.reserved_quantity IS 'Количество товара в резерве (по заказам)';

COMMIT;
