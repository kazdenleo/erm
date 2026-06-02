/**
 * Сверка журнала резерва для одного товара (по id или SKU).
 * Usage: node scripts/admin/reconcile_journal_reserve_one.js 190
 *        node scripts/admin/reconcile_journal_reserve_one.js KN1034K
 */

import { query, closePool } from '../../src/config/database.js';
import stockMovementsService from '../../src/services/stockMovements.service.js';
import {
  NET_RESERVED_SUM_EXPR_SQL,
  RAW_RESERVED_SUM_EXPR_SQL
} from '../../src/constants/netReservedStockSql.js';

async function resolveProductId(arg) {
  const n = Number(arg);
  if (Number.isFinite(n) && n > 0) return n;
  const r = await query('SELECT id, sku FROM products WHERE sku = $1 LIMIT 1', [String(arg).trim()]);
  if (!r.rows?.[0]?.id) throw new Error(`Товар не найден: ${arg}`);
  return Number(r.rows[0].id);
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('Usage: node scripts/admin/reconcile_journal_reserve_one.js <productId|sku>');
    process.exitCode = 1;
    return;
  }
  const pid = await resolveProductId(arg);
  const skuR = await query('SELECT sku FROM products WHERE id = $1', [pid]);
  const sku = skuR.rows?.[0]?.sku ?? '—';

  const before = await query(
    `SELECT ${NET_RESERVED_SUM_EXPR_SQL}::int AS net,
            ${RAW_RESERVED_SUM_EXPR_SQL}::numeric AS raw
     FROM stock_movements WHERE product_id = $1 AND type IN ('reserve', 'unreserve')`,
    [pid]
  );
  console.log(
    `[Admin] pid=${pid} sku=${sku} journal_net_before=${before.rows?.[0]?.net ?? 0} raw=${before.rows?.[0]?.raw ?? 0}`
  );

  const result = await stockMovementsService.reconcileJournalReserveForProduct(pid);
  console.log('[Admin] reconcile:', result);

  const after = await query(
    `SELECT ${NET_RESERVED_SUM_EXPR_SQL}::int AS net,
            ${RAW_RESERVED_SUM_EXPR_SQL}::numeric AS raw
     FROM stock_movements WHERE product_id = $1 AND type IN ('reserve', 'unreserve')`,
    [pid]
  );
  console.log(
    `[Admin] journal_net_after=${after.rows?.[0]?.net ?? 0} raw=${after.rows?.[0]?.raw ?? 0}`
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
