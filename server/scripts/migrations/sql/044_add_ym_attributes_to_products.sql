-- Migration: 044_add_ym_attributes_to_products.sql
-- Description: Атрибуты Яндекс.Маркета для карточки товара (параметры/характеристики категории маркетплейса)

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'products' AND column_name = 'ym_attributes'
  ) THEN
    ALTER TABLE products ADD COLUMN ym_attributes JSONB DEFAULT NULL;
    COMMENT ON COLUMN products.ym_attributes IS 'Значения характеристик Яндекс.Маркета (param_id/name -> value)';
  END IF;
END $$;

COMMIT;

