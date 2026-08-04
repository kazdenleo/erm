/**
 * Бэкфилл снимка резерва на заказах (orders.reserved_qty / reserve_need_qty / reserve_coverage).
 *
 * Usage:
 *   node scripts/admin/backfill_order_reserve_snapshots.mjs [--dry-run] [--limit=500] [--status=open]
 */
import ordersService from '../../src/services/orders.service.js';
import { query } from '../../src/config/database.js';

const dryRun = process.argv.includes('--dry-run');
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const batchLimit = Math.min(
  2000,
  Math.max(1, parseInt(limitArg ? limitArg.split('=')[1] : '500', 10) || 500)
);

const OPEN_STATUSES = ['new', 'in_procurement', 'in_assembly', 'wb_assembly', 'assembled'];

async function main() {
  const r = await query(
    `SELECT id
     FROM orders
     WHERE LOWER(TRIM(status)) = ANY($1::text[])
     ORDER BY
       CASE WHEN COALESCE(reserve_snapshot_at, '1970-01-01'::timestamptz) < NOW() - INTERVAL '1 minute'
            AND COALESCE(reserved_qty, 0) = 0 THEN 0 ELSE 1 END,
       created_at DESC NULLS LAST,
       id DESC
     LIMIT $2`,
    [OPEN_STATUSES, batchLimit]
  );
  const ids = (r.rows || []).map((row) => Number(row.id)).filter((id) => id > 0);
  console.log(`[backfill] candidates=${ids.length} dryRun=${dryRun}`);

  if (dryRun || !ids.length) {
    process.exit(0);
  }

  let ok = 0;
  let fail = 0;
  for (const id of ids) {
    try {
      await ordersService.refreshOrderReserveSnapshot(id);
      ok += 1;
      if (ok % 50 === 0) console.log(`[backfill] ok=${ok}/${ids.length}`);
    } catch (e) {
      fail += 1;
      console.warn(`[backfill] id=${id} failed:`, e?.message || e);
    }
  }
  console.log(`[backfill] done ok=${ok} fail=${fail}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
