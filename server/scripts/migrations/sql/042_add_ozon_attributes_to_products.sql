-- Migration: 042_add_ozon_attributes_to_products.sql
-- Description: Атрибуты Ozon для карточки товара (характеристики категории маркетплейса)

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'products' AND column_name = 'ozon_attributes'
  ) THEN
    ALTER TABLE products ADD COLUMN ozon_attributes JSONB DEFAULT NULL;
    COMMENT ON COLUMN products.ozon_attributes IS 'Значения характеристик Ozon (attribute_id -> value/dictionary value id)';
  END IF;
END $$;

COMMIT;
