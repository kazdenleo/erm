import { getPool } from '../../src/config/database.js';
import ordersSyncService from '../../src/services/orders.sync.service.js';

const pool = await getPool();

const counts = await pool.query(`
  SELECT marketplace, status, COUNT(*)::int AS n
  FROM orders
  WHERE profile_id = 6
    AND status IN ('new','in_assembly','assembled','in_transit','shipped','cancelled','delivered')
  GROUP BY 1, 2
  ORDER BY 1, 2
`);
console.log('counts', counts.rows);

const before = ordersSyncService.getSyncFbsStatus?.() ?? ordersSyncService.getStatus?.();
console.log('sync before', before);

if (typeof ordersSyncService.clearSyncFbsLock === 'function') {
  ordersSyncService.clearSyncFbsLock();
  console.log('cleared sync lock');
}

const after = ordersSyncService.getSyncFbsStatus?.() ?? null;
console.log('sync after clear', after);

// Trigger status refresh only (catch-up)
try {
  const r = await ordersSyncService.syncAllFbsOrders({
    profileId: 6,
    refreshStatuses: true,
    catchUpLimit: 200,
    daysBack: 14,
  });
  console.log('refresh result keys', r && Object.keys(r));
  console.log('ozon', r?.ozon && { success: r.ozon.success, failed: r.ozon.failed, n: r.ozon.orders?.length });
  console.log('wb', r?.wildberries && { success: r.wildberries.success, failed: r.wildberries.failed, n: r.wildberries.orders?.length });
  console.log('ym', r?.yandex && { success: r.yandex.success, failed: r.yandex.failed, n: r.yandex.orders?.length });
  const ymStatuses = {};
  for (const o of r?.yandex?.orders || []) {
    ymStatuses[o.status] = (ymStatuses[o.status] || 0) + 1;
  }
  const wbStatuses = {};
  for (const o of r?.wildberries?.orders || []) {
    wbStatuses[o.status] = (wbStatuses[o.status] || 0) + 1;
  }
  console.log('ym status breakdown', ymStatuses);
  console.log('wb status breakdown', wbStatuses);
} catch (e) {
  console.error('refresh error', e?.message || e);
}

const counts2 = await pool.query(`
  SELECT marketplace, status, COUNT(*)::int AS n
  FROM orders
  WHERE profile_id = 6 AND status = 'new'
  GROUP BY 1
`);
console.log('new after', counts2.rows);

await pool.end();
process.exit(0);
