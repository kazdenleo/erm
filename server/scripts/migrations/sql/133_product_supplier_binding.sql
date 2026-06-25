-- Migration: 133_product_supplier_binding.sql
-- Привязка товара к поставщику (опционально, по флагу аккаунта).

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS allow_product_supplier_binding boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN profiles.allow_product_supplier_binding IS
  'true — в карточке товара можно указать поставщика; фильтр в списках и учёт при закупке';

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS supplier_id BIGINT REFERENCES suppliers(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_products_supplier_id ON products(supplier_id);

COMMENT ON COLUMN products.supplier_id IS
  'Привязанный поставщик для закупки (если включена настройка аккаунта)';
