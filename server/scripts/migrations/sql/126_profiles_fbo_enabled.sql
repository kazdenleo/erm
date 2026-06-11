-- Migration: 126_profiles_fbo_enabled.sql
-- Description: Режим FBO и склад списания по умолчанию для поставок FBO

BEGIN;

ALTER TABLE profiles
    ADD COLUMN IF NOT EXISTS fbo_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS fbo_deduction_warehouse_id BIGINT REFERENCES warehouses(id) ON DELETE SET NULL;

COMMENT ON COLUMN profiles.fbo_enabled IS 'Аккаунт работает по FBO — подставлять склад списания в новые поставки';
COMMENT ON COLUMN profiles.fbo_deduction_warehouse_id IS 'Склад списания остатков для поставок FBO (при fbo_enabled)';

COMMIT;
