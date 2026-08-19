-- Максимальная цена продажи по маркетплейсу (потолок, задаётся вручную).

ALTER TABLE product_marketplace_prices
  ADD COLUMN IF NOT EXISTS max_price NUMERIC(12, 2);

COMMENT ON COLUMN product_marketplace_prices.max_price IS 'Максимальная цена продажи на МП (₽), задаётся вручную';
