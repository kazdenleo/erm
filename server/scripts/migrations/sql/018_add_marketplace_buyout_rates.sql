-- Migration: 018_add_marketplace_buyout_rates.sql
-- Description: Добавление полей для хранения процента выкупа по каждому маркетплейсу

BEGIN;

-- Добавляем поля для процента выкупа по каждому маркетплейсу
ALTER TABLE products 
  ADD COLUMN IF NOT EXISTS buyout_rate_ozon INTEGER DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS buyout_rate_wb INTEGER DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS buyout_rate_ym INTEGER DEFAULT NULL;

-- Добавляем ограничения для новых полей (0-100)
ALTER TABLE products 
  ADD CONSTRAINT chk_buyout_rate_ozon CHECK (buyout_rate_ozon IS NULL OR (buyout_rate_ozon >= 0 AND buyout_rate_ozon <= 100)),
  ADD CONSTRAINT chk_buyout_rate_wb CHECK (buyout_rate_wb IS NULL OR (buyout_rate_wb >= 0 AND buyout_rate_wb <= 100)),
  ADD CONSTRAINT chk_buyout_rate_ym CHECK (buyout_rate_ym IS NULL OR (buyout_rate_ym >= 0 AND buyout_rate_ym <= 100));

-- Комментарии к полям
COMMENT ON COLUMN products.buyout_rate_ozon IS 'Процент выкупа товара на Ozon (0-100)';
COMMENT ON COLUMN products.buyout_rate_wb IS 'Процент выкупа товара на Wildberries (0-100)';
COMMENT ON COLUMN products.buyout_rate_ym IS 'Процент выкупа товара на Yandex Market (0-100)';

-- Если в buyout_rate есть значение, копируем его в новые поля (для существующих товаров)
-- Это временная мера для миграции данных
-- Используем JOIN с product_skus для определения наличия SKU на маркетплейсах
UPDATE products p
SET 
  buyout_rate_ozon = CASE 
    WHEN EXISTS (SELECT 1 FROM product_skus ps WHERE ps.product_id = p.id AND ps.marketplace = 'ozon') 
    THEN buyout_rate 
    ELSE NULL 
  END,
  buyout_rate_wb = CASE 
    WHEN EXISTS (SELECT 1 FROM product_skus ps WHERE ps.product_id = p.id AND ps.marketplace = 'wb') 
    THEN buyout_rate 
    ELSE NULL 
  END,
  buyout_rate_ym = CASE 
    WHEN EXISTS (SELECT 1 FROM product_skus ps WHERE ps.product_id = p.id AND ps.marketplace = 'ym') 
    THEN buyout_rate 
    ELSE NULL 
  END
WHERE buyout_rate IS NOT NULL AND buyout_rate != 100;

COMMIT;

