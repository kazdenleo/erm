-- Migration: 134_users_nav_sections.sql
-- Видимость разделов меню для каждого пользователя (JSON: ключ → false скрывает раздел)

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS nav_sections JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN users.nav_sections IS
  'Скрытые разделы меню: { "products": false, ... }. Отсутствующий ключ или true — раздел виден.';
