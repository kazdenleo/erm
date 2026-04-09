-- Migration: 038_create_profiles.sql
-- Description: Профили (тенанты): в каждом профиле — несколько организаций и пользователей

BEGIN;

CREATE TABLE IF NOT EXISTS profiles (
    id BIGSERIAL PRIMARY KEY,
    name VARCHAR(500) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_profiles_name ON profiles(name);
COMMENT ON TABLE profiles IS 'Профили (кабинеты): группа организаций и пользователей с полным функционалом';

COMMIT;
