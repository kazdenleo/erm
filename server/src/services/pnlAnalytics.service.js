/**
 * ОПиУ (P&L) по компании: финотчёты маркетплейсов + себестоимость + постоянные расходы + налоги.
 *
 * Перечислено МП:
 *  - WB: ppvz_for_pay продаж − ppvz_for_pay возвратов − логистика − хранение − штрафы − удержания
 *        (в отчёте WB эти суммы удерживаются отдельно от «к перечислению»);
 *  - Ozon / Я.Маркет: сумма начислений (amount уже нетто, со знаком).
 * Постоянные расходы без МП/организации распределяются по выручке месяца.
 * Налог — на уровне «организация × месяц» (постоянные расходы уменьшают базу УСН Д−Р / ОСН),
 * в разрезы по МП разносится пропорционально выручке.
 */

import { query } from '../config/database.js';
import { sqlOzonSkuMapCte } from '../utils/offerArticleKey.js';
import {
  SALE_LINE,
  RETURN_SALE_LINE,
  SQL_RETURNED_AMOUNT,
  SQL_NET_TRANSFER,
  SQL_COMMISSION_SIGNED,
  SQL_LOGISTICS_FEE,
  SQL_MP_NORM,
  SQL_LINE_PRODUCT_ID,
  sqlOzonNameMapCte,
  lineProductJoins,
  sqlReportLinesUnion,
} from '../utils/marketplaceReportLineSql.js';
import { requireAnalyticsProfile, normalizeMp, normalizeScheme, round2 } from '../utils/analyticsCommon.js';
import { loadMarketplaceTaxContext } from '../utils/marketplaceOrderTax.js';
import { computeTaxesAndNetProfit, resolveOrganizationTaxProfile } from '../utils/organizationTaxRates.js';
import { ensureOzonFinanceSkuLinks } from './ozonFinanceSkuLink.service.js';
import companyExpensesService from './companyExpenses.service.js';
import logger from '../utils/logger.js';

const MPS = ['ozon', 'wb', 'ym'];
const NONE = '_none';

function parseMonth(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/^(\d{4})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}` : null;
}

function currentMonthMoscow() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' }).slice(0, 7);
}

function addMonths(ym, delta) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

function listMonths(fromYm, toYm) {
  const out = [];
  let cur = fromYm;
  let guard = 0;
  while (cur <= toYm && guard < 60) {
    out.push(cur);
    cur = addMonths(cur, 1);
    guard += 1;
  }
  return out;
}

function lastDayOfMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

function emptyFacts() {
  return {
    soldQty: 0,
    soldAmount: 0,
    returnedQty: 0,
    returnedAmount: 0,
    commission: 0,
    logistics: 0,
    storage: 0,
    penalty: 0,
    acquiring: 0,
    other: 0,
    netTransfer: 0,
    cost: 0,
    additional: 0,
  };
}

function addFacts(target, src, k = 1) {
  for (const key of Object.keys(target)) target[key] += (Number(src[key]) || 0) * k;
}

/** Месяцы периода, на которые приходится расход. */
function expenseMonths(expense, months) {
  const startYm = expense.startDate.slice(0, 7);
  if (expense.recurrence !== 'monthly') return months.includes(startYm) ? [startYm] : [];
  const endYm = expense.endDate ? expense.endDate.slice(0, 7) : '9999-12';
  return months.filter((m) => m >= startYm && m <= endYm);
}

class PnlAnalyticsService {
  async getPnl({
    profileId,
    monthFrom = null,
    monthTo = null,
    marketplace = 'all',
    organizationId = null,
    scheme = 'all',
  } = {}) {
    const pid = requireAnalyticsProfile(profileId);
    const toYm = parseMonth(monthTo) || currentMonthMoscow();
    let fromYm = parseMonth(monthFrom) || addMonths(toYm, -5);
    if (fromYm > toYm) fromYm = toYm;
    const months = listMonths(fromYm, toYm);
    const dateFrom = `${fromYm}-01`;
    const dateTo = lastDayOfMonth(toYm);
    const mpFilter = normalizeMp(marketplace);
    const schemeNorm = normalizeScheme(scheme);
    const orgFilter =
      organizationId != null && String(organizationId).trim() !== '' && String(organizationId) !== 'all'
        ? String(Number(organizationId))
        : null;

    try {
      await ensureOzonFinanceSkuLinks(pid, { limit: 50 });
    } catch (e) {
      logger.warn('[PnL] ensureOzonFinanceSkuLinks failed', e?.message || e);
    }

    const factsSql = `
      WITH ${sqlOzonSkuMapCte()},
      ${sqlOzonNameMapCte()}
      SELECT
        to_char(l.operation_date, 'YYYY-MM') AS month,
        ${SQL_MP_NORM} AS mp,
        COALESCE(${SQL_LINE_PRODUCT_ID}, 0) AS product_id,
        SUM(CASE WHEN ${SALE_LINE} THEN GREATEST(l.quantity, 0) ELSE 0 END)::numeric AS sold_qty,
        SUM(CASE WHEN ${SALE_LINE} THEN l.retail_amount ELSE 0 END)::numeric AS sold_amount,
        SUM(CASE WHEN ${RETURN_SALE_LINE} THEN GREATEST(ABS(l.quantity), 1) ELSE 0 END)::numeric AS returned_qty,
        SUM(CASE WHEN ${RETURN_SALE_LINE} THEN ${SQL_RETURNED_AMOUNT} ELSE 0 END)::numeric AS returned_amount,
        SUM(${SQL_COMMISSION_SIGNED})::numeric AS commission,
        SUM(${SQL_LOGISTICS_FEE})::numeric AS logistics,
        SUM(l.storage_amount)::numeric AS storage,
        SUM(l.penalty_amount)::numeric AS penalty,
        SUM(l.acquiring_amount)::numeric AS acquiring,
        SUM(l.other_deductions)::numeric AS other,
        SUM(${SQL_NET_TRANSFER})::numeric AS net_transfer,
        SUM(CASE
          WHEN ${SALE_LINE} THEN GREATEST(l.quantity, 0) * COALESCE(p.cost, 0)
          WHEN ${RETURN_SALE_LINE} THEN -GREATEST(ABS(l.quantity), 1) * COALESCE(p.cost, 0)
          ELSE 0 END)::numeric AS cost,
        SUM(CASE
          WHEN ${SALE_LINE} THEN GREATEST(l.quantity, 0) * COALESCE(p.additional_expenses, 0)
          WHEN ${RETURN_SALE_LINE} THEN -GREATEST(ABS(l.quantity), 1) * COALESCE(p.additional_expenses, 0)
          ELSE 0 END)::numeric AS additional
      FROM ${sqlReportLinesUnion(schemeNorm, 'AND r.operation_date >= $2::date AND r.operation_date <= $3::date')} l
      ${lineProductJoins()}
      GROUP BY 1, 2, 3
    `;

    const [factsRes, expenses, taxContext] = await Promise.all([
      query(factsSql, [pid, dateFrom, dateTo]),
      companyExpensesService.listForProfile(pid),
      loadMarketplaceTaxContext(pid),
    ]);

    const orgName = new Map([...taxContext.orgById.values()].map((o) => [String(o.id), o.name]));
    const defaultOrgId = taxContext.defaultOrg ? String(taxContext.defaultOrg.id) : NONE;
    const orgIdForProduct = (productId) => {
      const id = taxContext.productOrgId.get(Number(productId));
      return id && taxContext.orgById.has(id) ? String(id) : defaultOrgId;
    };

    // Ячейки «месяц × организация × МП»
    const cells = new Map();
    const cellKey = (m, org, mp) => `${m}|${org}|${mp}`;
    const getCell = (m, org, mp) => {
      const k = cellKey(m, org, mp);
      if (!cells.has(k)) {
        cells.set(k, { month: m, org, mp, facts: emptyFacts(), fixed: {}, tax: 0 });
      }
      return cells.get(k);
    };

    for (const r of factsRes.rows || []) {
      const mp = MPS.includes(r.mp) ? r.mp : r.mp || NONE;
      const cell = getCell(r.month, orgIdForProduct(r.product_id), mp);
      addFacts(cell.facts, {
        soldQty: r.sold_qty,
        soldAmount: r.sold_amount,
        returnedQty: r.returned_qty,
        returnedAmount: r.returned_amount,
        commission: r.commission,
        logistics: r.logistics,
        storage: r.storage,
        penalty: r.penalty,
        acquiring: r.acquiring,
        other: r.other,
        netTransfer: r.net_transfer,
        cost: r.cost,
        additional: r.additional,
      });
    }

    const netRevenue = (f) => f.soldAmount - f.returnedAmount;
    const revenueOf = (m, orgSet, mpSet) => {
      let sum = 0;
      for (const c of cells.values()) {
        if (c.month !== m) continue;
        if (orgSet && !orgSet.includes(c.org)) continue;
        if (mpSet && !mpSet.includes(c.mp)) continue;
        sum += Math.max(0, netRevenue(c.facts));
      }
      return sum;
    };

    // Постоянные расходы → ячейки (общие — по выручке месяца)
    for (const e of expenses) {
      for (const m of expenseMonths(e, months)) {
        const orgs = e.organizationId != null ? [String(e.organizationId)] : null;
        const mps = e.marketplace ? [e.marketplace] : null;
        const targets = [...cells.values()].filter(
          (c) =>
            c.month === m &&
            (!orgs || orgs.includes(c.org)) &&
            (!mps || mps.includes(c.mp)) &&
            netRevenue(c.facts) > 0
        );
        const total = revenueOf(m, orgs, mps);
        if (!targets.length || total <= 0) {
          const cell = getCell(m, orgs ? orgs[0] : NONE, mps ? mps[0] : NONE);
          cell.fixed[e.category] = (cell.fixed[e.category] || 0) + e.amount;
          continue;
        }
        for (const c of targets) {
          const share = Math.max(0, netRevenue(c.facts)) / total;
          c.fixed[e.category] = (c.fixed[e.category] || 0) + e.amount * share;
        }
      }
    }

    // Налог: организация × месяц
    const orgMonth = new Map();
    for (const c of cells.values()) {
      if (c.org === NONE) continue;
      const k = `${c.month}|${c.org}`;
      if (!orgMonth.has(k)) orgMonth.set(k, []);
      orgMonth.get(k).push(c);
    }
    for (const [k, list] of orgMonth.entries()) {
      const orgId = k.split('|')[1];
      const org = taxContext.orgById.get(Number(orgId)) || null;
      const profile = resolveOrganizationTaxProfile(org);
      const f = emptyFacts();
      let fixedTotal = 0;
      for (const c of list) {
        addFacts(f, c.facts);
        fixedTotal += Object.values(c.fixed).reduce((s, v) => s + v, 0);
      }
      const revenue = netRevenue(f);
      const mpTake = revenue - f.netTransfer;
      const { vat, incomeTax } = computeTaxesAndNetProfit({
        price: revenue,
        totalExpenses: f.cost + f.additional + mpTake + fixedTotal,
        taxProfile: profile,
      });
      const tax = Math.max(0, (Number(vat) || 0) + (Number(incomeTax) || 0));
      const revTotal = list.reduce((s, c) => s + Math.max(0, netRevenue(c.facts)), 0);
      for (const c of list) {
        c.tax = revTotal > 0 ? (tax * Math.max(0, netRevenue(c.facts))) / revTotal : tax / list.length;
      }
    }

    const buildColumn = (filterFn) => {
      const f = emptyFacts();
      const fixed = {};
      let tax = 0;
      for (const c of cells.values()) {
        if (!filterFn(c)) continue;
        addFacts(f, c.facts);
        for (const [cat, v] of Object.entries(c.fixed)) fixed[cat] = (fixed[cat] || 0) + v;
        tax += c.tax;
      }
      const revenue = netRevenue(f);
      const feesDetailed = f.commission + f.logistics + f.storage + f.penalty + f.acquiring + f.other;
      const mpTake = revenue - f.netTransfer;
      const grossProfit = f.netTransfer - f.cost - f.additional;
      const fixedTotal = Object.values(fixed).reduce((s, v) => s + v, 0);
      const operatingProfit = grossProfit - fixedTotal;
      const netProfit = operatingProfit - tax;
      return {
        soldQty: Math.round(f.soldQty),
        returnedQty: Math.round(f.returnedQty),
        soldAmount: round2(f.soldAmount),
        returnedAmount: round2(f.returnedAmount),
        revenue: round2(revenue),
        commission: round2(f.commission),
        logistics: round2(f.logistics),
        storage: round2(f.storage),
        penalty: round2(f.penalty),
        acquiring: round2(f.acquiring),
        other: round2(f.other),
        mpAdjustments: round2(mpTake - feesDetailed),
        mpTake: round2(mpTake),
        netTransfer: round2(f.netTransfer),
        cost: round2(f.cost),
        additional: round2(f.additional),
        grossProfit: round2(grossProfit),
        fixedByCategory: Object.fromEntries(Object.entries(fixed).map(([k, v]) => [k, round2(v)])),
        fixedTotal: round2(fixedTotal),
        operatingProfit: round2(operatingProfit),
        tax: round2(tax),
        netProfit: round2(netProfit),
        marginPercent: revenue > 0 ? round2((netProfit / revenue) * 100) : null,
      };
    };

    const matchOrg = (c) => !orgFilter || c.org === orgFilter;
    const matchMp = (c) => mpFilter === 'all' || c.mp === mpFilter;

    const byMonth = months.map((m) => ({
      key: m,
      label: m,
      ...buildColumn((c) => c.month === m && matchOrg(c) && matchMp(c)),
    }));
    const total = buildColumn((c) => matchOrg(c) && matchMp(c));

    const mpKeys = mpFilter === 'all' ? MPS : [mpFilter];
    const byMarketplace = mpKeys.map((mp) => ({
      key: mp,
      label: mp === 'ozon' ? 'Ozon' : mp === 'wb' ? 'Wildberries' : 'Яндекс Маркет',
      ...buildColumn((c) => c.mp === mp && matchOrg(c)),
    }));
    const sharedMp = buildColumn((c) => c.mp === NONE && matchOrg(c));
    if (mpFilter === 'all' && (sharedMp.fixedTotal !== 0 || sharedMp.revenue !== 0)) {
      byMarketplace.push({ key: NONE, label: 'Без МП', ...sharedMp });
    }

    const orgKeys = orgFilter ? [orgFilter] : [...new Set([...cells.values()].map((c) => c.org))];
    const byOrganization = orgKeys.map((org) => ({
      key: org,
      label: org === NONE ? 'Без организации' : orgName.get(org) || `Организация #${org}`,
      ...buildColumn((c) => c.org === org && matchMp(c)),
    }));

    const categories = [
      ...new Set(
        [...byMonth, total, ...byMarketplace, ...byOrganization].flatMap((col) => Object.keys(col.fixedByCategory))
      ),
    ].sort((a, b) => a.localeCompare(b, 'ru'));

    return {
      period: { monthFrom: fromYm, monthTo: toYm, dateFrom, dateTo },
      filters: { marketplace: mpFilter, organizationId: orgFilter, scheme: schemeNorm },
      organizations: [...taxContext.orgById.values()].map((o) => ({ id: Number(o.id), name: o.name })),
      expenseCategories: categories,
      byMonth,
      byMarketplace,
      byOrganization,
      total,
    };
  }
}

export default new PnlAnalyticsService();
