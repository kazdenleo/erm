/**
 * Исправить reserved_after у движений «Сверка журнала» — в INSERT снимок мог завышаться.
 * Usage: node scripts/admin/fix_reconcile_movement_reserved_after.js [productId]
 */

import { query, closePool } from '../../src/config/database.js';
import { NET_RESERVED_SUM_EXPR_SQL } from '../../src/constants/netReservedStockSql.js';

async function main() {
  const pidArg = process.argv[2];
  const pidFilter = pidArg ? Number(pidArg) : null;
  if (pidArg && (!Number.isFinite(pidFilter) || pidFilter < 1)) {
    console.error('Usage: node scripts/admin/fix_reconcile_movement_reserved_after.js [productId]');
    process.exitCode = 1;
    return;
  }

  const idsR = await query(
    `SELECT DISTINCT product_id AS id
     FROM stock_movements
     WHERE (meta->>'journal_reconcile')::boolean IS TRUE
       OR reason LIKE 'Сверка журнала%'
       ${pidFilter ? 'AND product_id = $1' : ''}`,
    pidFilter ? [pidFilter] : []
  );
  const productIds = (idsR.rows || []).map((r) => Number(r.id)).filter((id) => id > 0);
  let updated = 0;

  for (const pid of productIds) {
    const movR = await query(
      `SELECT id FROM stock_movements
       WHERE product_id = $1 AND type IN ('reserve', 'unreserve')
       ORDER BY id`,
      [pid]
    );
    for (const row of movR.rows || []) {
      const mid = Number(row.id);
      const netR = await query(
        `SELECT ${NET_RESERVED_SUM_EXPR_SQL}::int AS rv
         FROM stock_movements
         WHERE product_id = $1 AND type IN ('reserve', 'unreserve') AND id <= $2`,
        [pid, mid]
      );
      const rv = Number(netR.rows?.[0]?.rv ?? 0) || 0;
      const u = await query(
        `UPDATE stock_movements SET reserved_after = $1 WHERE id = $2 AND reserved_after IS DISTINCT FROM $1`,
        [rv, mid]
      );
      updated += u.rowCount || 0;
    }
  }

  console.log(`[Admin] products=${productIds.length} movement rows updated=${updated}`);
}

main()
  .catch((e) => {
    console.error('[Admin] failed:', e?.message || e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
