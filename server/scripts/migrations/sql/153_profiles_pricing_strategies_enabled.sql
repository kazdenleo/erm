-- Migration: 153_profiles_pricing_strategies_enabled.sql
-- Глобальный выключатель стратегий ценообразования на уровне кабинета (профиля)

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS pricing_strategies_enabled BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN profiles.pricing_strategies_enabled IS
  'false = стратегии не применяются; фактическая цена задаётся вручную на странице Цены';
