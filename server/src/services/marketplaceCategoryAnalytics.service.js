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
import { sqlNormArticle, sqlOzonSkuMapCte } from '../utils/offerArticleKey.js';
import { ensureOzonFinanceSkuLinks } from './ozonFinanceSkuLink.service.js';
import logger from '../utils/logger.js';

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

/** Продажа для qty / выручки / себестоимости (FBO и FBS). */
const FBO_SALE = `(
  (LOWER(TRIM(l.marketplace)) IN ('wb', 'wildberries') AND l.operation_type = 'Продажа')
  OR (LOWER(TRIM(l.marketplace)) = 'ozon' AND l.operation_type = 'OperationAgentDeliveredToCustomer')
  OR (LOWER(TRIM(l.marketplace)) IN ('ym', 'yandex', 'yandexmarket') AND (
    l.operation_type ILIKE '%Плат%покупателя%'
    OR l.operation_type ILIKE '%платеж покупателя%'
  ))
)`;

/** FBS: то же правило продаж. */
const FBS_SALE = FBO_SALE;

function buildAggSelect(saleExpr) {
  return `
    COALESCE(p.user_category_id, 0) AS category_id,
    COALESCE(NULLIF(TRIM(uc.name), ''), 'Без категории') AS category_name,
    COALESCE(l.product_id, m.product_id, nm.product_id, 0) AS product_id,
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
    )::numeric AS cost_amount,
    SUM(
      CASE WHEN ${saleExpr}
        THEN GREATEST(l.quantity, 0) * COALESCE(p.additional_expenses, 0)
        ELSE 0
      END
    )::numeric AS additional_expenses_amount
  `;
}

/**
 * Fallback: ERP sku (normalized, ±DT) встречается в product_name строки отчёта
 * ИЛИ длинный alnum-префикс имени совпадает (уникально).
 */
function sqlOzonNameMapCte() {
  const skuNorm = sqlNormArticle('p.sku');
  const nameNorm = sqlNormArticle('l.product_name');
  const coreSku = `CASE WHEN ${skuNorm} LIKE 'DT%' THEN substr(${skuNorm}, 3) ELSE ${skuNorm} END`;
  const alnumName = `lower(regexp_replace(COALESCE(l.product_name, ''), '[^a-zA-Zа-яА-ЯёЁ0-9]+', '', 'g'))`;
  const alnumProd = `lower(regexp_replace(COALESCE(p.name, ''), '[^a-zA-Zа-яА-ЯёЁ0-9]+', '', 'g'))`;
  return `
  ozon_name_map AS (
    SELECT mp_sku, product_id
    FROM (
      SELECT
        TRIM(l.sku) AS mp_sku,
        p.id AS product_id,
        COUNT(*) OVER (PARTITION BY TRIM(l.sku)) AS hit_cnt
      FROM (
        SELECT DISTINCT TRIM(sku) AS sku, MAX(product_name) AS product_name
        FROM (
          SELECT sku, product_name FROM marketplace_fbo_report_lines
          WHERE profile_id = $1 AND LOWER(TRIM(marketplace)) = 'ozon'
            AND product_id IS NULL
            AND sku IS NOT NULL AND TRIM(sku) <> '' AND TRIM(sku) <> '0'
            AND product_name IS NOT NULL AND TRIM(product_name) <> ''
          UNION ALL
          SELECT sku, product_name FROM marketplace_fbs_report_lines
          WHERE profile_id = $1 AND LOWER(TRIM(marketplace)) = 'ozon'
            AND product_id IS NULL
            AND sku IS NOT NULL AND TRIM(sku) <> '' AND TRIM(sku) <> '0'
            AND product_name IS NOT NULL AND TRIM(product_name) <> ''
        ) raw
        GROUP BY TRIM(sku)
      ) l
      JOIN products p ON p.profile_id = $1
      WHERE NOT EXISTS (SELECT 1 FROM ozon_sku_map m0 WHERE m0.mp_sku = TRIM(l.sku))
        AND (
          (
            ${coreSku} <> ''
            AND length(${coreSku}) >= 5
            AND ${coreSku} ~ '[A-Z]'
            AND ${coreSku} ~ '[0-9]'
            AND position(${coreSku} IN ${nameNorm}) > 0
          )
          OR (
            length(${alnumName}) >= 45
            AND left(${alnumProd}, 45) = left(${alnumName}, 45)
          )
        )
    ) ranked
    WHERE hit_cnt = 1
  )`;
}

function lineProductJoins() {
  return `
        LEFT JOIN ozon_sku_map m ON l.product_id IS NULL
          AND LOWER(TRIM(l.marketplace)) = 'ozon'
          AND l.sku IS NOT NULL
          AND TRIM(l.sku) <> ''
          AND TRIM(l.sku) <> '0'
          AND m.mp_sku = TRIM(l.sku)
        LEFT JOIN ozon_name_map nm ON l.product_id IS NULL
          AND m.product_id IS NULL
          AND LOWER(TRIM(l.marketplace)) = 'ozon'
          AND l.sku IS NOT NULL
          AND TRIM(l.sku) <> ''
          AND TRIM(l.sku) <> '0'
          AND nm.mp_sku = TRIM(l.sku)
        LEFT JOIN products p ON p.id = COALESCE(l.product_id, m.product_id, nm.product_id)
        LEFT JOIN user_categories uc ON uc.id = p.user_category_id`;
}

/** Fee-only junk: МП:0 / empty SKU without ERP product — hide from category rows. */
function isJunkUnlinkedProduct(row) {
  const pid = Number(row.product_id ?? row.productId) || 0;
  if (pid > 0) return false;
  const sku = String(row.sku || '').trim();
  if (!sku || sku === '—' || sku === '-' || sku === '0') return true;
  // Только удержания без продаж и без названия — не показываем как «товар».
  const soldQty = Number(row.sold_qty ?? row.soldQty) || 0;
  const soldAmount = Number(row.sold_amount ?? row.soldAmount) || 0;
  const name = String(row.product_name ?? row.productName ?? '').trim();
  if (soldQty === 0 && soldAmount === 0 && (!name || name === '—')) return true;
  return false;
}

/** Строки отчёта без товара и без нормального артикула (служебные удержания). */
const SQL_EXCLUDE_JUNK_UNLINKED = `
  AND NOT (
    l.product_id IS NULL
    AND m.product_id IS NULL
    AND nm.product_id IS NULL
    AND (
      l.sku IS NULL
      OR TRIM(l.sku) = ''
      OR TRIM(l.sku) = '0'
    )
  )
`;

function mapProductRow(row) {
  const commissionAmount = Number(row.commission_amount) || 0;
  const logisticsAmount = Number(row.logistics_amount) || 0;
  const storageAmount = Number(row.storage_amount) || 0;
  const penaltyAmount = Number(row.penalty_amount) || 0;
  const acquiringAmount = Number(row.acquiring_amount) || 0;
  const otherDeductions = Number(row.other_deductions) || 0;
  const costAmount = Number(row.cost_amount) || 0;
  const additionalExpensesAmount = Number(row.additional_expenses_amount) || 0;
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
    additionalExpensesAmount,
    expensesTotal,
    costsTotal: expensesTotal,
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

function isBadMpSku(sku) {
  const s = String(sku || '').trim();
  return !s || s === '—' || s === '-' || s === '0';
}

/** Слить строки одного ERP-товара (удержания с sku=0 иначе дублируют товар). */
function mergeProductsByIdentity(rows) {
  const map = new Map();
  for (const row of rows) {
    const pid = Number(row.productId) || 0;
    const key = pid > 0 ? `p:${pid}` : `s:${String(row.sku || '').trim() || '—'}`;
    const prev = map.get(key);
    if (!prev) {
      const sku = !isBadMpSku(row.sku) ? row.sku : row.erpSku || row.sku;
      map.set(key, { ...row, sku });
      continue;
    }
    const amountKeys = [
      'soldQty',
      'soldAmount',
      'costAmount',
      'additionalExpensesAmount',
      'commissionAmount',
      'logisticsAmount',
      'storageAmount',
      'penaltyAmount',
      'acquiringAmount',
      'otherDeductions',
      'expensesTotal',
      'costsTotal',
      'payoutAmount',
    ];
    for (const k of amountKeys) {
      prev[k] = (Number(prev[k]) || 0) + (Number(row[k]) || 0);
    }
    if ((!prev.erpSku || prev.erpSku === '—') && row.erpSku) prev.erpSku = row.erpSku;
    if ((!prev.productName || prev.productName === '—') && row.productName && row.productName !== '—') {
      prev.productName = row.productName;
    }
    if (isBadMpSku(prev.sku) && !isBadMpSku(row.sku)) prev.sku = row.sku;
    else if (isBadMpSku(prev.sku) && prev.erpSku) prev.sku = prev.erpSku;
  }
  return [...map.values()];
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

    // Досвязать Ozon finance SKU → ERP (иначе «Без категории» / ERP: —)
    try {
      await ensureOzonFinanceSkuLinks(pid, { limit: 50 });
    } catch (e) {
      logger.warn('[Category Analytics] ensureOzonFinanceSkuLinks failed', e?.message || e);
    }

    const parts = [];
    if (schemeNorm === 'all' || schemeNorm === 'fbo') {
      parts.push(`
        SELECT ${buildAggSelect(FBO_SALE)}
        FROM marketplace_fbo_report_lines l
        ${lineProductJoins()}
        WHERE l.profile_id = $1
          AND l.operation_date >= $2::date AND l.operation_date <= $3::date
          ${mpClause}
          ${SQL_EXCLUDE_JUNK_UNLINKED}
        GROUP BY COALESCE(p.user_category_id, 0),
                 COALESCE(NULLIF(TRIM(uc.name), ''), 'Без категории'),
                 COALESCE(l.product_id, m.product_id, nm.product_id, 0),
                 COALESCE(NULLIF(TRIM(l.sku), ''), COALESCE(NULLIF(TRIM(p.sku), ''), '—'))
      `);
    }
    if (schemeNorm === 'all' || schemeNorm === 'fbs') {
      parts.push(`
        SELECT ${buildAggSelect(FBS_SALE)}
        FROM marketplace_fbs_report_lines l
        ${lineProductJoins()}
        WHERE l.profile_id = $1
          AND l.operation_date >= $2::date AND l.operation_date <= $3::date
          ${mpClause}
          ${SQL_EXCLUDE_JUNK_UNLINKED}
        GROUP BY COALESCE(p.user_category_id, 0),
                 COALESCE(NULLIF(TRIM(uc.name), ''), 'Без категории'),
                 COALESCE(l.product_id, m.product_id, nm.product_id, 0),
                 COALESCE(NULLIF(TRIM(l.sku), ''), COALESCE(NULLIF(TRIM(p.sku), ''), '—'))
      `);
    }

    const sql = `
      WITH ${sqlOzonSkuMapCte()},
      ${sqlOzonNameMapCte()}
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
        SUM(cost_amount)::numeric AS cost_amount,
        SUM(additional_expenses_amount)::numeric AS additional_expenses_amount
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
        OR SUM(additional_expenses_amount) <> 0
      ORDER BY SUM(sold_amount) DESC, sku ASC
    `;

    const [res, taxContext] = await Promise.all([
      query(sql, params),
      loadMarketplaceTaxContext(pid),
    ]);

    const productsRaw = mergeProductsByIdentity(
      (res.rows || []).filter((row) => !isJunkUnlinkedProduct(row)).map(mapProductRow)
    );
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
        additionalExpensesAmount: p.additionalExpensesAmount,
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
        vatAmount: p.vatAmount,
        incomeTaxAmount: p.incomeTaxAmount,
        netIncome: p.netIncome,
        taxTooltip: p.taxTooltip,
        organizationName: p.organizationName,
      });
    }

    const categories = [...byCategory.values()]
      .map((cat) => {
        const soldAmount = sumField(cat.products, 'soldAmount');
        const costAmount = sumField(cat.products, 'costAmount');
        const additionalExpensesAmount = sumField(cat.products, 'additionalExpensesAmount');
        const commissionAmount = sumField(cat.products, 'commissionAmount');
        const logisticsAmount = sumField(cat.products, 'logisticsAmount');
        const storageAmount = sumField(cat.products, 'storageAmount');
        const penaltyAmount = sumField(cat.products, 'penaltyAmount');
        const acquiringAmount = sumField(cat.products, 'acquiringAmount');
        const otherDeductions = sumField(cat.products, 'otherDeductions');
        const expensesTotal = sumField(cat.products, 'expensesTotal');
        const costsTotal = expensesTotal;
        const netIncome = sumField(cat.products, 'netIncome');
        const taxAmount = sumField(cat.products, 'taxAmount');
        const vatAmount = sumField(cat.products, 'vatAmount');
        const incomeTaxAmount = sumField(cat.products, 'incomeTaxAmount');
        const soldQty = sumField(cat.products, 'soldQty');
        const payoutAmount = sumField(cat.products, 'payoutAmount');
        const taxTooltipParts = [];
        if (vatAmount > 0) taxTooltipParts.push(`НДС: ${Math.round(vatAmount).toLocaleString('ru-RU')} ₽`);
        if (incomeTaxAmount > 0) {
          taxTooltipParts.push(`Налог по схеме: ${Math.round(incomeTaxAmount).toLocaleString('ru-RU')} ₽`);
        }
        if (taxTooltipParts.length) {
          taxTooltipParts.push(`Итого: ${Math.round(taxAmount).toLocaleString('ru-RU')} ₽`);
        }
        return {
          categoryId: cat.categoryId || null,
          categoryName: cat.categoryName,
          soldQty,
          soldAmount,
          costAmount,
          additionalExpensesAmount,
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
          vatAmount,
          incomeTaxAmount,
          netIncome,
          taxTooltip: taxTooltipParts.length ? taxTooltipParts.join('\n') : null,
          productsCount: cat.products.length,
          products: cat.products.sort((a, b) => (b.soldAmount || 0) - (a.soldAmount || 0)),
        };
      })
      .filter((cat) => (cat.productsCount || 0) > 0)
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
        additionalExpensesAmount: sumField(categories, 'additionalExpensesAmount'),
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
        vatAmount: sumField(categories, 'vatAmount'),
        incomeTaxAmount: sumField(categories, 'incomeTaxAmount'),
        netIncome: sumField(categories, 'netIncome'),
        categoriesCount: categories.length,
        productsCount: products.length,
      },
      categories,
    };
  }

  /**
   * ABC-анализ товаров: те же данные, что «По категориям», плоский список товаров.
   * Классификацию A/B/C (80/15/5) считает клиент по выбранной метрике.
   */
  async getAbcAnalysis({
    profileId,
    dateFrom = null,
    dateTo = null,
    marketplace = 'all',
    scheme = 'all',
  } = {}) {
    const data = await this.getByCategory({
      profileId,
      dateFrom,
      dateTo,
      marketplace,
      scheme,
    });

    const products = [];
    for (const cat of data.categories || []) {
      for (const p of cat.products || []) {
        products.push({
          productId: p.productId,
          sku: p.sku,
          erpSku: p.erpSku,
          productName: p.productName,
          categoryId: cat.categoryId || null,
          categoryName: cat.categoryName || 'Без категории',
          soldQty: Number(p.soldQty) || 0,
          soldAmount: Number(p.soldAmount) || 0,
          netIncome: Number(p.netIncome) || 0,
          costsTotal: Number(p.costsTotal) || 0,
          taxAmount: Number(p.taxAmount) || 0,
        });
      }
    }

    return {
      period: data.period,
      marketplace: data.marketplace,
      scheme: data.scheme,
      taxMeta: data.taxMeta,
      thresholds: { A: 0.8, B: 0.95 },
      summary: {
        soldQty: data.summary?.soldQty || 0,
        soldAmount: data.summary?.soldAmount || 0,
        netIncome: data.summary?.netIncome || 0,
        productsCount: products.length,
      },
      products,
    };
  }
}

export default new MarketplaceCategoryAnalyticsService();
