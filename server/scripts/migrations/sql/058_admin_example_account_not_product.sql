-- Migration: 058_admin_example_account_not_product.sql
-- admin@example.com — администратор аккаунта (профиля), НЕ администратор продукта (role=admin).
-- Админ продукта: role=admin, profile_id NULL.
-- Админ аккаунта: role=user, is_profile_admin=true, profile_id задан.

BEGIN;

UPDATE users
SET
  role = 'user',
  is_profile_admin = true,
  profile_id = COALESCE(
    profile_id,
    (SELECT p.id FROM profiles p ORDER BY p.id ASC LIMIT 1)
  ),
  updated_at = CURRENT_TIMESTAMP
WHERE LOWER(TRIM(email)) = LOWER(TRIM('admin@example.com'));

COMMIT;
