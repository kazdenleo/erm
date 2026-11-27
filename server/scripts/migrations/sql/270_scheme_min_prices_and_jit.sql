-- Migration: 270_scheme_min_prices_and_jit.sql
-- Мин. цены доп. схем (JSONB) + JIT под FBS. Не трогает min_price_fbs/fbo.

BEGIN;

ALTER TABLE product_marketplace_prices
  ADD COLUMN IF NOT EXISTS scheme_min_prices JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN product_marketplace_prices.scheme_min_prices IS
  'Мин. цены доп. схем: { dbs: { min, details }, edbs, cnc, rfbs, booking }';

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS jit_fbs_enabled BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN profiles.jit_fbs_enabled IS
  'JIT под FBS: заказ → закупка у поставщика → приёмка → отгрузка на МП';

COMMIT;
