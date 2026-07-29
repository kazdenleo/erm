-- Migration: 156_min_prices_fbs_fbo.sql
-- Мин. цены по схемам FBS/FBO + тумблер «Работать по FBS» у профиля

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS fbs_enabled BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN profiles.fbs_enabled IS
  'true = аккаунт работает по FBS: показывать/считать мин. цены FBS на странице Цены';

ALTER TABLE product_marketplace_prices
  ADD COLUMN IF NOT EXISTS min_price_fbs NUMERIC(12, 2),
  ADD COLUMN IF NOT EXISTS min_price_fbo NUMERIC(12, 2),
  ADD COLUMN IF NOT EXISTS calculation_details_fbs JSONB,
  ADD COLUMN IF NOT EXISTS calculation_details_fbo JSONB;

COMMENT ON COLUMN product_marketplace_prices.min_price_fbs IS 'Мин. цена по схеме FBS (для WB — FBS; для Ozon/YM — FBS)';
COMMENT ON COLUMN product_marketplace_prices.min_price_fbo IS 'Мин. цена по схеме FBO/FBY/FBW';
COMMENT ON COLUMN product_marketplace_prices.calculation_details_fbs IS 'Детали расчёта мин. цены FBS';
COMMENT ON COLUMN product_marketplace_prices.calculation_details_fbo IS 'Детали расчёта мин. цены FBO/FBY';

-- Бэкап текущих значений в схему-колонки (семантика как сейчас: Ozon/YM = FBS, WB = FBO)
UPDATE product_marketplace_prices
SET
  min_price_fbs = CASE
    WHEN marketplace IN ('ozon', 'ym') THEN COALESCE(min_price_fbs, min_price)
    ELSE min_price_fbs
  END,
  calculation_details_fbs = CASE
    WHEN marketplace IN ('ozon', 'ym') THEN COALESCE(calculation_details_fbs, calculation_details)
    ELSE calculation_details_fbs
  END,
  min_price_fbo = CASE
    WHEN marketplace = 'wb' THEN COALESCE(min_price_fbo, min_price)
    ELSE min_price_fbo
  END,
  calculation_details_fbo = CASE
    WHEN marketplace = 'wb' THEN COALESCE(calculation_details_fbo, calculation_details)
    ELSE calculation_details_fbo
  END
WHERE min_price IS NOT NULL;
