-- Текстовые поля карточки по маркетплейсам (не дублируют products.name/description для выгрузки на МП)

BEGIN;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS mp_ozon_name VARCHAR(2000),
  ADD COLUMN IF NOT EXISTS mp_ozon_description TEXT,
  ADD COLUMN IF NOT EXISTS mp_ozon_brand VARCHAR(500),
  ADD COLUMN IF NOT EXISTS mp_wb_vendor_code VARCHAR(255),
  ADD COLUMN IF NOT EXISTS mp_wb_name VARCHAR(2000),
  ADD COLUMN IF NOT EXISTS mp_wb_description TEXT,
  ADD COLUMN IF NOT EXISTS mp_wb_brand VARCHAR(500),
  ADD COLUMN IF NOT EXISTS mp_ym_name VARCHAR(2000),
  ADD COLUMN IF NOT EXISTS mp_ym_description TEXT;

COMMENT ON COLUMN products.mp_ozon_name IS 'Название товара для Ozon';
COMMENT ON COLUMN products.mp_ozon_description IS 'Описание для Ozon';
COMMENT ON COLUMN products.mp_ozon_brand IS 'Бренд (текст) для Ozon';
COMMENT ON COLUMN products.mp_wb_vendor_code IS 'Артикул продавца (vendorCode) для Wildberries';
COMMENT ON COLUMN products.mp_wb_name IS 'Название для Wildberries';
COMMENT ON COLUMN products.mp_wb_description IS 'Описание для Wildberries';
COMMENT ON COLUMN products.mp_wb_brand IS 'Бренд для Wildberries';
COMMENT ON COLUMN products.mp_ym_name IS 'Название для Яндекс.Маркета';
COMMENT ON COLUMN products.mp_ym_description IS 'Описание для Яндекс.Маркета';

COMMIT;
