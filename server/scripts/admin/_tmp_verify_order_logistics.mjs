import marketplaceFbsReportsService from '../../src/services/marketplaceFbsReports.service.js';
import { closePool } from '../../src/config/database.js';

const rows = await marketplaceFbsReportsService.getFbsByOrder({
  profileId: 1,
  dateFrom: '2026-10-20',
  dateTo: '2026-10-28',
  marketplace: 'wb',
  limit: 1000,
});
const list = rows?.items || [];
const want = new Set(['6075230315', '6070983854', '6006711609']);
const kn = list.filter(
  (r) =>
    want.has(String(r.orderId || '')) ||
    String(r.sku || '').toUpperCase() === 'KN1030K' ||
    String(r.erpSku || '').toUpperCase() === 'KN1030K'
);
const slim = kn.map((r) => ({
  orderId: r.orderId,
  qty: r.quantity,
  retail: Number(r.retailAmount) || 0,
  logistics: Number(r.logisticsAmount) || 0,
  commission: Number(r.commissionAmount) || 0,
  payout: Number(r.payoutAmount) || 0,
  revenue: Number(r.revenueAmount) || 0,
  net: Number(r.netIncome) || 0,
  sku: r.sku || r.erpSku,
  name: r.productName,
}));
console.log(JSON.stringify({ total: list.length, knCount: slim.length, kn: slim }, null, 2));
await closePool();
