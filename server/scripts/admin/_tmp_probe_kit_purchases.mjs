import { query, closePool } from '../../src/config/database.js';

const kitSkus = ['DTSN2170-71RL', 'DT-SM-5005-X2'];
const r = await query(
  `SELECT p.id, p.status, pr.sku, pi.expected_quantity, pi.received_quantity,
          GREATEST(0, COALESCE(pi.expected_quantity,0)-COALESCE(pi.received_quantity,0))::int AS pending
   FROM purchase_items pi
   JOIN purchases p ON p.id = pi.purchase_id
   JOIN products pr ON pr.id = pi.product_id
   WHERE UPPER(TRIM(pr.sku)) = ANY($1::text[])
   ORDER BY p.status, p.id DESC
   LIMIT 20`,
  [kitSkus.map((s) => s.toUpperCase())]
);
console.log(r.rows);

const open = await query(
  `SELECT p.id, p.status, p.warehouse_id, pr.sku, pi.expected_quantity, pi.received_quantity,
          GREATEST(0, COALESCE(pi.expected_quantity,0)-COALESCE(pi.received_quantity,0))::int AS pending
   FROM purchase_items pi
   JOIN purchases p ON p.id = pi.purchase_id
   JOIN products pr ON pr.id = pi.product_id
   WHERE p.status = 'open'
     AND GREATEST(0, COALESCE(pi.expected_quantity,0)-COALESCE(pi.received_quantity,0)) > 0
   ORDER BY pr.sku
   LIMIT 50`
);
console.log('all open pending lines', open.rows);

await closePool();
process.exit(0);
