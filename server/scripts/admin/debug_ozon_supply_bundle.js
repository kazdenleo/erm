/**
 * Диагностика Ozon bundle/details для заявок на поставку.
 * Запуск на VPS: cd /opt/erm/server && node scripts/admin/debug_ozon_supply_bundle.js 2000055152106
 */
import integrationsService from '../../src/services/integrations.service.js';

const nums = process.argv.slice(2);
if (!nums.length) {
  console.error('Usage: node scripts/admin/debug_ozon_supply_bundle.js <supply_order_number> ...');
  process.exit(1);
}

const get = await integrationsService._ozonApiPost('/v3/supply-order/get', { order_ids: nums }, {});
const orders = get?.result?.orders ?? get?.orders ?? [];
console.log('orders', orders.length, 'warehouses', (get?.result?.warehouses ?? []).length);

for (const o of orders) {
  const num = o.supply_order_number ?? o.order_number;
  const oid = o.supply_order_id ?? o.order_id ?? o.id;
  console.log('\nORDER', num, 'oid', oid, 'state', o.state, 'supplies', (o.supplies ?? []).length);
  for (const s of o.supplies ?? []) {
    console.log('  supply_id', s.supply_id ?? s.id, 'bundle_id', s.bundle_id, 'wh', s.storage_warehouse_id);
    if (!s.bundle_id) continue;
    for (const limit of [100, 1000]) {
      try {
        const b = await integrationsService._ozonApiPost(
          '/v1/supply-order/bundle',
          { bundle_ids: [String(s.bundle_id)], limit },
          {}
        );
        const r = b?.result ?? b;
        console.log(`  bundle limit=${limit} items`, (r.items ?? []).length, 'total', r.total_count, 'has_next', r.has_next, 'last_id', r.last_id);
      } catch (e) {
        console.log(`  bundle limit=${limit} ERROR`, e.message);
      }
    }
  }
  try {
    const d = await integrationsService._ozonApiPost('/v1/supply-order/details', { supply_order_id: Number(oid) || oid }, {});
    const r = d?.result ?? d;
    console.log('  details keys', Object.keys(r).slice(0, 20).join(','));
    console.log('  details sample', JSON.stringify(r).slice(0, 500));
  } catch (e) {
    console.log('  details ERROR', e.message);
  }
}
