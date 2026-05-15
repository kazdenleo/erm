-- Migration: 099_products_is_archived.sql
-- Мягкое удаление товаров: архив вместо физического удаления при наличии истории

BEGIN;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS is_archived BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_products_is_archived ON products (is_archived)
  WHERE is_archived = true;

COMMENT ON COLUMN products.is_archived IS 'Товар в архиве (скрыт из списков по умолчанию; история движений сохраняется)';

COMMIT;
