-- Migration: 047_add_country_of_origin_to_products.sql
-- Description: Страна производства в основных характеристиках товара

BEGIN;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS country_of_origin VARCHAR(120);

CREATE INDEX IF NOT EXISTS idx_products_country_of_origin ON products(country_of_origin);
COMMENT ON COLUMN products.country_of_origin IS 'Страна производства товара';

COMMIT;
