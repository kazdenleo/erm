import { default as svc } from '../../src/services/stockMovements.service.js';

const pid = Number(process.argv[2] || 508);
await svc.releaseUnattributedJournalReserve(pid, { warehouseId: 5 }).catch(() => {});
const summary = await svc.getReserveSummaryForProduct(pid, { warehouseId: 5 });
console.log('SUMMARY wh5:', summary);
process.exit(0);
