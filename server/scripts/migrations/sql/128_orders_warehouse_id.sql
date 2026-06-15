-- Migration: 128_orders_warehouse_id.sql
-- Description: Склад списания для заказа (ручные заказы — per-order warehouse)

BEGIN;

ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS warehouse_id BIGINT REFERENCES warehouses(id) ON DELETE SET NULL;

COMMENT ON COLUMN orders.warehouse_id IS 'Склад резерва/списания для заказа (обязателен для marketplace=manual)';

CREATE INDEX IF NOT EXISTS idx_orders_warehouse_id ON orders(warehouse_id);

UPDATE orders o
SET warehouse_id = p.manual_orders_warehouse_id
FROM profiles p
WHERE o.marketplace = 'manual'
  AND o.profile_id = p.id
  AND o.warehouse_id IS NULL
  AND p.manual_orders_warehouse_id IS NOT NULL;

UPDATE orders o
SET warehouse_id = w.id
FROM warehouses w
WHERE o.marketplace = 'manual'
  AND o.warehouse_id IS NULL
  AND w.profile_id = o.profile_id
  AND w.is_manual_orders_warehouse = TRUE;

COMMIT;
