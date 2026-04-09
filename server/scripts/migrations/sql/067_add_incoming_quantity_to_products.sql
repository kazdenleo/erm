-- Migration: 067_add_incoming_quantity_to_products.sql
-- Description: Ожидаемый остаток (incoming) по закупкам/ожиданию поставки

BEGIN;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS incoming_quantity INTEGER NOT NULL DEFAULT 0;

-- safety: не допускаем отрицательных значений
ALTER TABLE products
  DROP CONSTRAINT IF EXISTS chk_products_incoming_quantity_nonneg;
ALTER TABLE products
  ADD CONSTRAINT chk_products_incoming_quantity_nonneg CHECK (incoming_quantity >= 0);

COMMENT ON COLUMN products.incoming_quantity IS 'Ожидаемое количество товара (по закупкам/ожиданию); не входит в фактический складской остаток';

COMMIT;

