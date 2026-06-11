/**
 * Закрытая поставка: повторно списать остатки и перевести заказы «Собран» → «Отгружен».
 *
 * Usage (from server/):
 *   node scripts/admin/fix_closed_shipment_orders.js <shipmentId>
 *   node scripts/admin/fix_closed_shipment_orders.js --name "Сборка 18.05.2026"
 *   node scripts/admin/fix_closed_shipment_orders.js --all
 */

import { closePool } from '../../src/config/database.js';
import shipmentsService from '../../src/services/shipments.service.js';

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('Укажите shipmentId, --name "Название" или --all');
    process.exitCode = 1;
    return;
  }

  if (arg === '--all') {
    const data = await shipmentsService.getShipments({});
    const list = Array.isArray(data?.list)
      ? data.list
      : Object.values(data?.list || {}).flat();
    const closed = (list || []).filter((s) => s.closed && isLocalShipment(s));
    console.log(`[Admin] closed shipments: ${closed.length}`);
    for (const ship of closed) {
      console.log(`[Admin] reapply ${ship.id} (${ship.name || '—'}) orders=${(ship.closedOrderIds || ship.orderIds || []).length}`);
      const result = await shipmentsService.reapplyStockForShipment(ship.id, {});
      console.log('[Admin]  ->', JSON.stringify(result));
    }
    return;
  }

  let shipmentId = arg;
  if (arg === '--name') {
    const name = process.argv.slice(3).join(' ').trim();
    if (!name) {
      console.error('Укажите название после --name');
      process.exitCode = 1;
      return;
    }
    const list = await shipmentsService.getShipments({});
    const hit = (list || []).find(
      (s) => s.closed && String(s.name || '').trim() === name
    );
    if (!hit) {
      console.error(`Закрытая поставка с именем «${name}» не найдена`);
      process.exitCode = 1;
      return;
    }
    shipmentId = hit.id;
    console.log(`[Admin] shipment id=${shipmentId} name=${hit.name}`);
  }

  const result = await shipmentsService.reapplyStockForShipment(shipmentId, {});
  console.log('[Admin] done:', JSON.stringify(result, null, 2));
}

function isLocalShipment(shipment) {
  return shipment?.id && String(shipment.id).startsWith('ship-');
}

main()
  .catch((e) => {
    console.error('[Admin] failed:', e?.message || e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
