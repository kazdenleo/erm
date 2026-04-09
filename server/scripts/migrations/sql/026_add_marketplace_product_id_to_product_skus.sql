-- Migration: 026_add_marketplace_product_id_to_product_skus.sql
-- Description: Добавляем ID товара на маркетплейсе (Ozon product_id) для связи с нашим товаром

BEGIN;

ALTER TABLE product_skus
  ADD COLUMN IF NOT EXISTS marketplace_product_id BIGINT NULL;

COMMENT ON COLUMN product_skus.marketplace_product_id IS 'ID товара на маркетплейсе (для Ozon — product_id из API)';

CREATE INDEX IF NOT EXISTS idx_product_skus_marketplace_product_id
  ON product_skus(marketplace, marketplace_product_id)
  WHERE marketplace_product_id IS NOT NULL;

COMMIT;
