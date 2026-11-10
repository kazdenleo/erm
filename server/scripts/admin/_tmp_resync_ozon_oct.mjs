import marketplaceFbsReportsService from '../../src/services/marketplaceFbsReports.service.js';
import { query, closePool } from '../../src/config/database.js';

const dateFrom = process.argv[2] || '2026-10-01';
const dateTo = process.argv[3] || '2026-10-28';
const profiles = (process.argv[4] || '1,6')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => n > 0);

for (const profileId of profiles) {
  console.log('SYNC start', { profileId, dateFrom, dateTo });
  const res = await marketplaceFbsReportsService.syncOzon({ profileId, dateFrom, dateTo });
  console.log('SYNC done', res);
}

for (const profileId of profiles) {
  const stats = await query(
    `SELECT operation_type, count(*)::int AS n,
            count(*) FILTER (WHERE ABS(COALESCE(retail_amount,0)) > 0)::int AS with_retail,
            count(*) FILTER (WHERE ABS(COALESCE(payout_amount,0)) > 0)::int AS with_payout,
            round(sum(COALESCE(retail_amount,0))::numeric, 2) AS retail_sum
       FROM marketplace_fbs_report_lines
      WHERE profile_id = $1 AND marketplace = 'ozon'
        AND operation_date >= $2::date AND operation_date <= $3::date
      GROUP BY operation_type
      ORDER BY n DESC
      LIMIT 20`,
    [profileId, dateFrom, dateTo]
  );
  console.log('STATS', profileId, JSON.stringify(stats.rows, null, 2));
}

const byOrder = await marketplaceFbsReportsService.getFbsByOrder({
  profileId: profiles[0],
  dateFrom,
  dateTo,
  marketplace: 'ozon',
  limit: 20,
});
console.log('BY_ORDER', {
  n: byOrder?.items?.length || 0,
  sample: (byOrder?.items || []).slice(0, 5).map((r) => ({
    orderId: r.orderId,
    qty: r.quantity,
    retail: r.retailAmount,
    logistics: r.logisticsAmount,
    commission: r.commissionAmount,
    payout: r.payoutAmount,
    net: r.netIncome,
    sku: r.sku || r.erpSku,
  })),
});

await closePool();
