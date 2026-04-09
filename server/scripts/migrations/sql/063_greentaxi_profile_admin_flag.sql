-- Migration: 063_greentaxi_profile_admin_flag.sql
-- После смены email (062) на всякий случай восстанавливаем флаг администратора аккаунта

BEGIN;

UPDATE users
SET is_profile_admin = true, updated_at = CURRENT_TIMESTAMP
WHERE profile_id IS NOT NULL
  AND role = 'user'
  AND LOWER(TRIM(email)) = LOWER(TRIM('greentaxi@list.ru'));

COMMIT;
