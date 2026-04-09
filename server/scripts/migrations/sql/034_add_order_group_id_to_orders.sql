-- Migration: 034_add_order_group_id_to_orders.sql
-- Description: Группировка строк заказа (ручной заказ с несколькими товарами)

BEGIN;

ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_group_id VARCHAR(255);
CREATE INDEX IF NOT EXISTS idx_orders_order_group_id ON orders(order_group_id) WHERE order_group_id IS NOT NULL;

COMMENT ON COLUMN orders.order_group_id IS 'Группа строк одного логического заказа (ручной заказ с несколькими товарами)';

COMMIT;
