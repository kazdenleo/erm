-- Migration: 076_inventory_sessions_warehouse.sql
-- Description: Инвентаризация привязана к складу (пересчёт остатка на выбранном складе).

BEGIN;

ALTER TABLE inventory_sessions
  ADD COLUMN IF NOT EXISTS warehouse_id BIGINT REFERENCES warehouses(id) ON DELETE SET NULL;

UPDATE inventory_sessions s
SET warehouse_id = (
  SELECT MIN(id) FROM warehouses WHERE type = 'warehouse' AND supplier_id IS NULL
)
WHERE s.warehouse_id IS NULL;

COMMENT ON COLUMN inventory_sessions.warehouse_id IS 'Склад, по которому зафиксированы quantity_before/after в строках';

COMMIT;
