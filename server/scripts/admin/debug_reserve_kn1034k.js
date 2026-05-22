/**
 * Debug: KN1034K reserve mismatch (orders vs stock list).
 * Usage: node scripts/admin/debug_reserve_kn1034k.js
 */

import { query, closePool } from '../../src/config/database.js';

async function main() {
  const sku = 'KN1034K';

  const p = await query(
    'SELECT id, sku, name, product_type, quantity, incoming_quantity, reserved_quantity FROM products WHERE sku = $1 LIMIT 1',
    [sku]
  );
  const product = p.rows?.[0] || null;
  console.log('product', product);
  if (!product?.id) return;

  const pid = product.id;

  const aggProduct = await query(
    `SELECT GREATEST(0, COALESCE(SUM(
       CASE
         WHEN type = 'reserve' THEN -(quantity_change::numeric)
         WHEN type = 'unreserve' THEN -(quantity_change::numeric)
         ELSE 0
       END
     ), 0))::int AS rv
     FROM stock_movements
     WHERE product_id = $1 AND type IN ('reserve', 'unreserve')`,
    [pid]
  );
  console.log('journal_agg_for_product', aggProduct.rows?.[0]);

  const kitCheck = await query(
    `SELECT 'parent' AS role, kit_product_id FROM kit_components WHERE kit_product_id = $1
     UNION ALL
     SELECT 'component' AS role, kit_product_id FROM kit_components WHERE component_product_id = $1`,
    [pid]
  );
  console.log('kit_roles', kitCheck.rows);

  const orders = await query(
    `SELECT o.id, o.marketplace, o.order_id, o.status, o.quantity, o.product_id,
       COALESCE((
         SELECT GREATEST(0,
           COALESCE(SUM(CASE WHEN sm.type = 'reserve' THEN -sm.quantity_change ELSE 0 END), 0)
           - COALESCE(SUM(CASE WHEN sm.type = 'unreserve' THEN sm.quantity_change ELSE 0 END), 0)
         )::int
         FROM stock_movements sm
         WHERE (sm.type IN ('reserve', 'unreserve'))
           AND sm.meta ? 'order_id'
           AND (sm.meta->>'order_id')::bigint = o.id
       ), 0) AS order_level_reserved,
       COALESCE((
         SELECT GREATEST(0,
           COALESCE(SUM(CASE WHEN sm.type = 'reserve' THEN -sm.quantity_change ELSE 0 END), 0)
           - COALESCE(SUM(CASE WHEN sm.type = 'unreserve' THEN sm.quantity_change ELSE 0 END), 0)
         )::int
         FROM stock_movements sm
         WHERE sm.product_id = $1::bigint
           AND (sm.type IN ('reserve', 'unreserve'))
           AND sm.meta ? 'order_id'
           AND (sm.meta->>'order_id')::bigint = o.id
       ), 0) AS product_level_reserved
     FROM orders o
     WHERE o.product_id = $1::bigint
        OR EXISTS (
          SELECT 1 FROM product_skus ps
          WHERE ps.product_id = $1::bigint AND ps.marketplace = o.marketplace
            AND TRIM(ps.sku) = TRIM(CAST(o.marketplace_sku AS TEXT))
        )
     ORDER BY o.created_at DESC
     LIMIT 30`,
    [pid]
  );

  const withReserve = (orders.rows || []).filter(
    (r) => r.order_level_reserved > 0 || r.product_level_reserved > 0
  );
  console.log('orders_with_reserve', withReserve.length);
  console.log(JSON.stringify(withReserve, null, 2));

  const mismatched = withReserve.filter((r) => r.order_level_reserved > 0 && r.product_level_reserved === 0);
  if (mismatched.length) {
    console.log('\nMISMATCH (order shows reserve but not on this product_id):');
    for (const row of mismatched.slice(0, 5)) {
      const sm = await query(
        `SELECT id, product_id, type, quantity_change, meta
         FROM stock_movements
         WHERE type IN ('reserve', 'unreserve')
           AND (meta->>'order_id')::bigint = $1
         ORDER BY id`,
        [row.id]
      );
      console.log('order', row.order_id, 'movements', sm.rows);
    }
  }
}

main()
  .catch((e) => {
    console.error('debug failed', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
