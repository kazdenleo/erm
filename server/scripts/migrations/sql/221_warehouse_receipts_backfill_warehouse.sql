-- Поступления, возвраты поставщику и возвраты от клиента создавались без warehouse_id
-- (склад был только в движениях остатков). Восстанавливаем склад документа из последнего
-- движения по нему — тот же склад, который сервис и так брал при отсутствии warehouse_id.
BEGIN;

WITH mv AS (
  SELECT DISTINCT ON (rid) rid, wid
  FROM (
    SELECT (sm.meta->>'receipt_id')::bigint AS rid,
           COALESCE(
             sm.warehouse_id,
             CASE WHEN sm.meta->>'warehouse_id' ~ '^[0-9]+$' THEN (sm.meta->>'warehouse_id')::bigint END
           ) AS wid,
           sm.id AS sm_id
    FROM stock_movements sm
    WHERE sm.meta->>'receipt_id' ~ '^[0-9]+$'
  ) x
  WHERE wid IS NOT NULL
  ORDER BY rid, sm_id DESC
)
UPDATE warehouse_receipts r
SET warehouse_id = mv.wid
FROM mv
JOIN warehouses w ON w.id = mv.wid
WHERE r.id = mv.rid
  AND r.warehouse_id IS NULL
  AND r.document_type IN ('receipt', 'return', 'customer_return');

COMMIT;
