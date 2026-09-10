-- Migration: 203_users_email_optional_phone_login.sql
-- Description: Email необязателен; вход по телефону. Уникальность почты — только если она задана.

BEGIN;

ALTER TABLE users
  ALTER COLUMN email DROP NOT NULL;

UPDATE users
SET email = NULL
WHERE email IS NOT NULL AND btrim(email) = '';

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_email_key;

DROP INDEX IF EXISTS users_email_key;

CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_uidx
  ON users (LOWER(btrim(email)))
  WHERE email IS NOT NULL AND btrim(email) <> '';

COMMENT ON COLUMN users.email IS 'Необязательный контактный email; логин — телефон';
COMMENT ON COLUMN users.phone IS 'Телефон пользователя, используется для входа';

COMMIT;
