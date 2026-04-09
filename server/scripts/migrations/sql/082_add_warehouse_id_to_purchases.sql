-- Migration: 082_add_warehouse_id_to_purchases.sql
-- Description: Склад назначения для закупки (куда планируется приёмка)

BEGIN;

ALTER TABLE purchases
  ADD COLUMN IF NOT EXISTS warehouse_id BIGINT REFERENCES warehouses(id) ON DELETE SET NULL;

COMMENT ON COLUMN purchases.warehouse_id IS 'Склад назначения закупки (плановый склад приёмки)';

CREATE INDEX IF NOT EXISTS idx_purchases_warehouse_id ON purchases(warehouse_id);

COMMIT;

