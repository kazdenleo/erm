-- Migration: 025_add_calculation_details_to_product_marketplace_prices.sql
-- Description: Детальный расчёт минимальной цены (данные калькулятора) для отображения в модалке

BEGIN;

ALTER TABLE product_marketplace_prices
  ADD COLUMN IF NOT EXISTS calculation_details JSONB DEFAULT NULL;

COMMENT ON COLUMN product_marketplace_prices.calculation_details IS 'Данные калькулятора маркетплейса (комиссии, логистика и т.д.) для детального расчёта в UI';

COMMIT;
