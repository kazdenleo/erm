/**
 * Диагностика: резерв на одном складе, отгрузка на другом.
 * Usage: node scripts/admin/debug_wb_wh_mismatch.js [productId]
 */
import { query, closePool } from '../../src/config/database.js';

async function main() {
  const productId = Number(process.argv[2] || 319);

  const pws = await query(
    `SELECT warehouse_id, quantity
     FROM product_warehouse_stock WHERE product_id = $1 ORDER BY warehouse_id`,
    [productId]
  );
  console.log('PWS product', productId, pws.rows);

  const mismatches = await query(
    `WITH order_wh AS (
       SELECT (meta->>'order_id')::bigint AS order_db_id,
              product_id,
              warehouse_id,
              SUM(CASE WHEN type = 'reserve' THEN -quantity_change
                       WHEN type = 'unreserve' THEN quantity_change ELSE 0 END)::int AS net_reserve
       FROM stock_movements
       WHERE type IN ('reserve', 'unreserve')
         AND warehouse_id IS NOT NULL
         AND (meta->>'order_id') IS NOT NULL
       GROUP BY 1, 2, 3
       HAVING SUM(CASE WHEN type = 'reserve' THEN -quantity_change
                       WHEN type = 'unreserve' THEN quantity_change ELSE 0 END) > 0
     ),
     ship_wh AS (
       SELECT (meta->>'order_id')::bigint AS order_db_id,
              product_id,
              warehouse_id,
              SUM(CASE WHEN type = 'shipment' THEN -quantity_change ELSE 0 END)::int AS shipped
       FROM stock_movements
       WHERE type = 'shipment'
         AND warehouse_id IS NOT NULL
         AND (meta->>'order_id') IS NOT NULL
       GROUP BY 1, 2, 3
       HAVING SUM(CASE WHEN type = 'shipment' THEN -quantity_change ELSE 0 END) > 0
     )
     SELECT o.order_db_id, ord.order_id AS mp_order_id, o.product_id, o.warehouse_id AS reserve_wh,
            o.net_reserve, s.warehouse_id AS ship_wh, s.shipped
     FROM order_wh o
     JOIN ship_wh s ON s.order_db_id = o.order_db_id AND s.product_id = o.product_id
     JOIN orders ord ON ord.id = o.order_db_id
     WHERE o.warehouse_id IS DISTINCT FROM s.warehouse_id
     ORDER BY o.order_db_id DESC
     LIMIT 50`
  );
  console.log('\nMismatches (sample):', mismatches.rows.length);
  for (const row of mismatches.rows) {
    console.log(row);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closePool());
