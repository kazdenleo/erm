-- Целевая мин. наценка (прибыль) по маркетплейсам для расчёта мин. цены МП.
-- products.min_price остаётся общей (частные/ручные заказы).

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS min_profit_ozon NUMERIC(12, 2) NULL,
  ADD COLUMN IF NOT EXISTS min_profit_wb NUMERIC(12, 2) NULL,
  ADD COLUMN IF NOT EXISTS min_profit_ym NUMERIC(12, 2) NULL;

COMMENT ON COLUMN products.min_profit_ozon IS 'Целевая чистая прибыль (₽) для расчёта мин. цены Ozon';
COMMENT ON COLUMN products.min_profit_wb IS 'Целевая чистая прибыль (₽) для расчёта мин. цены Wildberries';
COMMENT ON COLUMN products.min_profit_ym IS 'Целевая чистая прибыль (₽) для расчёта мин. цены Яндекс.Маркет';
