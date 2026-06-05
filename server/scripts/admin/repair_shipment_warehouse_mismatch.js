/**
 * Восстановление остатков: резерв на одном складе, списание при закрытии поставки — на другом.
 *
 * Usage (from server/):
 *   node scripts/admin/repair_shipment_warehouse_mismatch.js
 *   node scripts/admin/repair_shipment_warehouse_mismatch.js --apply
 *   node scripts/admin/repair_shipment_warehouse_mismatch.js --apply --order 5143153826
 */
import { query, closePool } from '../../src/config/database.js';
import stockMovementsService from '../../src/services/stockMovements.service.js';
import { getNetReservedForOrderProduct } from '../../src/services/kitStock.service.js';

const MISMATCH_SQL = `
WITH order_wh AS (
  SELECT (meta->>'order_id')::bigint AS order_db_id,
         product_id,
         warehouse_id,
         SUM(CASE WHEN type = 'reserve' THEN -quantity_change
                  WHEN type = 'unreserve' THEN quantity_change ELSE 0 END)::int AS net_reserve
  FROM stock_movements
  WHERE type IN ('reserve', 'unreserve')
    AND warehouse_id IS NOT NULL
    AND (meta->>'order_id') IS NOT NULL
  GROUP BY 1, 2, 3
  HAVING SUM(CASE WHEN type = 'reserve' THEN -quantity_change
                  WHEN type = 'unreserve' THEN quantity_change ELSE 0 END) > 0
),
ship_wh AS (
  SELECT (meta->>'order_id')::bigint AS order_db_id,
         product_id,
         warehouse_id,
         SUM(CASE WHEN type = 'shipment' THEN -quantity_change ELSE 0 END)::int AS shipped
  FROM stock_movements
  WHERE type = 'shipment'
    AND warehouse_id IS NOT NULL
    AND (meta->>'order_id') IS NOT NULL
    AND COALESCE(meta->>'repair_shipment_wh_mismatch', '') <> 'correct'
  GROUP BY 1, 2, 3
  HAVING SUM(CASE WHEN type = 'shipment' THEN -quantity_change ELSE 0 END) > 0
)
SELECT o.order_db_id, ord.order_id AS mp_order_id, o.product_id, o.warehouse_id AS reserve_wh,
       o.net_reserve, s.warehouse_id AS ship_wh, s.shipped
FROM order_wh o
JOIN ship_wh s ON s.order_db_id = o.order_db_id AND s.product_id = o.product_id
JOIN orders ord ON ord.id = o.order_db_id
WHERE o.warehouse_id IS DISTINCT FROM s.warehouse_id
ORDER BY o.order_db_id DESC`;

async function alreadyRepaired(orderDbId, productId) {
  const r = await query(
    `SELECT 1 FROM stock_movements
     WHERE (meta->>'order_id')::bigint = $1
       AND product_id = $2
       AND COALESCE(meta->>'repair_shipment_wh_mismatch', '') = 'correct'
     LIMIT 1`,
    [orderDbId, productId]
  );
  return (r.rows?.length ?? 0) > 0;
}

async function repairRow(row, apply) {
  const orderDbId = Number(row.order_db_id);
  const productId = Number(row.product_id);
  const reserveWh = Number(row.reserve_wh);
  const shipWh = Number(row.ship_wh);
  const fixQty = Math.max(0, Number(row.shipped) || 0);
  const mpOrderId = String(row.mp_order_id || '');

  if (!apply) {
    console.log('[dry-run]', {
      mpOrderId,
      productId,
      reserveWh,
      shipWh,
      netReserve: row.net_reserve,
      fixQty
    });
    return { dryRun: true };
  }

  if (await alreadyRepaired(orderDbId, productId)) {
    console.log('[skip] already repaired', mpOrderId, productId);
    return { skipped: true };
  }

  const metaBase = {
    order_id: orderDbId,
    orderId: mpOrderId,
    repair_shipment_wh_mismatch: 'correct',
    repair_from_ship_wh: shipWh,
    repair_to_reserve_wh: reserveWh
  };

  await stockMovementsService.applyChange(productId, {
    delta: fixQty,
    type: 'manual',
    reason: `Восстановление: отмена ошибочного списания (склад ${shipWh}) по заказу ${mpOrderId}`,
    meta: { ...metaBase, warehouse_id: shipWh }
  });

  const netOnReserve = await getNetReservedForOrderProduct(
    orderDbId,
    productId,
    mpOrderId,
    reserveWh
  );
  if (netOnReserve > 0) {
    const release = Math.min(netOnReserve, fixQty);
    await stockMovementsService.applyChange(productId, {
      delta: release,
      type: 'unreserve',
      reason: `Восстановление: снятие резерва (склад ${reserveWh}) по заказу ${mpOrderId}`,
      meta: { ...metaBase, warehouse_id: reserveWh }
    });
  }

  await stockMovementsService.applyChange(productId, {
    delta: -fixQty,
    type: 'shipment',
    reason: `Восстановление: списание на верном складе (${reserveWh}) по заказу ${mpOrderId}`,
    meta: { ...metaBase, warehouse_id: reserveWh, assembled: true }
  });

  console.log('[fixed]', mpOrderId, 'product', productId, 'qty', fixQty, `${shipWh}→${reserveWh}`);
  return { fixed: true, fixQty };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const orderFilter = (() => {
    const i = process.argv.indexOf('--order');
    return i >= 0 ? String(process.argv[i + 1] || '').trim() : '';
  })();

  let rows = (await query(MISMATCH_SQL)).rows || [];
  if (orderFilter) {
    rows = rows.filter((r) => String(r.mp_order_id) === orderFilter);
  }

  console.log(`[Admin] mismatches: ${rows.length}, mode: ${apply ? 'APPLY' : 'dry-run'}`);
  let fixed = 0;
  for (const row of rows) {
    const res = await repairRow(row, apply);
    if (res.fixed) fixed += 1;
  }
  console.log(`[Admin] done, fixed: ${fixed}`);
}

main()
  .catch((e) => {
    console.error('[Admin] failed:', e?.message || e);
    process.exitCode = 1;
  })
  .finally(() => closePool());
