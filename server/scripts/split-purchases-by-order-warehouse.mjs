/**
 * Разово разнести открытые закупки по складам заказов и перерезервировать перенесённые заказы.
 * Запуск: node scripts/split-purchases-by-order-warehouse.mjs [profileId=1]
 */
import { query, closePool } from '../src/config/database.js';
import purchasesService from '../src/services/purchases.service.js';
import ordersService from '../src/services/orders.service.js';

const profileId = Number(process.argv[2]) || 1;

const result = await purchasesService.splitOpenPurchasesByOrderWarehouse({
  profileId,
  scheduleReserve: false,
});
console.log(`Проверено открытых закупок: ${result.checked}, разнесено: ${result.split}`);
for (const r of result.results) {
  if (r.error) {
    console.log(`  №${r.purchaseId}: ошибка — ${r.error}`);
    continue;
  }
  const targets = r.targets.map((t) => `№${t.purchaseId}${t.created ? ' (новая)' : ''} склад ${t.warehouseId}`);
  console.log(`  №${r.purchaseId} → ${targets.join(', ')}${r.sourceDeleted ? ', исходная удалена' : ''}`);
  for (const m of r.moved) {
    console.log(`    товар ${m.productId}: ${m.quantity} шт., заказы ${m.orders.join(', ')}`);
  }
}

const orderIds = [...new Set(result.results.flatMap((r) => r.moved.flatMap((m) => m.orders.map(String))))];
if (orderIds.length) {
  const rows = (
    await query(
      `SELECT * FROM orders
       WHERE profile_id = $1 AND (order_id::text = ANY($2::text[]) OR order_group_id::text = ANY($2::text[]))`,
      [profileId, orderIds]
    )
  ).rows;
  await ordersService._reapplyReserveForOrderRows(rows, { allowDespiteManualUnreserve: true });

  const reserved = await query(
    `SELECT o.order_id,
            COALESCE(SUM(CASE WHEN sm.type = 'reserve' THEN ABS(sm.quantity_change)
                              WHEN sm.type = 'unreserve' THEN -ABS(sm.quantity_change) ELSE 0 END), 0)::int AS net,
            MAX(sm.warehouse_id) AS warehouse_id
     FROM orders o
     LEFT JOIN stock_movements sm
       ON sm.type IN ('reserve', 'unreserve')
      AND (sm.meta->>'order_id' = o.id::text OR sm.meta->>'orderId' = o.order_id::text)
     WHERE o.id = ANY($1::bigint[])
     GROUP BY o.order_id
     ORDER BY o.order_id`,
    [rows.map((r) => r.id)]
  );
  console.log('Резерв перенесённых заказов (нетто, склад):');
  for (const r of reserved.rows) console.log(`  ${r.order_id}: ${r.net} шт., склад ${r.warehouse_id ?? '—'}`);
}

await closePool();
process.exit(0);
