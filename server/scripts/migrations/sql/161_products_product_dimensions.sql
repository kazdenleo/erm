-- Габариты самого товара (не упаковки): мм / г
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS product_length NUMERIC(12, 2),
  ADD COLUMN IF NOT EXISTS product_width NUMERIC(12, 2),
  ADD COLUMN IF NOT EXISTS product_height NUMERIC(12, 2),
  ADD COLUMN IF NOT EXISTS product_weight NUMERIC(12, 2);

COMMENT ON COLUMN products.product_length IS 'Длина товара, мм (не упаковки)';
COMMENT ON COLUMN products.product_width IS 'Ширина товара, мм (не упаковки)';
COMMENT ON COLUMN products.product_height IS 'Высота товара, мм (не упаковки)';
COMMENT ON COLUMN products.product_weight IS 'Вес товара, г (без упаковки)';
