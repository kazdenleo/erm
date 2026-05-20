/**
 * Снять избыточный резерв: reserved_quantity > quantity + incoming_quantity.
 * Полезно после исправления резерва (без остатков поставщиков).
 *
 * Usage (from server/): node scripts/admin/trim_excess_reserves_all.js
 */

import { query, closePool } from '../../src/config/database.js';
import ordersService from '../../src/services/orders.service.js';

async function main() {
  const r = await query(
    `SELECT p.id, p.sku
     FROM products p
     WHERE (
       SELECT GREATEST(0, COALESCE(SUM(
         CASE
           WHEN sm.type = 'reserve' THEN -(sm.quantity_change::numeric)
           WHEN sm.type = 'unreserve' THEN -(sm.quantity_change::numeric)
           ELSE 0
         END
       ), 0))::int
       FROM stock_movements sm
       WHERE sm.product_id = p.id AND sm.type IN ('reserve', 'unreserve')
     ) > (
       COALESCE((
         SELECT SUM(pws.quantity)::int FROM product_warehouse_stock pws WHERE pws.product_id = p.id
       ), 0) + COALESCE(p.incoming_quantity, 0)
     )
     ORDER BY p.id
     LIMIT 5000`
  );
  const rows = r.rows || [];
  console.log(`[Admin] products with excess reserve: ${rows.length}`);

  let totalReleased = 0;
  let productsTouched = 0;
  for (const row of rows) {
    const pid = Number(row.id);
    if (!Number.isFinite(pid) || pid < 1) continue;
    const result = await ordersService.trimExcessReservesForProduct(pid, {
      reason: 'Снятие избыточного резерва (нет покрытия складом и «в пути»)',
      meta: { source: 'admin_trim_excess_reserves_all' }
    });
    if ((result?.released ?? 0) > 0) {
      productsTouched++;
      totalReleased += result.released;
      console.log(
        `[Admin] pid=${pid} sku=${row.sku ?? '—'} released=${result.released} orders=${result.ordersTouched}`
      );
    }
  }
  console.log(`[Admin] done: products=${productsTouched} unitsReleased=${totalReleased}`);
}

main()
  .catch((e) => {
    console.error('[Admin] failed:', e?.message || e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
