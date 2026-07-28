-- Migration: 151_pricing_strategies.sql
-- Настраиваемые стратегии ценообразования + цена продажи в product_marketplace_prices

CREATE TABLE IF NOT EXISTS pricing_strategies (
  id BIGSERIAL PRIMARY KEY,
  profile_id BIGINT REFERENCES profiles(id) ON DELETE CASCADE,
  name VARCHAR(200) NOT NULL,
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  is_default BOOLEAN NOT NULL DEFAULT false,
  -- Режим: floor | target_margin | competitor | sales | hybrid
  mode VARCHAR(32) NOT NULL DEFAULT 'floor'
    CHECK (mode IN ('floor', 'target_margin', 'competitor', 'sales', 'hybrid')),
  -- Параметры стратегии (отступы, пороги продаж, коридор и т.д.)
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_pricing_strategies_profile
  ON pricing_strategies (profile_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_pricing_strategies_default_per_profile
  ON pricing_strategies (profile_id)
  WHERE is_default = true AND profile_id IS NOT NULL;

COMMENT ON TABLE pricing_strategies IS 'Пользовательские стратегии ценообразования (пол / маржа / конкуренты / продажи)';
COMMENT ON COLUMN pricing_strategies.mode IS 'floor=минимум; target_margin=целевая маржа; competitor=от конкурентов; sales=от продаж; hybrid=комбинация';
COMMENT ON COLUMN pricing_strategies.config IS 'JSON: competitor/sales/target_margin_percent/band/max_change и т.д.';

ALTER TABLE product_marketplace_prices
  ADD COLUMN IF NOT EXISTS selling_price NUMERIC(12, 2),
  ADD COLUMN IF NOT EXISTS pricing_strategy_id BIGINT REFERENCES pricing_strategies(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS strategy_details JSONB;

COMMENT ON COLUMN product_marketplace_prices.selling_price IS 'Рассчитанная цена продажи по стратегии (не ниже min_price)';
COMMENT ON COLUMN product_marketplace_prices.pricing_strategy_id IS 'Стратегия, по которой посчитана selling_price';
COMMENT ON COLUMN product_marketplace_prices.strategy_details IS 'Разбор расчёта стратегии для UI';

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS pricing_strategy_id BIGINT REFERENCES pricing_strategies(id) ON DELETE SET NULL;

COMMENT ON COLUMN products.pricing_strategy_id IS 'Переопределение стратегии для товара (иначе default профиля)';

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS pricing_strategy_id BIGINT REFERENCES pricing_strategies(id) ON DELETE SET NULL;

COMMENT ON COLUMN organizations.pricing_strategy_id IS 'Стратегия по умолчанию для товаров организации (если у товара не задана)';
