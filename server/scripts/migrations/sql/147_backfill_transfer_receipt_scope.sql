-- Migration: 147_backfill_transfer_receipt_scope.sql
-- Description: Заполнить organization_id / warehouse_id / to_warehouse_id у документов перемещения из stock_movements

UPDATE warehouse_receipts r
SET
  warehouse_id = COALESCE(r.warehouse_id, src.from_warehouse_id, src.movement_warehouse_id),
  to_warehouse_id = COALESCE(r.to_warehouse_id, src.to_warehouse_id),
  organization_id = COALESCE(r.organization_id, src.organization_id, wh_from.organization_id)
FROM (
  SELECT DISTINCT ON ((sm.meta->>'receipt_id')::bigint)
    (sm.meta->>'receipt_id')::bigint AS receipt_id,
    NULLIF(sm.meta->>'from_warehouse_id', '')::bigint AS from_warehouse_id,
    NULLIF(sm.meta->>'to_warehouse_id', '')::bigint AS to_warehouse_id,
    NULLIF(sm.meta->>'organization_id', '')::bigint AS organization_id,
    sm.warehouse_id AS movement_warehouse_id
  FROM stock_movements sm
  WHERE sm.type = 'transfer'
    AND NULLIF(sm.meta->>'receipt_id', '') IS NOT NULL
  ORDER BY (sm.meta->>'receipt_id')::bigint, sm.id DESC
) src
LEFT JOIN warehouses wh_from ON wh_from.id = COALESCE(src.from_warehouse_id, src.movement_warehouse_id)
WHERE r.id = src.receipt_id
  AND r.document_type = 'transfer'
  AND (
    r.warehouse_id IS NULL
    OR r.to_warehouse_id IS NULL
    OR r.organization_id IS NULL
  );
