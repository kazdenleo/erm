/**
 * Юнит-экономика «как Раск» (MVP): свод по артикулу продавца за период.
 * Источник: строки финотчётов FBO + FBS (WB / Ozon).
 */
import { query } from '../config/database.js';
import {
  SALE_LINE,
  RETURN_SALE_LINE,
  SQL_COST_UNITS,
  SQL_RETURNED_AMOUNT,
  SQL_WB_WITHHELD,
  SQL_MP_NORM,
} from '../utils/marketplaceReportLineSql.js';
import {
  enrichAnalyticsRowWithTax,
  loadMarketplaceTaxContext,
  buildTaxMetaFromContext,
} from '../utils/marketplaceOrderTax.js';

function round2(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 100) / 100;
}

function pct(num, den) {
  const d = Number(den);
  if (!Number.isFinite(d) || d === 0) return null;
  return round2((Number(num) / d) * 100);
}

function parseDateYmd(v, fallback) {
  const s = String(v || '').trim().slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return fallback;
}

function defaultDateRange() {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - 27);
  const ymd = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };
  return { dateFrom: ymd(from), dateTo: ymd(to) };
}

function normalizeMarketplaceTab(v) {
  const s = String(v || 'all').trim().toLowerCase();
  if (s === 'wb' || s === 'wildberries') return 'wb';
  if (s === 'ozon') return 'ozon';
  return 'all';
}

/** Цена продавца до СПП: WB retail_price × qty из raw; иначе retail_amount. */
const SQL_SALE_BEFORE_SPP = `CASE
  WHEN ${SALE_LINE} AND LOWER(TRIM(l.marketplace)) IN ('wb', 'wildberries')
    AND (l.raw_json->>'retail_price') ~ '^-?[0-9]+(\\.[0-9]+)?$'
    THEN (l.raw_json->>'retail_price')::numeric * GREATEST(l.quantity, 1)
  WHEN ${SALE_LINE} THEN l.retail_amount
  ELSE 0
END`;

const SQL_RETURN_BEFORE_SPP = `CASE
  WHEN ${RETURN_SALE_LINE} AND LOWER(TRIM(l.marketplace)) IN ('wb', 'wildberries')
    AND (l.raw_json->>'retail_price') ~ '^-?[0-9]+(\\.[0-9]+)?$'
    THEN ABS((l.raw_json->>'retail_price')::numeric) * GREATEST(ABS(l.quantity), 1)
  WHEN ${RETURN_SALE_LINE} THEN ${SQL_RETURNED_AMOUNT}
  ELSE 0
END`;

const SQL_SALE_AFTER_SPP = `CASE WHEN ${SALE_LINE} THEN l.retail_amount ELSE 0 END`;
const SQL_RETURN_AFTER_SPP = `CASE WHEN ${RETURN_SALE_LINE} THEN ${SQL_RETURNED_AMOUNT} ELSE 0 END`;

const SQL_SOLD_QTY = `CASE WHEN ${SALE_LINE} THEN GREATEST(l.quantity, 0) ELSE 0 END`;
const SQL_RETURN_QTY = `CASE WHEN ${RETURN_SALE_LINE} THEN GREATEST(ABS(l.quantity), 1) ELSE 0 END`;

function buildAggSelect(tableName) {
  return `
    SELECT
      ${SQL_MP_NORM} AS marketplace,
      COALESCE(NULLIF(TRIM(l.sku), ''), '—') AS sku,
      MAX(COALESCE(l.product_id, 0))::bigint AS product_id,
      MAX(COALESCE(NULLIF(TRIM(p.sku), ''), NULLIF(TRIM(l.sku), ''), '—')) AS erp_sku,
      MAX(COALESCE(NULLIF(TRIM(p.name), ''), NULLIF(TRIM(l.product_name), ''), '')) AS product_name,
      SUM(${SQL_SOLD_QTY})::int AS sold_qty,
      SUM(${SQL_RETURN_QTY})::int AS return_qty,
      SUM(${SQL_SALE_BEFORE_SPP})::numeric AS sales_before_spp,
      SUM(${SQL_RETURN_BEFORE_SPP})::numeric AS returns_before_spp,
      SUM(${SQL_SALE_AFTER_SPP})::numeric AS sales_after_spp,
      SUM(${SQL_RETURN_AFTER_SPP})::numeric AS returns_after_spp,
      SUM(l.commission_amount)::numeric AS commission_amount,
      SUM(l.logistics_amount)::numeric AS logistics_amount,
      SUM(l.storage_amount)::numeric AS storage_amount,
      SUM(l.penalty_amount)::numeric AS penalty_amount,
      SUM(l.acquiring_amount)::numeric AS acquiring_amount,
      SUM(l.other_deductions)::numeric AS other_deductions,
      SUM(l.payout_amount)::numeric AS payout_amount,
      SUM(${SQL_WB_WITHHELD})::numeric AS wb_withheld_amount,
      SUM((${SQL_COST_UNITS}) * COALESCE(p.cost, 0))::numeric AS cost_amount,
      BOOL_OR(
        (${SALE_LINE} OR ${RETURN_SALE_LINE}) AND (p.id IS NULL OR p.cost IS NULL)
      ) AS cost_missing,
      SUM(
        CASE WHEN ${SALE_LINE}
          THEN GREATEST(l.quantity, 0) * COALESCE(p.additional_expenses, 0)
          ELSE 0
        END
      )::numeric AS additional_expenses_amount
    FROM ${tableName} l
    LEFT JOIN products p ON p.id = l.product_id
    WHERE l.profile_id = $1
      AND l.operation_date >= $2::date
      AND l.operation_date <= $3::date
      AND ${SQL_MP_NORM} IN ('wb', 'ozon')
    GROUP BY ${SQL_MP_NORM}, COALESCE(NULLIF(TRIM(l.sku), ''), '—')
  `;
}

function mergeRows(a, b) {
  const key = `${a.marketplace}|${a.sku}`;
  void key;
  return {
    marketplace: a.marketplace,
    sku: a.sku,
    product_id: Number(a.product_id) || Number(b.product_id) || 0,
    erp_sku: a.erp_sku || b.erp_sku,
    product_name: a.product_name || b.product_name,
    sold_qty: (Number(a.sold_qty) || 0) + (Number(b.sold_qty) || 0),
    return_qty: (Number(a.return_qty) || 0) + (Number(b.return_qty) || 0),
    sales_before_spp: (Number(a.sales_before_spp) || 0) + (Number(b.sales_before_spp) || 0),
    returns_before_spp: (Number(a.returns_before_spp) || 0) + (Number(b.returns_before_spp) || 0),
    sales_after_spp: (Number(a.sales_after_spp) || 0) + (Number(b.sales_after_spp) || 0),
    returns_after_spp: (Number(a.returns_after_spp) || 0) + (Number(b.returns_after_spp) || 0),
    commission_amount: (Number(a.commission_amount) || 0) + (Number(b.commission_amount) || 0),
    logistics_amount: (Number(a.logistics_amount) || 0) + (Number(b.logistics_amount) || 0),
    storage_amount: (Number(a.storage_amount) || 0) + (Number(b.storage_amount) || 0),
    penalty_amount: (Number(a.penalty_amount) || 0) + (Number(b.penalty_amount) || 0),
    acquiring_amount: (Number(a.acquiring_amount) || 0) + (Number(b.acquiring_amount) || 0),
    other_deductions: (Number(a.other_deductions) || 0) + (Number(b.other_deductions) || 0),
    payout_amount: (Number(a.payout_amount) || 0) + (Number(b.payout_amount) || 0),
    wb_withheld_amount: (Number(a.wb_withheld_amount) || 0) + (Number(b.wb_withheld_amount) || 0),
    cost_amount: (Number(a.cost_amount) || 0) + (Number(b.cost_amount) || 0),
    cost_missing: Boolean(a.cost_missing) || Boolean(b.cost_missing),
    additional_expenses_amount:
      (Number(a.additional_expenses_amount) || 0) + (Number(b.additional_expenses_amount) || 0),
  };
}

function toRaskRow(row, taxContext) {
  const soldQty = Number(row.sold_qty) || 0;
  const returnQty = Number(row.return_qty) || 0;
  const realizedQty = soldQty - returnQty;

  const salesBefore = round2(row.sales_before_spp);
  const returnsBefore = round2(row.returns_before_spp);
  const realizedBefore = round2(salesBefore - returnsBefore);

  const salesAfter = round2(row.sales_after_spp);
  const returnsAfter = round2(row.returns_after_spp);
  const realizedAfter = round2(salesAfter - returnsAfter);

  const sppAmount = round2(realizedBefore - realizedAfter);
  const commission = round2(row.commission_amount);
  const logistics = round2(row.logistics_amount);
  const storage = round2(row.storage_amount);
  const penalties = round2(row.penalty_amount);
  const acquiring = round2(row.acquiring_amount);
  const other = round2(row.other_deductions);
  const servicesTotal = round2(commission + logistics + storage + penalties + acquiring + other);

  const payoutRaw = round2(row.payout_amount);
  const wbWithheld = round2(row.wb_withheld_amount);
  // WB: к оплате = ppvz_for_pay − логистика/хранение/штрафы (как в экономике заказов)
  const payoutTotal =
    String(row.marketplace) === 'wb' ? round2(payoutRaw - wbWithheld) : payoutRaw;

  const costAmount = round2(row.cost_amount);
  const additionalExpensesAmount = round2(row.additional_expenses_amount);
  const expensesTotal = servicesTotal;
  const retailAmount = realizedAfter;

  const base = {
    productId: Number(row.product_id) || null,
    sku: row.sku,
    erpSku: row.erp_sku || row.sku,
    productName: row.product_name || '',
    marketplace: row.marketplace,
    soldQty,
    returnQty,
    realizedQty,
    returnRatePct: pct(returnQty, soldQty),
    salesBeforeSpp: salesBefore,
    returnsBeforeSpp: returnsBefore,
    realizedBeforeSpp: realizedBefore,
    avgCheckBeforeSpp: realizedQty > 0 ? round2(realizedBefore / realizedQty) : null,
    salesAfterSpp: salesAfter,
    returnsAfterSpp: returnsAfter,
    realizedAfterSpp: realizedAfter,
    avgCheckAfterSpp: realizedQty > 0 ? round2(realizedAfter / realizedQty) : null,
    sppAmount,
    sppPct: pct(sppAmount, realizedBefore),
    commissionAmount: commission,
    logisticsAmount: logistics,
    storageAmount: storage,
    penaltyAmount: penalties,
    acquiringAmount: acquiring,
    otherDeductions: other,
    servicesTotal,
    payoutAmount: payoutTotal,
    payoutPerUnit: realizedQty > 0 ? round2(payoutTotal / realizedQty) : null,
    costAmount,
    costMissing: Boolean(row.cost_missing) || (realizedQty !== 0 && costAmount === 0 && !row.product_id),
    avgCostPerUnit: realizedQty > 0 ? round2(costAmount / realizedQty) : null,
    costPctOfBeforeSpp: pct(costAmount, realizedBefore),
    additionalExpensesAmount,
    expensesTotal,
    retailAmount,
    adsAmount: 0,
    marketingAmount: 0,
  };

  const withTax = enrichAnalyticsRowWithTax(base, taxContext);
  const taxAmount = round2(withTax.taxAmount);
  const payoutAfterTax = round2(payoutTotal - taxAmount);
  const operatingProfit = round2(
    payoutAfterTax - costAmount - additionalExpensesAmount - (Number(base.marketingAmount) || 0)
  );

  return {
    ...withTax,
    taxAmount,
    payoutAfterTax,
    operatingProfit,
    operatingProfitPerUnit: realizedQty > 0 ? round2(operatingProfit / realizedQty) : null,
    profitPctBeforeSpp: pct(operatingProfit, realizedBefore),
    profitPctAfterSpp: pct(operatingProfit, realizedAfter),
    profitPctOnCost: pct(operatingProfit, costAmount),
    profitPctOnPayout: pct(operatingProfit, payoutTotal),
  };
}

function summarize(items) {
  const sumKeys = [
    'soldQty',
    'returnQty',
    'realizedQty',
    'salesBeforeSpp',
    'returnsBeforeSpp',
    'realizedBeforeSpp',
    'salesAfterSpp',
    'returnsAfterSpp',
    'realizedAfterSpp',
    'sppAmount',
    'commissionAmount',
    'logisticsAmount',
    'storageAmount',
    'penaltyAmount',
    'acquiringAmount',
    'otherDeductions',
    'servicesTotal',
    'payoutAmount',
    'costAmount',
    'additionalExpensesAmount',
    'taxAmount',
    'payoutAfterTax',
    'operatingProfit',
    'adsAmount',
    'marketingAmount',
  ];
  const s = Object.fromEntries(sumKeys.map((k) => [k, 0]));
  let costMissingRows = 0;
  for (const it of items) {
    for (const k of sumKeys) s[k] = round2(s[k] + (Number(it[k]) || 0));
    if (it.costMissing) costMissingRows += 1;
  }
  return {
    ...s,
    rows: items.length,
    costMissingRows,
    returnRatePct: pct(s.returnQty, s.soldQty),
    sppPct: pct(s.sppAmount, s.realizedBeforeSpp),
    avgCheckBeforeSpp: s.realizedQty > 0 ? round2(s.realizedBeforeSpp / s.realizedQty) : null,
    avgCheckAfterSpp: s.realizedQty > 0 ? round2(s.realizedAfterSpp / s.realizedQty) : null,
    payoutPerUnit: s.realizedQty > 0 ? round2(s.payoutAmount / s.realizedQty) : null,
    operatingProfitPerUnit: s.realizedQty > 0 ? round2(s.operatingProfit / s.realizedQty) : null,
    profitPctBeforeSpp: pct(s.operatingProfit, s.realizedBeforeSpp),
    profitPctAfterSpp: pct(s.operatingProfit, s.realizedAfterSpp),
    profitPctOnCost: pct(s.operatingProfit, s.costAmount),
    profitPctOnPayout: pct(s.operatingProfit, s.payoutAmount),
  };
}

class UnitEconomicsRaskService {
  /**
   * @param {{ profileId: number, dateFrom?: string, dateTo?: string, marketplace?: string, limit?: number }} opts
   */
  async getReport({ profileId, dateFrom = null, dateTo = null, marketplace = 'all', limit = 5000 } = {}) {
    const pid = profileId != null ? Number(profileId) : null;
    if (!Number.isFinite(pid) || pid < 1) {
      const err = new Error('Профиль не определён');
      err.statusCode = 403;
      throw err;
    }

    const defaults = defaultDateRange();
    const fromYmd = parseDateYmd(dateFrom, defaults.dateFrom);
    const toYmd = parseDateYmd(dateTo, defaults.dateTo);
    const tab = normalizeMarketplaceTab(marketplace);
    const rowLimit = Math.min(10000, Math.max(1, parseInt(limit, 10) || 5000));

    const [fboRes, fbsRes] = await Promise.all([
      query(buildAggSelect('marketplace_fbo_report_lines'), [pid, fromYmd, toYmd]),
      query(buildAggSelect('marketplace_fbs_report_lines'), [pid, fromYmd, toYmd]),
    ]);

    const map = new Map();
    for (const row of [...(fboRes.rows || []), ...(fbsRes.rows || [])]) {
      const mp = String(row.marketplace || '').toLowerCase();
      if (tab !== 'all' && mp !== tab) continue;
      const key = `${mp}|${row.sku}`;
      if (!map.has(key)) map.set(key, row);
      else map.set(key, mergeRows(map.get(key), row));
    }

    const taxContext = await loadMarketplaceTaxContext(pid);
    let items = [...map.values()]
      .map((r) => toRaskRow(r, taxContext))
      .filter((r) => r.soldQty > 0 || r.returnQty > 0 || r.payoutAmount !== 0 || r.servicesTotal !== 0)
      .sort((a, b) => (b.realizedBeforeSpp || 0) - (a.realizedBeforeSpp || 0) || String(a.sku).localeCompare(String(b.sku), 'ru'));

    if (items.length > rowLimit) items = items.slice(0, rowLimit);

    const byMp = { wb: [], ozon: [] };
    for (const it of items) {
      if (it.marketplace === 'wb') byMp.wb.push(it);
      else if (it.marketplace === 'ozon') byMp.ozon.push(it);
    }

    return {
      period: { dateFrom: fromYmd, dateTo: toYmd },
      marketplace: tab,
      taxMeta: buildTaxMetaFromContext(taxContext),
      mvpNote:
        'MVP: продажи/возвраты, до/после СПП (WB retail_price при наличии), удержания, к оплате, налог, себестоимость, прибыль. Самовыкупы, раздачи, реклама по API, остатки МП — в следующих итерациях.',
      summary: summarize(items),
      summaryByMarketplace: {
        wb: summarize(byMp.wb),
        ozon: summarize(byMp.ozon),
      },
      items,
    };
  }
}

export default new UnitEconomicsRaskService();
