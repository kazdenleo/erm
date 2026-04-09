-- Migration: 057_admin_users_no_profile.sql
-- Администратор системы (role=admin): без привязки к аккаунту, не админ профиля

UPDATE users
SET
  profile_id = NULL,
  is_profile_admin = false,
  updated_at = CURRENT_TIMESTAMP
WHERE role = 'admin';
