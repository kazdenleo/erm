/**
 * Динамика продаж для главной: заказы FBS по маркетплейсам и частные заказы (по дате оформления,
 * без отменённых) + FBO. FBO — из marketplace_fbo_orders (по дате оформления, без отменённых)
 * начиная с live_from маркетплейса; раньше этой даты и без синхронизации — из финансовых отчётов.
 */

import { query } from '../config/database.js';
import { requireAnalyticsProfile, resolvePeriod, round2, toNum } from '../utils/analyticsCommon.js';
import { SALE_LINE, SQL_MP_NORM } from '../utils/marketplaceReportLineSql.js';
import marketplaceFboOrdersService from './marketplaceFboOrders.service.js';

const GRANULARITIES = new Set(['day', 'week', 'month']);
const MAX_PERIOD_DAYS = 731;
export const HOME_SALES_SERIES = ['ozon', 'wb', 'ym', 'manual', 'fbo'];

const mskStart = (param) => `(${param}::date)::timestamp AT TIME ZONE 'Europe/Moscow'`;

function normalizeGranularity(raw) {
  const v = String(raw || 'day').trim().toLowerCase();
  return GRANULARITIES.has(v) ? v : 'day';
}

function emptySeries() {
  return Object.fromEntries(HOME_SALES_SERIES.map((k) => [k, { qty: 0, amount: 0 }]));
}

class HomeSalesDynamicsService {
  async getDynamics({ profileId, dateFrom, dateTo, granularity } = {}) {
    const pid = requireAnalyticsProfile(profileId);
    const gran = normalizeGranularity(granularity);
    const period = resolvePeriod(dateFrom, dateTo, 30);
    if (period.days > MAX_PERIOD_DAYS) {
      const err = new Error(`Период не больше ${MAX_PERIOD_DAYS} дней`);
      err.statusCode = 400;
      throw err;
    }
    const { fromYmd, toYmd } = period;

    const bucketsSql = `
      SELECT to_char(b, 'YYYY-MM-DD') AS bucket
        FROM generate_series(
          date_trunc('${gran}', $1::date),
          date_trunc('${gran}', $2::date),
          INTERVAL '1 ${gran}'
        ) AS b`;

    const ordersSql = `
      SELECT to_char(date_trunc('${gran}', o.created_at AT TIME ZONE 'Europe/Moscow'), 'YYYY-MM-DD') AS bucket,
             CASE LOWER(TRIM(o.marketplace))
               WHEN 'wildberries' THEN 'wb'
               WHEN 'yandex' THEN 'ym'
               WHEN 'yandexmarket' THEN 'ym'
               ELSE LOWER(TRIM(o.marketplace))
             END AS series,
             SUM(GREATEST(COALESCE(o.quantity, 1), 1))::numeric AS qty,
             SUM(GREATEST(COALESCE(o.quantity, 1), 1) * COALESCE(o.price, 0))::numeric AS amount
        FROM orders o
       WHERE o.profile_id = $1
         AND o.created_at >= ${mskStart('$2')}
         AND o.created_at < ${mskStart('$3')} + INTERVAL '1 day'
         AND LOWER(TRIM(COALESCE(o.status, ''))) NOT IN ('cancelled', 'canceled', 'заказ удалён')
       GROUP BY 1, 2`;

    const fboLive = await marketplaceFboOrdersService.getCoverage(pid);
    const liveFromParams = [fboLive.ozon?.liveFrom ?? null, fboLive.wb?.liveFrom ?? null, fboLive.ym?.liveFrom ?? null];
    const liveFromFor = (mpExpr) =>
      `CASE ${mpExpr} WHEN 'ozon' THEN $4::date WHEN 'wb' THEN $5::date WHEN 'ym' THEN $6::date END`;

    const fboReportsSql = `
      SELECT to_char(date_trunc('${gran}', l.operation_date), 'YYYY-MM-DD') AS bucket,
             ${SQL_MP_NORM} AS mp,
             SUM(GREATEST(l.quantity, 0))::numeric AS qty,
             SUM(l.retail_amount)::numeric AS amount
        FROM marketplace_fbo_report_lines l
       WHERE l.profile_id = $1
         AND l.operation_date >= $2::date
         AND l.operation_date <= $3::date
         AND ${SALE_LINE}
         AND (${liveFromFor(SQL_MP_NORM)} IS NULL OR l.operation_date < ${liveFromFor(SQL_MP_NORM)})
       GROUP BY 1, 2`;

    const fboLiveSql = `
      SELECT to_char(date_trunc('${gran}', f.ordered_at AT TIME ZONE 'Europe/Moscow'), 'YYYY-MM-DD') AS bucket,
             f.marketplace AS mp,
             SUM(f.quantity)::numeric AS qty,
             SUM(f.quantity * f.price)::numeric AS amount
        FROM marketplace_fbo_orders f
       WHERE f.profile_id = $1
         AND f.ordered_at >= ${mskStart('$2')}
         AND f.ordered_at < ${mskStart('$3')} + INTERVAL '1 day'
         AND NOT f.is_cancelled
         AND (f.ordered_at AT TIME ZONE 'Europe/Moscow')::date >= ${liveFromFor('f.marketplace')}
       GROUP BY 1, 2`;

    const fboLastSql = `
      SELECT to_char(MAX(operation_date), 'YYYY-MM-DD') AS last_date
        FROM marketplace_fbo_report_lines
       WHERE profile_id = $1`;

    const fboParams = [pid, fromYmd, toYmd, ...liveFromParams];
    const [bucketsRes, ordersRes, fboReportsRes, fboLiveRes, fboLastRes] = await Promise.all([
      query(bucketsSql, [fromYmd, toYmd]),
      query(ordersSql, [pid, fromYmd, toYmd]),
      query(fboReportsSql, fboParams),
      query(fboLiveSql, fboParams),
      query(fboLastSql, [pid]),
    ]);

    const byBucket = new Map();
    for (const row of bucketsRes.rows || []) {
      byBucket.set(row.bucket, { date: row.bucket, ...emptySeries() });
    }
    const totals = emptySeries();
    const fboByMarketplace = {};

    const add = (bucket, series, qty, amount) => {
      const b = byBucket.get(bucket);
      if (!b || !b[series]) return;
      b[series].qty += qty;
      b[series].amount += amount;
      totals[series].qty += qty;
      totals[series].amount += amount;
    };

    for (const row of ordersRes.rows || []) {
      add(row.bucket, row.series, toNum(row.qty), toNum(row.amount));
    }
    for (const row of [...(fboReportsRes.rows || []), ...(fboLiveRes.rows || [])]) {
      const qty = toNum(row.qty);
      const amount = toNum(row.amount);
      add(row.bucket, 'fbo', qty, amount);
      const mp = row.mp || 'other';
      fboByMarketplace[mp] = fboByMarketplace[mp] || { qty: 0, amount: 0 };
      fboByMarketplace[mp].qty += qty;
      fboByMarketplace[mp].amount += amount;
    }

    const roundSeries = (s) =>
      Object.fromEntries(
        Object.entries(s).map(([k, v]) => [k, { qty: Math.round(v.qty), amount: round2(v.amount) }])
      );

    const buckets = [...byBucket.values()].map((b) => {
      const { date, ...series } = b;
      return { date, ...roundSeries(series) };
    });
    const totalAll = HOME_SALES_SERIES.reduce(
      (acc, k) => ({ qty: acc.qty + totals[k].qty, amount: acc.amount + totals[k].amount }),
      { qty: 0, amount: 0 }
    );

    return {
      period: { dateFrom: fromYmd, dateTo: toYmd },
      granularity: gran,
      series: HOME_SALES_SERIES,
      buckets,
      totals: roundSeries(totals),
      total: { qty: Math.round(totalAll.qty), amount: round2(totalAll.amount) },
      fboByMarketplace: roundSeries(fboByMarketplace),
      fboLastDate: fboLastRes.rows?.[0]?.last_date || null,
      fboLive,
    };
  }
}

export default new HomeSalesDynamicsService();
