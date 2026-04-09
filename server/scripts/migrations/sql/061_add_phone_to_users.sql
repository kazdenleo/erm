-- Migration: 061_add_phone_to_users.sql
-- Description: Телефон пользователя (профиль в кабинете)

BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS phone VARCHAR(50);

COMMENT ON COLUMN users.phone IS 'Контактный телефон пользователя';

COMMIT;
