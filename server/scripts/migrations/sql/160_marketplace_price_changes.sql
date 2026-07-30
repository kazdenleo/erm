-- Migration: 160_marketplace_price_changes.sql
-- История изменений цен МП (факт / пол) за последние 7 дней

BEGIN;

CREATE TABLE IF NOT EXISTS marketplace_price_changes (
  id BIGSERIAL PRIMARY KEY,
  product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  marketplace VARCHAR(20) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  source VARCHAR(32) NOT NULL,
  reason TEXT,
  min_price_before NUMERIC(12, 2),
  min_price_after NUMERIC(12, 2),
  selling_price_before NUMERIC(12, 2),
  selling_price_after NUMERIC(12, 2),
  pricing_strategy_id BIGINT REFERENCES pricing_strategies(id) ON DELETE SET NULL,
  profile_id BIGINT,
  meta JSONB
);

CREATE INDEX IF NOT EXISTS idx_marketplace_price_changes_product_created
  ON marketplace_price_changes (product_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_marketplace_price_changes_created
  ON marketplace_price_changes (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_marketplace_price_changes_profile_created
  ON marketplace_price_changes (profile_id, created_at DESC)
  WHERE profile_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_marketplace_price_changes_mp_created
  ON marketplace_price_changes (marketplace, created_at DESC);

COMMENT ON TABLE marketplace_price_changes IS
  'Журнал изменений цен по маркетплейсам (стратегия / ручное). Храним ~7 дней.';

COMMIT;
