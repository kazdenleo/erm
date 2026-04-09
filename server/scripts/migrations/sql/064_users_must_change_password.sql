-- Migration: 064_users_must_change_password.sql
-- Обязательная смена пароля после регистрации по email

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN users.must_change_password IS 'После выдачи временного пароля (регистрация) пользователь обязан сменить пароль при входе';
