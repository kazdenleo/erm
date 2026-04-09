-- Migration: 062_account_email_greentaxi.sql
-- Description: Почта входа и контакт аккаунта: admin@example.com → greentaxi@list.ru

BEGIN;

UPDATE users
SET email = 'greentaxi@list.ru', updated_at = CURRENT_TIMESTAMP
WHERE LOWER(TRIM(email)) = LOWER(TRIM('admin@example.com'));

UPDATE profiles p
SET contact_email = 'greentaxi@list.ru', updated_at = CURRENT_TIMESTAMP
WHERE id IN (
  SELECT u.profile_id
  FROM users u
  WHERE LOWER(TRIM(u.email)) = LOWER(TRIM('greentaxi@list.ru'))
    AND u.profile_id IS NOT NULL
);

COMMIT;
