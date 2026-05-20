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
    `SELECT id, sku,
            COALESCE(quantity, 0)::int AS quantity,
            COALESCE(incoming_quantity, 0)::int AS incoming_quantity,
            COALESCE(reserved_quantity, 0)::int AS reserved_quantity
     FROM products
     WHERE COALESCE(reserved_quantity, 0) > COALESCE(quantity, 0) + COALESCE(incoming_quantity, 0)
     ORDER BY id
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
