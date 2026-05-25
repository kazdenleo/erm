-- Migration: 107_warehouses_is_fbo_stock.sql
-- Description: Склад FBO для расчёта закупки по поставкам (один на профиль)

BEGIN;

ALTER TABLE warehouses
    ADD COLUMN IF NOT EXISTS is_fbo_stock BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN warehouses.is_fbo_stock IS 'Склад FBO: остатки для расчёта закупки по поставкам FBO';

CREATE UNIQUE INDEX IF NOT EXISTS idx_warehouses_one_fbo_per_profile
    ON warehouses (profile_id)
    WHERE is_fbo_stock = TRUE;

COMMIT;
