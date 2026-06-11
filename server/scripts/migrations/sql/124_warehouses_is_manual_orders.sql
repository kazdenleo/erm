-- Migration: 124_warehouses_is_manual_orders.sql
-- Description: Склад для резерва ручных заказов (один на профиль)

BEGIN;

ALTER TABLE warehouses
    ADD COLUMN IF NOT EXISTS is_manual_orders_warehouse BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN warehouses.is_manual_orders_warehouse IS 'Склад для резерва ручных заказов (marketplace=manual)';

CREATE UNIQUE INDEX IF NOT EXISTS idx_warehouses_one_manual_orders_per_profile
    ON warehouses (profile_id)
    WHERE is_manual_orders_warehouse = TRUE;

COMMIT;
