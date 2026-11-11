BEGIN;

-- Разрешаем произвольные ключи ролей аккаунта (кастомные роли в role_nav_sections.customRoles).
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_account_role_check;

COMMIT;
