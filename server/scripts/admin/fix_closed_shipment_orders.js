/**
 * Закрытая поставка: повторно списать остатки и перевести заказы «Собран» → «Отгружен».
 *
 * Usage (from server/):
 *   node scripts/admin/fix_closed_shipment_orders.js <shipmentId>
 *   node scripts/admin/fix_closed_shipment_orders.js --name "Сборка 18.05.2026"
 */

import { closePool } from '../../src/config/database.js';
import shipmentsService from '../../src/services/shipments.service.js';

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('Укажите shipmentId или --name "Название поставки"');
    process.exitCode = 1;
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

main()
  .catch((e) => {
    console.error('[Admin] failed:', e?.message || e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
