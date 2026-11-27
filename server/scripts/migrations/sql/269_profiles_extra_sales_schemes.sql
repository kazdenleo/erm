-- Migration: 269_profiles_extra_sales_schemes.sql
-- Доп. схемы работы МП у организации + разметка заказов.
-- Все флаги DEFAULT FALSE — текущий FBS/FBO-контур не меняется, пока схемы не включены.

BEGIN;

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS dbs_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS edbs_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS cnc_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS rfbs_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS booking_enabled BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN profiles.dbs_enabled IS 'Организация работает по DBS/DBW (доставка продавцом)';
COMMENT ON COLUMN profiles.edbs_enabled IS 'Организация работает по EDBS/Express';
COMMENT ON COLUMN profiles.cnc_enabled IS 'Организация работает по C&C / самовывоз';
COMMENT ON COLUMN profiles.rfbs_enabled IS 'Организация работает по rFBS (realFBS)';
COMMENT ON COLUMN profiles.booking_enabled IS 'Организация работает по бронированию WB';

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS sales_scheme VARCHAR(20);

COMMENT ON COLUMN orders.sales_scheme IS
  'Схема продажи заказа: fbs|fbo|dbs|edbs|cnc|rfbs|booking (null = неизвестно, вести как FBS-пайплайн)';

CREATE INDEX IF NOT EXISTS idx_orders_profile_sales_scheme
  ON orders (profile_id, sales_scheme)
  WHERE sales_scheme IS NOT NULL;

COMMIT;
