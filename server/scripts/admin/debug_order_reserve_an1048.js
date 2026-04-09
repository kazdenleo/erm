/**
 * Debug helper: inspect product SKU AN1048 and order 4893867727 reserves.
 * Usage: node scripts/admin/debug_order_reserve_an1048.js
 */

import { query, closePool } from '../../src/config/database.js';

async function main() {
  const sku = 'AN1048';
  const orderId = '4893867727';

  const p = await query(
    'SELECT id, sku, name, quantity, incoming_quantity, reserved_quantity FROM products WHERE sku = $1 LIMIT 1',
    [sku]
  );
  const product = p.rows?.[0] || null;
  console.log('product', product);
  if (!product?.id) return;

  const o = await query(
    "SELECT id, marketplace, order_id, status, quantity, product_id, created_at FROM orders WHERE order_id = $1 ORDER BY id DESC LIMIT 5",
    [orderId]
  );
  const order = o.rows?.[0] || null;
  console.log('order', order);

  if (order?.id) {
    const sm = await query(
      `SELECT id, created_at, type, quantity_change, reason, meta
       FROM stock_movements
       WHERE type IN ('reserve','unreserve')
         AND (meta->>'order_id') IS NOT NULL
         AND (meta->>'order_id')::bigint = $1::bigint
       ORDER BY id ASC`,
      [order.id]
    );
    console.log('order reserve movements', sm.rows || []);
  }

  const all = await query(
    `SELECT id, created_at, type, quantity_change, reason, meta
     FROM stock_movements
     WHERE product_id = $1
       AND type IN ('incoming','reserve','unreserve')
     ORDER BY id ASC
     LIMIT 50`,
    [product.id]
  );
  console.log('product movements sample', all.rows || []);

  const agg = await query(
    `SELECT type, SUM(quantity_change)::int AS sum, COUNT(*)::int AS count
     FROM stock_movements
     WHERE product_id = $1 AND type IN ('incoming','reserve','unreserve')
     GROUP BY type
     ORDER BY type`,
    [product.id]
  );
  console.log('agg', agg.rows || []);
}

main()
  .catch((e) => {
    console.error('debug failed', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });

