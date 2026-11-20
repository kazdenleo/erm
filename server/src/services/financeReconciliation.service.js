/**
 * Сверка финансов: наши агрегаты по строкам финотчётов (как в ОПиУ) за период.
 * «Отчёт» MVP = те же строки, сгруппированные по внешнему ID отчёта (WB realizationreport_id)
 * или помеченные как line_totals — до сохранения header totals при синке.
 */
import { query } from '../config/database.js';
import {
  SALE_LINE,
  RETURN_SALE_LINE,
  SQL_RETURNED_AMOUNT,
  SQL_NET_TRANSFER,
  SQL_MP_NORM,
  sqlReportLinesUnion,
} from '../utils/marketplaceReportLineSql.js';
import { requireAnalyticsProfile, normalizeMp, normalizeScheme, resolvePeriod, round2 } from '../utils/analyticsCommon.js';

function emptyBucket() {
  return {
    revenue: 0,
    commission: 0,
    logistics: 0,
    storage: 0,
    penalty: 0,
    acquiring: 0,
    other: 0,
    payout: 0,
  };
}

function addBucket(target, src) {
  for (const k of Object.keys(target)) {
    target[k] = round2(target[k] + (Number(src[k]) || 0));
  }
}

function deltaBucket(ours, report) {
  const d = emptyBucket();
  for (const k of Object.keys(d)) d[k] = round2((Number(ours[k]) || 0) - (Number(report[k]) || 0));
  return d;
}

function mapRow(r) {
  const sold = Number(r.sold_amount) || 0;
  const returned = Number(r.returned_amount) || 0;
  const revenue = round2(sold - returned);
  const commission = round2(r.commission);
  const logistics = round2(r.logistics);
  const storage = round2(r.storage);
  const penalty = round2(r.penalty);
  const acquiring = round2(r.acquiring);
  const other = round2(r.other);
  let payout = round2(r.net_transfer);
  const mp = String(r.mp || '').toLowerCase();
  if (mp === 'ozon') {
    payout = round2(
      revenue - commission - logistics - storage - penalty - acquiring - other
    );
  }
  return {
    revenue,
    commission,
    logistics,
    storage,
    penalty,
    acquiring,
    other,
    payout,
  };
}

class FinanceReconciliationService {
  async getReport({ profileId, dateFrom = null, dateTo = null, marketplace = 'all', scheme = 'all' } = {}) {
    const pid = requireAnalyticsProfile(profileId);
    const period = resolvePeriod(dateFrom, dateTo, 28);
    const { fromYmd, toYmd } = period;
    const mpFilter = normalizeMp(marketplace);
    const schemeNorm = normalizeScheme(scheme);

    const sql = `
      SELECT
        ${SQL_MP_NORM} AS mp,
        COALESCE(
          NULLIF(TRIM(l.raw_json->>'realizationreport_id'), ''),
          NULLIF(TRIM(l.raw_json->'header'->>'number'), ''),
          NULLIF(TRIM(l.raw_json->>'report_id'), ''),
          'lines'
        ) AS report_key,
        SUM(CASE WHEN ${SALE_LINE} THEN l.retail_amount ELSE 0 END)::numeric AS sold_amount,
        SUM(CASE WHEN ${RETURN_SALE_LINE} THEN ${SQL_RETURNED_AMOUNT} ELSE 0 END)::numeric AS returned_amount,
        SUM(l.commission_amount)::numeric AS commission,
        SUM(l.logistics_amount)::numeric AS logistics,
        SUM(l.storage_amount)::numeric AS storage,
        SUM(l.penalty_amount)::numeric AS penalty,
        SUM(l.acquiring_amount)::numeric AS acquiring,
        SUM(l.other_deductions)::numeric AS other,
        SUM(${SQL_NET_TRANSFER})::numeric AS net_transfer,
        COUNT(*)::int AS line_count
      FROM ${sqlReportLinesUnion(schemeNorm, 'AND r.operation_date >= $2::date AND r.operation_date <= $3::date')} l
      WHERE ${SQL_MP_NORM} IN ('wb', 'ozon', 'ym')
      GROUP BY 1, 2
      ORDER BY 1, 2
    `;

    const res = await query(sql, [pid, fromYmd, toYmd]);
    const byMp = { wb: emptyBucket(), ozon: emptyBucket(), ym: emptyBucket() };
    const reports = [];

    for (const row of res.rows || []) {
      const mp = String(row.mp || '').toLowerCase();
      if (mpFilter !== 'all' && mp !== mpFilter) continue;
      if (!byMp[mp]) continue;
      const amounts = mapRow(row);
      addBucket(byMp[mp], amounts);
      reports.push({
        marketplace: mp,
        reportKey: row.report_key,
        lineCount: Number(row.line_count) || 0,
        amounts,
        source: row.report_key === 'lines' ? 'line_totals' : 'grouped_report_id',
      });
    }

    const rows = Object.keys(byMp)
      .filter((mp) => mpFilter === 'all' || mp === mpFilter)
      .map((mp) => {
        const ours = byMp[mp];
        const reportParts = reports.filter((r) => r.marketplace === mp);
        // «По отчётам» — только строки с внешним ID; без ID считаем «сиротами» (Δ = наши − с ID).
        const withId = reportParts.filter((p) => p.reportKey !== 'lines');
        const orphans = reportParts.filter((p) => p.reportKey === 'lines');
        const report = emptyBucket();
        for (const p of withId) addBucket(report, p.amounts);
        return {
          marketplace: mp,
          ours,
          report,
          delta: deltaBucket(ours, report),
          lineCount: reportParts.reduce((s, p) => s + p.lineCount, 0),
          orphanLineCount: orphans.reduce((s, p) => s + p.lineCount, 0),
          reportParts: withId.length ? withId : reportParts,
        };
      })
      .filter((r) => r.lineCount > 0 || Object.values(r.ours).some((v) => v !== 0));

    const totalsOurs = emptyBucket();
    const totalsReport = emptyBucket();
    for (const r of rows) {
      addBucket(totalsOurs, r.ours);
      addBucket(totalsReport, r.report);
    }

    return {
      period: { dateFrom: fromYmd, dateTo: toYmd, days: period.days },
      marketplace: mpFilter,
      scheme: schemeNorm,
      mvpNote:
        'Сверка MVP: «Наши» — все строки финотчётов FBO+FBS. «По отчётам» — строки с ID отчёта в raw_json. Δ = строки без ID (сироты) + расхождения группировки. Официальные header totals из кабинета — в следующих итерациях.',
      summary: {
        ours: totalsOurs,
        report: totalsReport,
        delta: deltaBucket(totalsOurs, totalsReport),
      },
      rows,
    };
  }
}

export default new FinanceReconciliationService();
