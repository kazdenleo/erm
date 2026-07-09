-- Migration: 140_orders_archive.sql
-- Архивация завершённых заказов (delivered/cancelled) старше 30 дней с момента финального статуса.

BEGIN;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS terminal_status_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

COMMENT ON COLUMN orders.terminal_status_at IS 'Когда заказ впервые перешёл в финальный статус (delivered/cancelled); не сбрасывается при синхронизации';
COMMENT ON COLUMN orders.archived_at IS 'Когда заказ убран из активных списков (архив); NULL — в рабочей выборке';

-- Оценка даты финального статуса для существующих записей (updated_at ненадёжен — синк его обновляет).
UPDATE orders o
SET terminal_status_at = sub.ts
FROM (
  SELECT id,
    CASE
      WHEN LOWER(TRIM(status)) = 'delivered'
        THEN COALESCE(shipment_date, assembled_at, in_process_at, created_at, updated_at)
      WHEN LOWER(TRIM(status)) IN ('cancelled', 'canceled')
        THEN COALESCE(created_at, in_process_at, updated_at)
      ELSE NULL
    END AS ts
  FROM orders
  WHERE LOWER(TRIM(status)) IN ('delivered', 'cancelled', 'canceled')
) sub
WHERE o.id = sub.id
  AND o.terminal_status_at IS NULL
  AND sub.ts IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_orders_active_profile
  ON orders (profile_id, created_at DESC)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_orders_archive_candidates
  ON orders (terminal_status_at)
  WHERE archived_at IS NULL
    AND terminal_status_at IS NOT NULL
    AND LOWER(TRIM(status)) IN ('delivered', 'cancelled', 'canceled');

COMMIT;
