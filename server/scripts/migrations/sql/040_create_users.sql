-- Migration: 040_create_users.sql
-- Description: Пользователи и роли (admin / user), привязка к профилю

BEGIN;

CREATE TABLE IF NOT EXISTS users (
    id BIGSERIAL PRIMARY KEY,
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    full_name VARCHAR(500),
    role VARCHAR(50) NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
    profile_id BIGINT REFERENCES profiles(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_profile_id ON users(profile_id);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
COMMENT ON TABLE users IS 'Пользователи: admin (profile_id NULL) или пользователь профиля (profile_id)';

COMMIT;
