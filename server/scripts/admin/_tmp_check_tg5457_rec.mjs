import { query, closePool } from '../../src/config/database.js';
const r = await query(
  `SELECT pi.purchase_id, p.sku, pi.expected_quantity, pi.received_quantity
   FROM purchase_items pi
   JOIN products p ON p.id = pi.product_id
   WHERE pi.purchase_id = 514 AND p.sku = 'TG-5457'`
);
console.log(JSON.stringify(r.rows));
await closePool();
