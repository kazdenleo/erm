/**
 * Debug v2: find orders showing reserve related to KN1034K SKU.
 */

import { query, closePool } from '../../src/config/database.js';

async function main() {
  const sku = 'KN1034K';
  const p = await query('SELECT id, sku FROM products WHERE sku = $1 LIMIT 1', [sku]);
  const pid = p.rows?.[0]?.id;
  console.log('catalog product', p.rows?.[0]);

  // Orders mentioning SKU in any field
  const byText = await query(
    `SELECT o.id, o.marketplace, o.order_id, o.status, o.product_id, o.marketplace_sku, o.offer_id,
            p.sku AS linked_sku,
            COALESCE((
              SELECT GREATEST(0,
                COALESCE(SUM(CASE WHEN sm.type = 'reserve' THEN -sm.quantity_change ELSE 0 END), 0)
                - COALESCE(SUM(CASE WHEN sm.type = 'unreserve' THEN sm.quantity_change ELSE 0 END), 0)
              )::int
              FROM stock_movements sm
              WHERE sm.type IN ('reserve','unreserve') AND sm.meta ? 'order_id'
                AND (sm.meta->>'order_id')::bigint = o.id
            ), 0) AS order_reserved
     FROM orders o
     LEFT JOIN products p ON p.id = o.product_id
     WHERE CAST(o.marketplace_sku AS TEXT) ILIKE $1 OR CAST(o.offer_id AS TEXT) ILIKE $1 OR o.product_name ILIKE $2
        OR p.sku ILIKE $1
     ORDER BY o.created_at DESC
     LIMIT 40`,
    [`%${sku}%`, `%${sku}%`]
  );
  console.log('\norders by text/sku', byText.rows.filter((r) => r.order_reserved > 0));

  // Any reserve movement with product_id != 190 but order line shows KN1034K
  if (pid) {
    const orphan = await query(
      `SELECT sm.id, sm.product_id, p.sku, sm.type, sm.quantity_change, sm.meta,
              o.id AS order_row_id, o.order_id, o.product_id AS order_product_id, op.sku AS order_product_sku
       FROM stock_movements sm
       JOIN orders o ON (sm.meta->>'order_id')::bigint = o.id
       LEFT JOIN products p ON p.id = sm.product_id
       LEFT JOIN products op ON op.id = o.product_id
       WHERE sm.type IN ('reserve','unreserve')
         AND (op.sku = $1 OR o.marketplace_sku ILIKE $2 OR o.product_name ILIKE $3)
         AND sm.product_id IS DISTINCT FROM $4::bigint
       ORDER BY sm.id DESC
       LIMIT 30`,
      [sku, `%${sku}%`, `%${sku}%`, pid]
    );
    console.log('\nreserve on WRONG product_id for KN1034K orders:', orphan.rows);

    const onCatalog = await query(
      `SELECT sm.id, sm.type, sm.quantity_change, sm.meta, o.order_id, o.status
       FROM stock_movements sm
       LEFT JOIN orders o ON (sm.meta->>'order_id')::bigint = o.id
       WHERE sm.product_id = $1::bigint AND sm.type IN ('reserve','unreserve')
       ORDER BY sm.id DESC LIMIT 20`,
      [pid]
    );
    console.log('\nmovements on catalog id', onCatalog.rows);
  }

  // Orders with order-level reserve > 0 and display name like KN1034K via lateral match
  const withJoin = await query(
    `SELECT o.id, o.order_id, o.status, o.product_id, o.marketplace_sku,
            COALESCE(p.sku, pm.matched_product_sku) AS display_sku,
            COALESCE((
              SELECT GREATEST(0,
                COALESCE(SUM(CASE WHEN sm.type = 'reserve' THEN -sm.quantity_change ELSE 0 END), 0)
                - COALESCE(SUM(CASE WHEN sm.type = 'unreserve' THEN sm.quantity_change ELSE 0 END), 0)
              )::int FROM stock_movements sm
              WHERE sm.type IN ('reserve','unreserve') AND sm.meta ? 'order_id'
                AND (sm.meta->>'order_id')::bigint = o.id
            ), 0) AS reserved_qty
     FROM orders o
     LEFT JOIN products p ON o.product_id = p.id
     LEFT JOIN LATERAL (
       SELECT p2.sku AS matched_product_sku
       FROM product_skus ps
       JOIN products p2 ON p2.id = ps.product_id
       WHERE ps.marketplace = o.marketplace
         AND TRIM(ps.sku) = TRIM(CAST(o.marketplace_sku AS TEXT))
       LIMIT 1
     ) pm ON true
     WHERE COALESCE(p.sku, pm.matched_product_sku) = $1
     ORDER BY o.created_at DESC
     LIMIT 30`,
    [sku]
  );
  console.log('\norders with display_sku KN1034K:', withJoin.rows);
  console.log('with reserve:', withJoin.rows.filter((r) => r.reserved_qty > 0));

  const activeIds = ['40661184', '39497037', '38802183', '38802189'];
  for (const oid of activeIds) {
    const sm = await query(
      `SELECT sm.id, sm.product_id, p.sku, sm.type, sm.quantity_change, sm.reason, sm.meta
       FROM stock_movements sm
       LEFT JOIN products p ON p.id = sm.product_id
       WHERE sm.type IN ('reserve', 'unreserve')
         AND (sm.meta->>'order_id')::bigint = $1::bigint
       ORDER BY sm.id`,
      [oid]
    );
    console.log('\nmovements for order row', oid, sm.rows);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closePool());
