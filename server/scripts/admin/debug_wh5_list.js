import { default as svc } from '../../src/services/stockMovements.service.js';

const pid = Number(process.argv[2] || 378);
for (const wh of [5, 1, null]) {
  const list = await svc.listReservedOrdersForProduct(pid, {
    warehouseId: wh ?? undefined,
    _skipStaleCleanup: true
  });
  console.log('pid', pid, 'wh', wh, JSON.stringify(list, null, 2));
}
process.exit(0);
