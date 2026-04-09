-- Migration: 046_add_product_images_to_products.sql
-- Description: Изображения товара (храним массив метаданных + куда отправлять: Ozon/WB/YM)

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'products' AND column_name = 'images'
  ) THEN
    ALTER TABLE products ADD COLUMN images JSONB DEFAULT NULL;
    COMMENT ON COLUMN products.images IS 'Массив изображений товара: [{id,url,filename,marketplaces:{ozon,wb,ym},created_at}]';
  END IF;
END $$;

COMMIT;

