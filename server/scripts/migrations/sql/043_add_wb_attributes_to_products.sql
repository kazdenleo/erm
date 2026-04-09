-- Migration: 043_add_wb_attributes_to_products.sql
-- Description: Атрибуты Wildberries для карточки товара (характеристики категории маркетплейса)

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'products' AND column_name = 'wb_attributes'
  ) THEN
    ALTER TABLE products ADD COLUMN wb_attributes JSONB DEFAULT NULL;
    COMMENT ON COLUMN products.wb_attributes IS 'Значения характеристик Wildberries (characteristic_id/name -> value)';
  END IF;
END $$;

COMMIT;

