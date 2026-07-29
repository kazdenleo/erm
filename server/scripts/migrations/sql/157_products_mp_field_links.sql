-- Связь полей карточки ERP с маркетплейсами (какие поля выгружать/зеркалить)

BEGIN;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS mp_field_links JSONB NOT NULL DEFAULT '{
    "name": ["ozon", "wb", "ym"],
    "sku": ["ozon", "wb", "ym"],
    "description": ["ozon", "wb", "ym"],
    "brand": ["ozon", "wb"],
    "country": ["ozon", "wb", "ym"],
    "dimensions": ["ozon", "wb", "ym"]
  }'::jsonb;

COMMENT ON COLUMN products.mp_field_links IS
  'Какие поля вкладки «Основное» связаны с карточками МП (name, sku, description, brand, country, dimensions → массивы ozon|wb|ym)';

COMMIT;
