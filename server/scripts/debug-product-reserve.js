import { query } from '../src/config/database.js';
import { NET_RESERVED_SUM_EXPR_SQL } from '../src/constants/netReservedStockSql.js';

const pid = Number(process.argv[2] || 182);

const comps = await query(
  `SELECT component_product_id, quantity FROM kit_components WHERE kit_product_id = $1`,
  [pid]
);
console.log('kit', pid, 'components', comps.rows);

const scope = `product_id = $1 OR product_id IN (SELECT component_product_id FROM kit_components WHERE kit_product_id = $1)`;

const orders = await query(
  `WITH order_ids AS (
     SELECT DISTINCT (meta->>'order_id')::bigint AS oid
     FROM stock_movements
     WHERE (${scope}) AND type IN ('reserve','unreserve')
       AND (meta->>'order_id') ~ '^[0-9]+$'
   )
   SELECT oi.oid, o.order_id, o.status,
          (SELECT ${NET_RESERVED_SUM_EXPR_SQL}::int FROM stock_movements sm
           WHERE sm.product_id = $1 AND sm.type IN ('reserve','unreserve')
             AND (sm.meta->>'order_id')::bigint = oi.oid) AS kit_net
   FROM order_ids oi
   LEFT JOIN orders o ON o.id = oi.oid
   ORDER BY oi.oid DESC`,
  [pid]
);

console.log('\nPer-order kit SKU net:');
for (const r of orders.rows) {
  console.log(r.order_id, r.status, 'kit_net', r.kit_net);
}

const global = await query(
  `SELECT ${NET_RESERVED_SUM_EXPR_SQL}::int AS net FROM stock_movements
   WHERE product_id = $1 AND type IN ('reserve','unreserve')`,
  [pid]
);
console.log('\nGlobal kit net from journal:', global.rows[0]?.net);
console.log('products.reserved_quantity:', (await query('SELECT reserved_quantity, quantity FROM products WHERE id=$1',[pid])).rows[0]);

process.exit(0);
