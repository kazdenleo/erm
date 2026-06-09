/**
 * Диагностика резерва/отгрузки по заказам (запуск на VPS).
 * node scripts/debug-order-reserve.js [order_id ...]
 */
import { query } from '../src/config/database.js';
import { NET_RESERVED_SUM_EXPR_SQL } from '../src/constants/netReservedStockSql.js';

const oids = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['69622551-0459-1', '5162763974', '0176680784-0060-1', '5153647323', '5150877340'];

for (const oid of oids) {
  const o = await query(
    `SELECT id, marketplace, order_id, status, quantity, product_id
     FROM orders WHERE order_id = $1 ORDER BY id DESC LIMIT 1`,
    [oid]
  );
  const row = o.rows[0];
  if (!row) {
    console.log('NO ORDER', oid);
    continue;
  }
  const sm = await query(
    `SELECT id, product_id, type, quantity_change, warehouse_id, reason, created_at
     FROM stock_movements
     WHERE (meta->>'order_id')::bigint = $1::bigint
     ORDER BY id`,
    [row.id]
  );
  const net = await query(
    `SELECT product_id, ${NET_RESERVED_SUM_EXPR_SQL}::int AS net
     FROM stock_movements
     WHERE (meta->>'order_id')::bigint = $1::bigint
       AND type IN ('reserve', 'unreserve')
     GROUP BY product_id
     HAVING ${NET_RESERVED_SUM_EXPR_SQL} > 0`,
    [row.id]
  );
  const p = await query(`SELECT id, sku, quantity, reserved_quantity FROM products WHERE id = $1`, [
    row.product_id
  ]);
  console.log('\n---', oid, 'db', row.id, 'status', row.status, 'pid', row.product_id);
  console.log('product:', p.rows[0]);
  console.log('reserve net (correct):', net.rows);
  for (const m of sm.rows || []) {
    console.log(
      ' ',
      m.type,
      'pid',
      m.product_id,
      'qty',
      m.quantity_change,
      'wh',
      m.warehouse_id,
      (m.reason || '').slice(0, 80)
    );
  }
}

process.exit(0);
