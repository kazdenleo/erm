import { query } from '../../src/config/database.js';

const ids = ['82336551-0198-1', '6122079446', '0135642938-0161-1'];

const counts = await query(
  `SELECT status, count(*)::int AS n
   FROM orders
   WHERE profile_id = 1
     AND status IN ('new','in_assembly','wb_assembly','unknown','__wb_status_pending__')
   GROUP BY status
   ORDER BY n DESC`
);
console.log('ELIGIBLE', JSON.stringify(counts.rows));

const older = await query(
  `SELECT count(*)::int AS n
   FROM orders
   WHERE profile_id = 1
     AND created_at < '2026-10-24T18:03:41Z'
     AND (
       status IN ('new','in_assembly','wb_assembly','unknown')
       OR (marketplace = 'wb' AND (status = '__wb_status_pending__' OR LOWER(status) = 'wb_status_unknown'))
     )
     AND (
       product_id IS NOT NULL
       OR NULLIF(BTRIM(COALESCE(offer_id::text, '')), '') IS NOT NULL
       OR NULLIF(BTRIM(COALESCE(marketplace_sku::text, '')), '') IS NOT NULL
     )`
);
console.log('OLDER_THAN_KN1009K', JSON.stringify(older.rows));

const hits = await query(
  `SELECT pu.id, pu.status, pu.supplier_id, pi.product_id, pi.expected_quantity, pi.received_quantity
   FROM purchase_items pi
   JOIN purchases pu ON pu.id = pi.purchase_id
   WHERE pi.source_orders::text ILIKE ANY($1::text[])
   ORDER BY pu.id DESC
   LIMIT 20`,
  [ids.map((id) => `%${id}%`)]
);
console.log('PURCHASE_HITS', JSON.stringify(hits.rows));

const openLines = await query(
  `SELECT pi.product_id, pr.sku, pu.supplier_id,
          SUM(GREATEST(0, pi.expected_quantity - COALESCE(pi.received_quantity, 0)))::int AS open_qty
   FROM purchase_items pi
   JOIN purchases pu ON pu.id = pi.purchase_id
   JOIN products pr ON pr.id = pi.product_id
   WHERE LOWER(TRIM(pu.status)) = 'open'
     AND pi.product_id = ANY($1::bigint[])
   GROUP BY pi.product_id, pr.sku, pu.supplier_id
   ORDER BY pr.sku`,
  [[32, 168, 190]]
);
console.log('OPEN_HOLD', JSON.stringify(openLines.rows));

const wh = await query(
  `SELECT s.id, s.name,
          w->>'name' AS warehouse,
          w->>'time' AS time_until,
          w->>'timeAfter' AS time_after
   FROM suppliers s
   CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.api_config->'warehouses', '[]'::jsonb)) w
   WHERE s.id = 1`
);
console.log('CUTOFFS', JSON.stringify(wh.rows));

process.exit(0);
