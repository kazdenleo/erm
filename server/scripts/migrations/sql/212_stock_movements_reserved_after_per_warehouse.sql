-- Migration: 212_stock_movements_reserved_after_per_warehouse.sql
-- reserved_after для строк со складом — резерв ЭТОГО склада, не глобальный.

BEGIN;

COMMENT ON COLUMN stock_movements.reserved_after IS
  'Резерв после операции: при warehouse_id — нетто по этому складу; без склада — по всем складам';

-- Бэкап: пересчитать running net по (product_id, warehouse_id) для строк со складом.
WITH running AS (
  SELECT
    sm.id,
    GREATEST(
      0,
      COALESCE(
        SUM(
          CASE
            WHEN sm.type = 'reserve' THEN
              CASE
                WHEN sm.quantity_change < 0 THEN -(sm.quantity_change::numeric)
                ELSE sm.quantity_change::numeric
              END
            WHEN sm.type = 'unreserve' THEN
              CASE
                WHEN sm.quantity_change > 0 THEN -(sm.quantity_change::numeric)
                ELSE sm.quantity_change::numeric
              END
            ELSE 0::numeric
          END
        ) OVER (
          PARTITION BY sm.product_id, sm.warehouse_id
          ORDER BY sm.created_at ASC, sm.id ASC
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ),
        0
      )
    )::int AS reserved_wh
  FROM stock_movements sm
  WHERE sm.warehouse_id IS NOT NULL
)
UPDATE stock_movements sm
SET reserved_after = r.reserved_wh
FROM running r
WHERE sm.id = r.id
  AND sm.warehouse_id IS NOT NULL
  AND (sm.reserved_after IS DISTINCT FROM r.reserved_wh);

COMMIT;
