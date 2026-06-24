-- Migration: 130_profiles_auto_send_to_assembly_on_reserve.sql
-- Автоотправка заказа на сборку после успешного резерва при наличии на складе.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS auto_send_to_assembly_on_reserve boolean NOT NULL DEFAULT false;
