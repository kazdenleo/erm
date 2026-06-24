/**
 * Резерв по заказам из meta движений (без зависимости от kitStock / sellableQuantity).
 */
import { query } from '../config/database.js';
import {
  NET_RESERVED_SUM_EXPR_SQL,
  parseStockMovementWarehouseId,
  stockMovementMetaOrderKeySql,
} from '../constants/netReservedStockSql.js';

export function mergeJournalAndOrderAttributedReserved(journalQty, orderAttributedQty) {
  const j = Math.max(0, Math.floor(Number(journalQty) || 0));
  const o = Math.max(0, Math.floor(Number(orderAttributedQty) || 0));
  return Math.max(j, o);
}

/**
 * Сумма положительных нетто-резервов по заказам (meta order_id / orderId).
 */
export async function batchOrderAttributedReservedMap(productIds, opts = {}) {
  const ids = [...new Set((productIds || []).map((id) => Number(id)).filter((id) => id > 0))];
  if (!ids.length) return new Map();

  const whId = parseStockMovementWarehouseId(opts.warehouseId ?? opts.warehouse_id);
  const meta = stockMovementMetaOrderKeySql('');
  const params = [ids];
  let whSql = '';
  if (whId != null) {
    params.push(whId);
    whSql = ` AND warehouse_id = $${params.length}`;
  }

  const r = await query(
    `SELECT product_id, COALESCE(SUM(sub.rv), 0)::int AS total
     FROM (
       SELECT product_id,
         ${NET_RESERVED_SUM_EXPR_SQL}::int AS rv
       FROM stock_movements
       WHERE product_id = ANY($1::bigint[])
         AND type IN ('reserve', 'unreserve')
         AND ${meta} IS NOT NULL
         AND TRIM(${meta}) <> ''${whSql}
       GROUP BY product_id, ${meta}
       HAVING ${NET_RESERVED_SUM_EXPR_SQL} > 0
     ) sub
     GROUP BY product_id`,
    params
  );
  return new Map((r.rows || []).map((row) => [Number(row.product_id), Number(row.total) || 0]));
}
