-- Migration: 141_stock_movements_reserve_indexes.sql
-- Description: Индексы для тяжёлых агрегатов нетто-резерва по stock_movements (SUM reserve/unreserve)
-- На большой prod-таблице при блокировках можно создать те же индексы вручную с CONCURRENTLY вне транзакции.

BEGIN;

CREATE INDEX IF NOT EXISTS idx_stock_movements_product_reserve
  ON stock_movements (product_id)
  WHERE type IN ('reserve', 'unreserve');

CREATE INDEX IF NOT EXISTS idx_stock_movements_product_wh_reserve
  ON stock_movements (product_id, warehouse_id)
  WHERE type IN ('reserve', 'unreserve');

CREATE INDEX IF NOT EXISTS idx_stock_movements_fbo_item_reserve
  ON stock_movements (product_id, (meta->>'fbo_supply_item_id'))
  WHERE type IN ('reserve', 'unreserve')
    AND meta ? 'fbo_supply_item_id';

CREATE INDEX IF NOT EXISTS idx_stock_movements_product_order_reserve
  ON stock_movements (
    product_id,
    (COALESCE(NULLIF(TRIM(meta->>'order_id'), ''), NULLIF(TRIM(meta->>'orderId'), '')))
  )
  WHERE type IN ('reserve', 'unreserve')
    AND (meta ? 'order_id' OR meta ? 'orderId');

CREATE INDEX IF NOT EXISTS idx_stock_movements_product_incoming
  ON stock_movements (product_id)
  WHERE LOWER(TRIM(type::text)) = 'incoming';

COMMIT;
