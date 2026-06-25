-- Migration: 135_profile_role_nav_sections.sql
-- Настройки видимости разделов меню по ролям аккаунта (picker, warehouse_manager, editor).

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS role_nav_sections JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN profiles.role_nav_sections IS
  'Видимость разделов по ролям: { "picker": { "products": false }, "editor": { ... } }. Отсутствие роли — пресет по умолчанию.';
