/**
 * Аналитика продаж по пользовательским категориям товаров (FBO/FBS отчёты).
 */

import { query } from '../config/database.js';
import repositoryFactory from '../config/repository-factory.js';
import {
  enrichAnalyticsRowWithTax,
  loadMarketplaceTaxContext,
  buildTaxMetaFromContext,
} from '../utils/marketplaceOrderTax.js';

function parseDateYmd(raw, fallback) {
  const s = String(raw || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return fallback;
}

function defaultDateRange() {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - 30);
  const fmt = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };
  return { dateFrom: fmt(from), dateTo: fmt(to) };
}

function normalizeMarketplaceFilter(raw) {
  const v = String(raw || 'all').trim().toLowerCase();
  if (!v || v === 'all') return null;
  if (v === 'ozon') return ['ozon'];
  if (v === 'wb' || v === 'wildberries') return ['wb', 'wildberries'];
  if (v === 'ym' || v === 'yandex' || v === 'yandexmarket') return ['ym', 'yandex', 'yandexmarket'];
  return [v];
}

function mpFilterValues(mpFilter) {
  return mpFilter.map((m) =>
    m === 'wildberries' ? 'wb' : m === 'yandex' || m === 'yandexmarket' ? 'ym' : m
  );
}

function normalizeScheme(raw) {
  const v = String(raw || 'all').trim().toLowerCase();
  if (v === 'fbo' || v === 'fbs') return v;
  return 'all';
}

/** FBO: продажа для qty/себестоимости. */
const FBO_SALE = `(
  (LOWER(TRIM(l.marketplace)) IN ('wb', 'wildberries') AND l.operation_type = 'Продажа')
  OR LOWER(TRIM(l.marketplace)) NOT IN ('wb', 'wildberries')
)`;

/** FBS: продажа для qty/выручки/себестоимости. */
const FBS_SALE = `(
  (LOWER(TRIM(l.marketplace)) IN ('wb', 'wildberries') AND l.operation_type = 'Продажа')
  OR (LOWER(TRIM(l.marketplace)) = 'ozon' AND l.operation_type = 'OperationAgentDeliveredToCustomer')
  OR (LOWER(TRIM(l.marketplace)) IN ('ym', 'yandex', 'yandexmarket') AND (
    l.operation_type ILIKE '%Плат%покупателя%'
    OR l.operation_type ILIKE '%платеж покупателя%'
  ))
)`;

function buildAggSelect(saleExpr) {
  return `
    COALESCE(p.user_category_id, 0) AS category_id,
    COALESCE(NULLIF(TRIM(uc.name), ''), 'Без категории') AS category_name,
    COALESCE(l.product_id, 0) AS product_id,
    COALESCE(NULLIF(TRIM(l.sku), ''), COALESCE(NULLIF(TRIM(p.sku), ''), '—')) AS sku,
    MAX(COALESCE(p.name, l.product_name, '—')) AS product_name,
    MAX(p.sku) AS erp_sku,
    SUM(CASE WHEN ${saleExpr} THEN GREATEST(l.quantity, 0) ELSE 0 END)::numeric AS sold_qty,
    SUM(CASE WHEN ${saleExpr} THEN l.retail_amount ELSE 0 END)::numeric AS sold_amount,
    SUM(l.commission_amount)::numeric AS commission_amount,
    SUM(l.logistics_amount)::numeric AS logistics_amount,
    SUM(l.storage_amount)::numeric AS storage_amount,
    SUM(l.penalty_amount)::numeric AS penalty_amount,
    SUM(l.acquiring_amount)::numeric AS acquiring_amount,
    SUM(l.other_deductions)::numeric AS other_deductions,
    SUM(l.payout_amount)::numeric AS payout_amount,
    SUM(
      CASE WHEN ${saleExpr}
        THEN GREATEST(l.quantity, 0) * COALESCE(p.cost, 0)
        ELSE 0
      END
    )::numeric AS cost_amount
  `;
}

function mapProductRow(row) {
  const commissionAmount = Number(row.commission_amount) || 0;
  const logisticsAmount = Number(row.logistics_amount) || 0;
  const storageAmount = Number(row.storage_amount) || 0;
  const penaltyAmount = Number(row.penalty_amount) || 0;
  const acquiringAmount = Number(row.acquiring_amount) || 0;
  const otherDeductions = Number(row.other_deductions) || 0;
  const costAmount = Number(row.cost_amount) || 0;
  const expensesTotal =
    commissionAmount + logisticsAmount + storageAmount + penaltyAmount + acquiringAmount + otherDeductions;
  return {
    categoryId: Number(row.category_id) || 0,
    categoryName: row.category_name || 'Без категории',
    productId: Number(row.product_id) || null,
    sku: row.sku || '—',
    erpSku: row.erp_sku || null,
    productName: row.product_name || '—',
    soldQty: Number(row.sold_qty) || 0,
    soldAmount: Number(row.sold_amount) || 0,
    costAmount,
    expensesTotal,
    costsTotal: costAmount + expensesTotal,
    payoutAmount: Number(row.payout_amount) || 0,
    commissionAmount,
    logisticsAmount,
    storageAmount,
    penaltyAmount,
    acquiringAmount,
    otherDeductions,
  };
}

function sumField(rows, key) {
  return rows.reduce((s, r) => s + (Number(r[key]) || 0), 0);
}

class MarketplaceCategoryAnalyticsService {
  async getByCategory({
    profileId,
    dateFrom = null,
    dateTo = null,
    marketplace = 'all',
    scheme = 'all',
  } = {}) {
    const pid = profileId != null ? Number(profileId) : null;
    if (!Number.isFinite(pid) || pid < 1) {
      const err = new Error('Профиль не определён');
      err.statusCode = 403;
      throw err;
    }
    if (!repositoryFactory.isUsingPostgreSQL()) {
      const err = new Error('Доступно только с PostgreSQL');
      err.statusCode = 501;
      throw err;
    }

    const defaults = defaultDateRange();
    const fromYmd = parseDateYmd(dateFrom, defaults.dateFrom);
    const toYmd = parseDateYmd(dateTo, defaults.dateTo);
    const mpFilter = normalizeMarketplaceFilter(marketplace);
    const schemeNorm = normalizeScheme(scheme);

    const params = [pid, fromYmd, toYmd];
    let mpClause = '';
    if (mpFilter) {
      params.push(mpFilterValues(mpFilter));
      mpClause = `AND LOWER(TRIM(l.marketplace)) = ANY($${params.length}::text[])`;
    }

    const parts = [];
    if (schemeNorm === 'all' || schemeNorm === 'fbo') {
      parts.push(`
        SELECT ${buildAggSelect(FBO_SALE)}
        FROM marketplace_fbo_report_lines l
        LEFT JOIN products p ON p.id = l.product_id
        LEFT JOIN user_categories uc ON uc.id = p.user_category_id
        WHERE l.profile_id = $1
          AND l.operation_date >= $2::date AND l.operation_date <= $3::date
          ${mpClause}
        GROUP BY COALESCE(p.user_category_id, 0),
                 COALESCE(NULLIF(TRIM(uc.name), ''), 'Без категории'),
                 COALESCE(l.product_id, 0),
                 COALESCE(NULLIF(TRIM(l.sku), ''), COALESCE(NULLIF(TRIM(p.sku), ''), '—'))
      `);
    }
    if (schemeNorm === 'all' || schemeNorm === 'fbs') {
      parts.push(`
        SELECT ${buildAggSelect(FBS_SALE)}
        FROM marketplace_fbs_report_lines l
        LEFT JOIN products p ON p.id = l.product_id
        LEFT JOIN user_categories uc ON uc.id = p.user_category_id
        WHERE l.profile_id = $1
          AND l.operation_date >= $2::date AND l.operation_date <= $3::date
          ${mpClause}
        GROUP BY COALESCE(p.user_category_id, 0),
                 COALESCE(NULLIF(TRIM(uc.name), ''), 'Без категории'),
                 COALESCE(l.product_id, 0),
                 COALESCE(NULLIF(TRIM(l.sku), ''), COALESCE(NULLIF(TRIM(p.sku), ''), '—'))
      `);
    }

    const sql = `
      SELECT
        category_id,
        MAX(category_name) AS category_name,
        product_id,
        sku,
        MAX(product_name) AS product_name,
        MAX(erp_sku) AS erp_sku,
        SUM(sold_qty)::numeric AS sold_qty,
        SUM(sold_amount)::numeric AS sold_amount,
        SUM(commission_amount)::numeric AS commission_amount,
        SUM(logistics_amount)::numeric AS logistics_amount,
        SUM(storage_amount)::numeric AS storage_amount,
        SUM(penalty_amount)::numeric AS penalty_amount,
        SUM(acquiring_amount)::numeric AS acquiring_amount,
        SUM(other_deductions)::numeric AS other_deductions,
        SUM(payout_amount)::numeric AS payout_amount,
        SUM(cost_amount)::numeric AS cost_amount
      FROM (
        ${parts.join('\nUNION ALL\n')}
      ) u
      GROUP BY category_id, product_id, sku
      HAVING
        SUM(sold_qty) <> 0
        OR SUM(sold_amount) <> 0
        OR SUM(commission_amount) <> 0
        OR SUM(logistics_amount) <> 0
        OR SUM(storage_amount) <> 0
        OR SUM(penalty_amount) <> 0
        OR SUM(acquiring_amount) <> 0
        OR SUM(other_deductions) <> 0
        OR SUM(payout_amount) <> 0
        OR SUM(cost_amount) <> 0
      ORDER BY SUM(sold_amount) DESC, sku ASC
    `;

    const [res, taxContext] = await Promise.all([
      query(sql, params),
      loadMarketplaceTaxContext(pid),
    ]);

    const productsRaw = (res.rows || []).map(mapProductRow);
    const products = productsRaw.map((row) => enrichAnalyticsRowWithTax(row, taxContext));

    const byCategory = new Map();
    for (const p of products) {
      const key = String(p.categoryId || 0);
      if (!byCategory.has(key)) {
        byCategory.set(key, {
          categoryId: p.categoryId || null,
          categoryName: p.categoryName || 'Без категории',
          products: [],
        });
      }
      const cat = byCategory.get(key);
      if (!cat.categoryName || cat.categoryName === 'Без категории') {
        cat.categoryName = p.categoryName || cat.categoryName;
      }
      cat.products.push({
        productId: p.productId,
        sku: p.sku,
        erpSku: p.erpSku,
        productName: p.productName,
        soldQty: p.soldQty,
        soldAmount: p.soldAmount,
        costAmount: p.costAmount,
        commissionAmount: p.commissionAmount,
        logisticsAmount: p.logisticsAmount,
        storageAmount: p.storageAmount,
        penaltyAmount: p.penaltyAmount,
        acquiringAmount: p.acquiringAmount,
        otherDeductions: p.otherDeductions,
        expensesTotal: p.expensesTotal,
        costsTotal: p.costsTotal,
        payoutAmount: p.payoutAmount,
        taxAmount: p.taxAmount,
        netIncome: p.netIncome,
        taxTooltip: p.taxTooltip,
      });
    }

    const categories = [...byCategory.values()]
      .map((cat) => {
        const soldAmount = sumField(cat.products, 'soldAmount');
        const costAmount = sumField(cat.products, 'costAmount');
        const commissionAmount = sumField(cat.products, 'commissionAmount');
        const logisticsAmount = sumField(cat.products, 'logisticsAmount');
        const storageAmount = sumField(cat.products, 'storageAmount');
        const penaltyAmount = sumField(cat.products, 'penaltyAmount');
        const acquiringAmount = sumField(cat.products, 'acquiringAmount');
        const otherDeductions = sumField(cat.products, 'otherDeductions');
        const expensesTotal = sumField(cat.products, 'expensesTotal');
        const costsTotal = costAmount + expensesTotal;
        const netIncome = sumField(cat.products, 'netIncome');
        const taxAmount = sumField(cat.products, 'taxAmount');
        const soldQty = sumField(cat.products, 'soldQty');
        const payoutAmount = sumField(cat.products, 'payoutAmount');
        return {
          categoryId: cat.categoryId || null,
          categoryName: cat.categoryName,
          soldQty,
          soldAmount,
          costAmount,
          commissionAmount,
          logisticsAmount,
          storageAmount,
          penaltyAmount,
          acquiringAmount,
          otherDeductions,
          expensesTotal,
          costsTotal,
          payoutAmount,
          taxAmount,
          netIncome,
          productsCount: cat.products.length,
          products: cat.products.sort((a, b) => (b.soldAmount || 0) - (a.soldAmount || 0)),
        };
      })
      .sort((a, b) => (b.soldAmount || 0) - (a.soldAmount || 0));

    return {
      period: { dateFrom: fromYmd, dateTo: toYmd },
      marketplace: mpFilter ? marketplace : 'all',
      scheme: schemeNorm,
      taxMeta: buildTaxMetaFromContext(taxContext),
      summary: {
        soldQty: sumField(categories, 'soldQty'),
        soldAmount: sumField(categories, 'soldAmount'),
        costAmount: sumField(categories, 'costAmount'),
        commissionAmount: sumField(categories, 'commissionAmount'),
        logisticsAmount: sumField(categories, 'logisticsAmount'),
        storageAmount: sumField(categories, 'storageAmount'),
        penaltyAmount: sumField(categories, 'penaltyAmount'),
        acquiringAmount: sumField(categories, 'acquiringAmount'),
        otherDeductions: sumField(categories, 'otherDeductions'),
        expensesTotal: sumField(categories, 'expensesTotal'),
        costsTotal: sumField(categories, 'costsTotal'),
        payoutAmount: sumField(categories, 'payoutAmount'),
        taxAmount: sumField(categories, 'taxAmount'),
        netIncome: sumField(categories, 'netIncome'),
        categoriesCount: categories.length,
        productsCount: products.length,
      },
      categories,
    };
  }
}

export default new MarketplaceCategoryAnalyticsService();
