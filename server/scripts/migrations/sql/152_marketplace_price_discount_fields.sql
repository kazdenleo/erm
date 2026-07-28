-- Migration: 152_marketplace_price_discount_fields.sql
-- Цена до скидки / % скидки + ручной режим фактической цены (selling_price)

ALTER TABLE product_marketplace_prices
  ADD COLUMN IF NOT EXISTS price_before_discount NUMERIC(12, 2),
  ADD COLUMN IF NOT EXISTS discount_percent NUMERIC(6, 2),
  ADD COLUMN IF NOT EXISTS selling_price_manual BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN product_marketplace_prices.price_before_discount IS 'Цена до скидки (зачёркнутая / list price)';
COMMENT ON COLUMN product_marketplace_prices.discount_percent IS 'Скидка %, согласованная с selling_price и price_before_discount';
COMMENT ON COLUMN product_marketplace_prices.selling_price_manual IS 'true = selling_price задана вручную (без стратегии); стратегия её не перезаписывает';

ALTER TABLE product_marketplace_prices
  DROP CONSTRAINT IF EXISTS chk_pmp_discount_percent_range;

ALTER TABLE product_marketplace_prices
  ADD CONSTRAINT chk_pmp_discount_percent_range
  CHECK (discount_percent IS NULL OR (discount_percent >= 0 AND discount_percent < 100));
