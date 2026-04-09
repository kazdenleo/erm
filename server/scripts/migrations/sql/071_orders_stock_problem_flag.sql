-- Migration: 071_orders_stock_problem_flag.sql
-- Description: Флаг "Проблема с остатком" на заказе (для UI и контроля процессов)

BEGIN;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS stock_problem BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS stock_problem_detected_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS stock_problem_details JSONB;

CREATE INDEX IF NOT EXISTS idx_orders_stock_problem ON orders(stock_problem) WHERE stock_problem = true;

COMMENT ON COLUMN orders.stock_problem IS 'Есть проблема с покрытием резерва по заказу (actual+incoming < reserved)';
COMMENT ON COLUMN orders.stock_problem_detected_at IS 'Когда проблема с остатком была обнаружена (последний раз)';
COMMENT ON COLUMN orders.stock_problem_details IS 'Диагностика: непокрытые позиции/кол-во (JSON)';

COMMIT;

