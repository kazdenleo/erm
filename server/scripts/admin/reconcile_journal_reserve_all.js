/**
 * Сверка журнала reserve/unreserve с резервом по заказам и FBO для всех товаров с движениями.
 * Исправляет расхождение «Резерв (N зак.)» при «Сейчас в резерве по журналу: 0».
 *
 * Рекомендуется остановить API на время прогона (меньше блокировок):
 *   pm2 stop erm-api && node scripts/admin/reconcile_journal_reserve_all.js && pm2 start erm-api
 *
 * Usage (from server/): node scripts/admin/reconcile_journal_reserve_all.js
 */

import { query, closePool, getClient } from '../../src/config/database.js';
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
  const client = await getClient();
  try {
    await client.query("SET lock_timeout = '45s'");
    await client.query("SET statement_timeout = '120s'");
  } finally {
    client.release();
  }

  const ids = await collectProductIds();
  console.log(`[Admin] products to scan: ${ids.length}`);

  let touched = 0;
  let reserveAdded = 0;
  let unreserveAdded = 0;
  let scanned = 0;

  for (const pid of ids) {
    scanned += 1;
    const drift = await stockMovementsService.hasJournalReserveDrift(pid).catch(() => false);
    if (!drift) continue;

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
    if (touched % 25 === 0) {
      console.log(`[Admin] progress: scanned=${scanned}/${ids.length} touched=${touched}`);
    }
  }

  console.log(
    `[Admin] done: scanned=${scanned} productsTouched=${touched} reserveAdded=${reserveAdded} unreserveReleased=${unreserveAdded}`
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
