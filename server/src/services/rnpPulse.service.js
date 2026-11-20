/**
 * РНП (пульс): метрики продаж за период + задачи и гипотезы команды.
 */
import { query } from '../config/database.js';
import { requireAnalyticsProfile, resolvePeriod, round2 } from '../utils/analyticsCommon.js';
import homeSalesDynamicsService from './homeSalesDynamics.service.js';
import productHypothesesService from './productHypotheses.service.js';

function overlaps(aFrom, aTo, bFrom, bTo) {
  return String(aFrom) <= String(bTo) && String(aTo) >= String(bFrom);
}

class RnpPulseService {
  async getPulse({ profileId, dateFrom = null, dateTo = null } = {}) {
    const pid = requireAnalyticsProfile(profileId);
    const period = resolvePeriod(dateFrom, dateTo, 7);
    const { fromYmd, toYmd } = period;

    const [dynamics, tasksRes, hypAll] = await Promise.all([
      homeSalesDynamicsService.getDynamics({
        profileId: pid,
        dateFrom: fromYmd,
        dateTo: toYmd,
        granularity: 'day',
      }),
      query(
        `SELECT
           COUNT(*) FILTER (WHERE t.status = 'open')::int AS open_count,
           COUNT(*) FILTER (
             WHERE t.status = 'completed'
               AND t.completed_at IS NOT NULL
               AND (t.completed_at AT TIME ZONE 'Europe/Moscow')::date >= $2::date
               AND (t.completed_at AT TIME ZONE 'Europe/Moscow')::date <= $3::date
           )::int AS completed_in_period,
           COUNT(*) FILTER (
             WHERE (t.created_at AT TIME ZONE 'Europe/Moscow')::date >= $2::date
               AND (t.created_at AT TIME ZONE 'Europe/Moscow')::date <= $3::date
           )::int AS created_in_period
         FROM employee_tasks t
         WHERE t.profile_id = $1::bigint
           AND t.task_type <> 'dimensions_check'`,
        [pid, fromYmd, toYmd]
      ),
      productHypothesesService.list({ profileId: pid, status: null }),
    ]);

    const recentCompleted = await query(
      `SELECT t.id, t.title, t.status, t.completed_at, t.created_at,
              p.sku AS product_sku, p.name AS product_name,
              a.full_name AS assignee_full_name
         FROM employee_tasks t
         LEFT JOIN products p ON p.id = t.product_id
         LEFT JOIN users a ON a.id = t.assignee_id
        WHERE t.profile_id = $1::bigint
          AND t.task_type <> 'dimensions_check'
          AND t.status = 'completed'
          AND t.completed_at IS NOT NULL
          AND (t.completed_at AT TIME ZONE 'Europe/Moscow')::date >= $2::date
          AND (t.completed_at AT TIME ZONE 'Europe/Moscow')::date <= $3::date
        ORDER BY t.completed_at DESC
        LIMIT 30`,
      [pid, fromYmd, toYmd]
    );

    const hypItems = Array.isArray(hypAll?.items) ? hypAll.items : [];
    const hypInPeriod = hypItems.filter((h) => overlaps(h.dateFrom, h.dateTo || h.dateFrom, fromYmd, toYmd));
    const hypActive = hypInPeriod.filter((h) => h.status === 'active');
    const hypCompleted = hypInPeriod.filter((h) => h.status === 'completed');
    const hypSalesUp = hypInPeriod.filter((h) => (h.comparison?.soldQtyDelta || 0) > 0);
    const hypProfitUp = hypInPeriod.filter((h) => (h.comparison?.netIncomeDelta || 0) > 0);
    const hypAwait = hypActive.filter((h) => h.comparison?.readyForConclusion && !h.conclusion);

    const taskStats = tasksRes.rows?.[0] || {};
    const total = dynamics?.total || { qty: 0, amount: 0 };
    const byMp = dynamics?.totals || {};

    return {
      period: { dateFrom: fromYmd, dateTo: toYmd, days: period.days },
      mvpNote:
        'РНП MVP: продажи за период + закрытые/открытые задачи + гипотезы, пересекающиеся с периодом. Гантт и план-факт метрик — в следующих итерациях.',
      metrics: {
        revenue: round2(total.amount),
        ordersQty: round2(total.qty),
        byMarketplace: {
          ozon: { qty: round2(byMp.ozon?.qty), amount: round2(byMp.ozon?.amount) },
          wb: { qty: round2(byMp.wb?.qty), amount: round2(byMp.wb?.amount) },
          ym: { qty: round2(byMp.ym?.qty), amount: round2(byMp.ym?.amount) },
          fbo: { qty: round2(byMp.fbo?.qty), amount: round2(byMp.fbo?.amount) },
        },
      },
      tasks: {
        openCount: Number(taskStats.open_count) || 0,
        createdInPeriod: Number(taskStats.created_in_period) || 0,
        completedInPeriod: Number(taskStats.completed_in_period) || 0,
        recentCompleted: (recentCompleted.rows || []).map((t) => ({
          id: t.id,
          title: t.title,
          completedAt: t.completed_at,
          productSku: t.product_sku || null,
          productName: t.product_name || null,
          assigneeName: t.assignee_full_name || null,
        })),
      },
      hypotheses: {
        inPeriod: hypInPeriod.length,
        active: hypActive.length,
        completed: hypCompleted.length,
        withSalesUp: hypSalesUp.length,
        withProfitUp: hypProfitUp.length,
        awaitingConclusion: hypAwait.length,
        items: hypInPeriod.slice(0, 40).map((h) => ({
          id: h.id,
          title: h.title,
          status: h.status,
          dateFrom: h.dateFrom,
          dateTo: h.dateTo,
          productSku: h.productSku || h.erpSku || null,
          productName: h.productName || null,
          soldQtyDelta: h.comparison?.soldQtyDelta ?? null,
          netIncomeDelta: h.comparison?.netIncomeDelta ?? null,
          conclusion: h.conclusion || null,
          readyForConclusion: Boolean(h.comparison?.readyForConclusion),
        })),
      },
      buckets: Array.isArray(dynamics?.buckets) ? dynamics.buckets : [],
    };
  }
}

export default new RnpPulseService();
