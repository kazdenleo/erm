-- Migration: 056_profile_contact_tariff.sql
-- Контакты и тариф аккаунта (профиля) для админки продукта

BEGIN;

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS contact_full_name VARCHAR(500),
  ADD COLUMN IF NOT EXISTS contact_email VARCHAR(255),
  ADD COLUMN IF NOT EXISTS contact_phone VARCHAR(100),
  ADD COLUMN IF NOT EXISTS tariff VARCHAR(200);

COMMENT ON COLUMN profiles.contact_full_name IS 'Контактное лицо (для админки продукта)';
COMMENT ON COLUMN profiles.contact_email IS 'Контактный email аккаунта';
COMMENT ON COLUMN profiles.contact_phone IS 'Телефон';
COMMENT ON COLUMN profiles.tariff IS 'Тариф (название/план)';

COMMIT;
