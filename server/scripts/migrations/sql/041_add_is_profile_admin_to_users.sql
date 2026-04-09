-- Migration: 041_add_is_profile_admin_to_users.sql
-- Description: Администратор профиля — может управлять пользователями профиля и видеть роли

BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_profile_admin BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_users_is_profile_admin ON users(is_profile_admin) WHERE is_profile_admin = true;
COMMENT ON COLUMN users.is_profile_admin IS 'Администратор профиля: управляет пользователями своего профиля и видит роли';

COMMIT;
