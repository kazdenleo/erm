/**
 * One-off: recalc products.reserved_quantity from stock_movements (reserve/unreserve).
 * Useful after manual resets/restore when reserved_quantity might be out of sync.
 *
 * Usage: node scripts/admin/recalc_products_reserved_quantity_from_movements.js
 */

import { query, closePool } from '../../src/config/database.js';

async function main() {
  // Compute per product reserved = sum(-delta) for reserve/unreserve (reserve is negative, unreserve is positive)
  await query(`
    UPDATE products p
    SET reserved_quantity = GREATEST(0, COALESCE(x.reserved, 0)),
        updated_at = CURRENT_TIMESTAMP
    FROM (
      SELECT
        product_id,
        SUM(
          CASE
            WHEN type = 'reserve' THEN -quantity_change
            WHEN type = 'unreserve' THEN -quantity_change
            ELSE 0
          END
        )::int AS reserved
      FROM stock_movements
      WHERE type IN ('reserve', 'unreserve')
      GROUP BY product_id
    ) x
    WHERE p.id = x.product_id
  `);

  // Products without any reserve/unreserve movements -> reserved_quantity=0
  await query(`
    UPDATE products p
    SET reserved_quantity = 0,
        updated_at = CURRENT_TIMESTAMP
    WHERE NOT EXISTS (
      SELECT 1 FROM stock_movements sm
      WHERE sm.product_id = p.id AND sm.type IN ('reserve','unreserve')
    )
  `);

  const check = await query(
    `SELECT COUNT(*)::int AS products,
            SUM(CASE WHEN reserved_quantity > 0 THEN 1 ELSE 0 END)::int AS with_reserved
     FROM products`
  );
  console.log('[Admin] reserved_quantity recalculated:', check.rows?.[0] || {});
}

main()
  .catch((e) => {
    console.error('[Admin] failed:', e?.message || e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });

