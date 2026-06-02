/**
 * Сверка журнала reserve/unreserve с резервом по заказам и FBO для всех товаров с движениями.
 * Исправляет расхождение «Резерв (N зак.)» при «Сейчас в резерве по журналу: 0».
 *
 * Usage (from server/): node scripts/admin/reconcile_journal_reserve_all.js
 */

import { query, closePool } from '../../src/config/database.js';
import stockMovementsService from '../../src/services/stockMovements.service.js';

async function collectProductIds() {
  const r = await query(
    `SELECT DISTINCT product_id AS id
     FROM stock_movements
     WHERE type IN ('reserve', 'unreserve')
       AND product_id IS NOT NULL
     UNION
     SELECT DISTINCT kc.kit_product_id AS id
     FROM kit_components kc
     INNER JOIN stock_movements sm ON sm.product_id = kc.component_product_id
     WHERE sm.type IN ('reserve', 'unreserve')
       AND kc.kit_product_id IS NOT NULL
     ORDER BY id`
  );
  return (r.rows || [])
    .map((row) => Number(row.id))
    .filter((id) => Number.isFinite(id) && id > 0);
}

async function main() {
  const ids = await collectProductIds();
  console.log(`[Admin] products to reconcile: ${ids.length}`);

  let touched = 0;
  let reserveAdded = 0;
  let unreserveAdded = 0;

  for (const pid of ids) {
    const result = await stockMovementsService.reconcileJournalReserveForProduct(pid).catch((e) => {
      console.warn(`[Admin] pid=${pid} failed:`, e?.message || e);
      return null;
    });
    if (!result || result.lines === 0) continue;
    touched += 1;
    reserveAdded += result.reserveAdded || 0;
    unreserveAdded += result.unreserveAdded || 0;
    console.log(
      `[Admin] pid=${pid} lines=${result.lines} +reserve=${result.reserveAdded || 0} -reserve=${result.unreserveAdded || 0}`
    );
  }

  console.log(
    `[Admin] done: productsTouched=${touched} reserveAdded=${reserveAdded} unreserveReleased=${unreserveAdded}`
  );
}

main()
  .catch((e) => {
    console.error('[Admin] failed:', e?.message || e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
