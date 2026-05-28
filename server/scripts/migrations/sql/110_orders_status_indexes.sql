-- Migration: 110_orders_status_indexes.sql
-- Description: Индексы для смены статуса и групп заказов (return-to-new, фильтры)

BEGIN;

CREATE INDEX IF NOT EXISTS idx_orders_order_group_id
  ON orders (order_group_id)
  WHERE order_group_id IS NOT NULL AND TRIM(order_group_id) <> '';

CREATE INDEX IF NOT EXISTS idx_orders_profile_status
  ON orders (profile_id, status);

COMMIT;
