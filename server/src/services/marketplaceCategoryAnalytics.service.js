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

function buildDayAggSelect(saleExpr, schemeLabel) {
  return `
    l.operation_date::date AS operation_date,
    CASE LOWER(TRIM(l.marketplace))
      WHEN 'wildberries' THEN 'wb'
      WHEN 'yandex' THEN 'ym'
      WHEN 'yandexmarket' THEN 'ym'
      ELSE LOWER(TRIM(l.marketplace))
    END AS marketplace,
    '${schemeLabel}'::text AS scheme,
    COALESCE(l.product_id, m.product_id, nm.product_id, 0) AS product_id,
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

function buildDayGroupBy() {
  return `
    l.operation_date::date,
    CASE LOWER(TRIM(l.marketplace))
      WHEN 'wildberries' THEN 'wb'
      WHEN 'yandex' THEN 'ym'
      WHEN 'yandexmarket' THEN 'ym'
      ELSE LOWER(TRIM(l.marketplace))
    END,
    COALESCE(l.product_id, m.product_id, nm.product_id, 0)
  `;
}

function mapDayEconomicsRow(row) {
  const operationDate =
    typeof row.operation_date === 'string'
      ? String(row.operation_date).slice(0, 10)
      : row.operation_date instanceof Date
        ? `${row.operation_date.getFullYear()}-${String(row.operation_date.getMonth() + 1).padStart(2, '0')}-${String(row.operation_date.getDate()).padStart(2, '0')}`
        : String(row.operation_date || '').slice(0, 10);
  return {
    operationDate,
    marketplace: row.marketplace || 'unknown',
    scheme: row.scheme === 'fbs' ? 'fbs' : 'fbo',
    productId: Number(row.product_id) || 0,
    soldQty: Number(row.sold_qty) || 0,
    soldAmount: Number(row.sold_amount) || 0,
    commissionAmount: Number(row.commission_amount) || 0,
    logisticsAmount: Number(row.logistics_amount) || 0,
    storageAmount: Number(row.storage_amount) || 0,
    penaltyAmount: Number(row.penalty_amount) || 0,
    acquiringAmount: Number(row.acquiring_amount) || 0,
    otherDeductions: Number(row.other_deductions) || 0,
    payoutAmount: Number(row.payout_amount) || 0,
    costAmount: Number(row.cost_amount) || 0,
    additionalExpensesAmount: Number(row.additional_expenses_amount) || 0,
  };
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

function normalizeGranularity(raw) {
  const v = String(raw || 'day').trim().toLowerCase();
  if (['day', 'week', 'month', 'quarter', 'year'].includes(v)) return v;
  return 'day';
}

function buildDynamicsSelect(saleExpr) {
  return `
    date_trunc($4, l.operation_date)::date AS bucket,
    CASE LOWER(TRIM(l.marketplace))
      WHEN 'wildberries' THEN 'wb'
      WHEN 'yandex' THEN 'ym'
      WHEN 'yandexmarket' THEN 'ym'
      ELSE LOWER(TRIM(l.marketplace))
    END AS marketplace,
    COALESCE(l.product_id, m.product_id, nm.product_id, 0) AS product_id,
    COALESCE(NULLIF(TRIM(l.sku), ''), COALESCE(NULLIF(TRIM(p.sku), ''), '—')) AS sku,
    MAX(COALESCE(p.name, l.product_name, '—')) AS product_name,
    MAX(p.sku) AS erp_sku,
    SUM(CASE WHEN ${saleExpr} THEN GREATEST(l.quantity, 0) ELSE 0 END)::numeric AS sold_qty,
    SUM(CASE WHEN ${saleExpr} THEN l.retail_amount ELSE 0 END)::numeric AS sold_amount
  `;
}

function buildDynamicsGroupBy() {
  return `
    date_trunc($4, l.operation_date)::date,
    CASE LOWER(TRIM(l.marketplace))
      WHEN 'wildberries' THEN 'wb'
      WHEN 'yandex' THEN 'ym'
      WHEN 'yandexmarket' THEN 'ym'
      ELSE LOWER(TRIM(l.marketplace))
    END,
    COALESCE(l.product_id, m.product_id, nm.product_id, 0),
    COALESCE(NULLIF(TRIM(l.sku), ''), COALESCE(NULLIF(TRIM(p.sku), ''), '—'))
  `;
}

function mapDynamicsRow(row) {
  return {
    bucket: row.bucket instanceof Date ? row.bucket.toISOString().slice(0, 10) : String(row.bucket || '').slice(0, 10),
    marketplace: row.marketplace || 'unknown',
    productId: Number(row.product_id) || null,
    sku: row.sku || '—',
    erpSku: row.erp_sku || null,
    productName: row.product_name || '—',
    soldQty: Number(row.sold_qty) || 0,
    soldAmount: Number(row.sold_amount) || 0,
  };
}

function mergeDynamicsRows(rows) {
  const merged = new Map();
  for (const row of rows) {
    const key = `${row.bucket}|${row.marketplace}|${row.productId || 0}|${row.sku}`;
    const prev = merged.get(key);
    if (!prev) {
      merged.set(key, { ...row });
      continue;
    }
    prev.soldQty += row.soldQty;
    prev.soldAmount += row.soldAmount;
    if ((!prev.erpSku || prev.erpSku === '—') && row.erpSku) prev.erpSku = row.erpSku;
    if ((!prev.productName || prev.productName === '—') && row.productName !== '—') {
      prev.productName = row.productName;
    }
  }
  return [...merged.values()];
}

function buildProductCatalog(rows) {
  const map = new Map();
  for (const row of rows) {
    const pid = Number(row.productId) || 0;
    const key = pid > 0 ? `p:${pid}` : `s:${row.sku}`;
    const prev = map.get(key);
    if (!prev) {
      map.set(key, {
        productId: pid || null,
        sku: row.sku,
        erpSku: row.erpSku,
        productName: row.productName,
        soldQty: row.soldQty,
        soldAmount: row.soldAmount,
      });
      continue;
    }
    prev.soldQty += row.soldQty;
    prev.soldAmount += row.soldAmount;
  }
  return [...map.values()]
    .filter((p) => p.soldQty > 0 || p.soldAmount > 0)
    .sort((a, b) => b.soldAmount - a.soldAmount || b.soldQty - a.soldQty);
}

function productKey(row) {
  const pid = Number(row.productId) || 0;
  return pid > 0 ? `p:${pid}` : `s:${String(row.sku || '').trim() || '—'}`;
}

function buildBucketsFromRows(rows, marketplaces, granularity) {
  const buckets = [...new Set(rows.map((r) => r.bucket))].sort();
  return buckets.map((bucket) => {
    const bucketRows = rows.filter((r) => r.bucket === bucket);
    const byMarketplace = {};
    let totalQty = 0;
    let totalAmount = 0;
    for (const mp of marketplaces) {
      const mpRows = bucketRows.filter((r) => r.marketplace === mp);
      const soldQty = mpRows.reduce((s, r) => s + r.soldQty, 0);
      const soldAmount = mpRows.reduce((s, r) => s + r.soldAmount, 0);
      byMarketplace[mp] = { soldQty, soldAmount };
      totalQty += soldQty;
      totalAmount += soldAmount;
    }
    return {
      bucket,
      bucketLabel: formatBucketLabel(bucket, granularity),
      soldQty: totalQty,
      soldAmount: totalAmount,
      marketplaces: byMarketplace,
    };
  });
}

function buildPeriodSeries(rows, { productId = null, productIds = null, granularity = 'day', maxProducts = 100 } = {}) {
  const pidFilter = productId != null ? Number(productId) : null;
  const idSet =
    Array.isArray(productIds) && productIds.length
      ? new Set(productIds.map((id) => Number(id)).filter((n) => Number.isFinite(n) && n > 0))
      : null;

  const filtered = rows.filter((row) => {
    if (isJunkUnlinkedProduct(row)) return false;
    if (pidFilter != null && Number(row.productId) !== pidFilter) return false;
    if (idSet && !idSet.has(Number(row.productId) || 0)) return false;
    return true;
  });

  const marketplaces = [...new Set(filtered.map((r) => r.marketplace))].sort();
  const points = buildBucketsFromRows(filtered, marketplaces, granularity);

  const byProduct = new Map();
  for (const row of filtered) {
    const key = productKey(row);
    if (!byProduct.has(key)) {
      byProduct.set(key, {
        key,
        productId: Number(row.productId) || null,
        sku: row.sku,
        erpSku: row.erpSku,
        productName: row.productName,
        rows: [],
      });
    }
    const p = byProduct.get(key);
    p.rows.push(row);
    if ((!p.erpSku || p.erpSku === '—') && row.erpSku) p.erpSku = row.erpSku;
    if ((!p.productName || p.productName === '—') && row.productName && row.productName !== '—') {
      p.productName = row.productName;
    }
    if ((!p.sku || isBadMpSku(p.sku)) && !isBadMpSku(row.sku)) p.sku = row.sku;
  }

  const products = [...byProduct.values()]
    .map((p) => {
      const soldQty = p.rows.reduce((s, r) => s + r.soldQty, 0);
      const soldAmount = p.rows.reduce((s, r) => s + r.soldAmount, 0);
      const pMarketplaces = [...new Set(p.rows.map((r) => r.marketplace))].sort();
      return {
        productId: p.productId,
        sku: p.sku,
        erpSku: p.erpSku,
        productName: p.productName,
        soldQty,
        soldAmount,
        marketplaces: pMarketplaces,
        buckets: buildBucketsFromRows(p.rows, pMarketplaces, granularity),
      };
    })
    .sort((a, b) => b.soldAmount - a.soldAmount || b.soldQty - a.soldQty)
    .slice(0, Math.max(1, Math.min(500, Number(maxProducts) || 100)));

  return {
    buckets: points,
    marketplaces,
    products,
    totals: {
      soldQty: filtered.reduce((s, r) => s + r.soldQty, 0),
      soldAmount: filtered.reduce((s, r) => s + r.soldAmount, 0),
      productsCount: byProduct.size,
    },
  };
}

function formatBucketLabel(bucketYmd, granularity) {
  const s = String(bucketYmd || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const [y, m, d] = s.split('-').map(Number);
  const dd = String(d).padStart(2, '0');
  const mm = String(m).padStart(2, '0');
  if (granularity === 'day') return `${dd}.${mm}`;
  if (granularity === 'week') return `${dd}.${mm}.${y}`;
  if (granularity === 'month') {
    const months = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
    return `${months[m - 1]} ${y}`;
  }
  if (granularity === 'quarter') return `Q${Math.ceil(m / 3)} ${y}`;
  if (granularity === 'year') return String(y);
  return s;
}

function parseComparePeriods(raw, defaults) {
  if (!raw) return [];
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((p, idx) => ({
        id: String(p.id || `compare-${idx + 1}`),
        label: String(p.label || `Период ${idx + 2}`).trim() || `Период ${idx + 2}`,
        dateFrom: parseDateYmd(p.dateFrom, defaults.dateFrom),
        dateTo: parseDateYmd(p.dateTo, defaults.dateTo),
      }))
      .filter((p) => p.dateFrom && p.dateTo);
  } catch {
    return [];
  }
}

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

  /**
   * Динамика продаж по товару и маркетплейсу с группировкой day/week/month/quarter/year.
   * Поддерживает сравнение нескольких периодов (comparePeriods JSON).
   */
  async getProductDynamics({
    profileId,
    dateFrom = null,
    dateTo = null,
    comparePeriods = null,
    granularity = 'day',
    marketplace = 'all',
    scheme = 'all',
    productId = null,
    productIds = null,
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
    const gran = normalizeGranularity(granularity);
    const schemeNorm = normalizeScheme(scheme);
    const mpFilter = normalizeMarketplaceFilter(marketplace);
    const productFilter = productId != null && Number(productId) > 0 ? Number(productId) : null;
    let productIdList = null;
    if (productIds != null) {
      try {
        const parsed = typeof productIds === 'string' ? JSON.parse(productIds) : productIds;
        if (Array.isArray(parsed)) {
          productIdList = parsed.map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0);
        }
      } catch {
        productIdList = null;
      }
    }
    if (productFilter && (!productIdList || !productIdList.length)) {
      productIdList = [productFilter];
    }

    const primaryPeriod = {
      id: 'primary',
      label: 'Основной период',
      dateFrom: parseDateYmd(dateFrom, defaults.dateFrom),
      dateTo: parseDateYmd(dateTo, defaults.dateTo),
    };
    const extraPeriods = parseComparePeriods(comparePeriods, defaults);
    const periods = [primaryPeriod, ...extraPeriods].slice(0, 4);

    try {
      await ensureOzonFinanceSkuLinks(pid, { limit: 50 });
    } catch (e) {
      logger.warn('[Product Dynamics] ensureOzonFinanceSkuLinks failed', e?.message || e);
    }

    const fetchPeriod = async (period, { productFilter: pf = productFilter } = {}) => {
      const params = [pid, period.dateFrom, period.dateTo, gran];
      let mpClause = '';
      if (mpFilter) {
        params.push(mpFilterValues(mpFilter));
        mpClause = `AND LOWER(TRIM(l.marketplace)) = ANY($${params.length}::text[])`;
      }
      let productClause = '';
      if (pf) {
        params.push(pf);
        productClause = `AND COALESCE(l.product_id, m.product_id, nm.product_id, 0) = $${params.length}`;
      }

      const parts = [];
      if (schemeNorm === 'all' || schemeNorm === 'fbo') {
        parts.push(`
          SELECT ${buildDynamicsSelect(FBO_SALE)}
          FROM marketplace_fbo_report_lines l
          ${lineProductJoins()}
          WHERE l.profile_id = $1
            AND l.operation_date >= $2::date AND l.operation_date <= $3::date
            ${mpClause}
            ${productClause}
            ${SQL_EXCLUDE_JUNK_UNLINKED}
          GROUP BY ${buildDynamicsGroupBy()}
        `);
      }
      if (schemeNorm === 'all' || schemeNorm === 'fbs') {
        parts.push(`
          SELECT ${buildDynamicsSelect(FBS_SALE)}
          FROM marketplace_fbs_report_lines l
          ${lineProductJoins()}
          WHERE l.profile_id = $1
            AND l.operation_date >= $2::date AND l.operation_date <= $3::date
            ${mpClause}
            ${productClause}
            ${SQL_EXCLUDE_JUNK_UNLINKED}
          GROUP BY ${buildDynamicsGroupBy()}
        `);
      }

      const sql = `
        WITH ${sqlOzonSkuMapCte()},
        ${sqlOzonNameMapCte()}
        SELECT
          bucket,
          marketplace,
          product_id,
          sku,
          MAX(product_name) AS product_name,
          MAX(erp_sku) AS erp_sku,
          SUM(sold_qty)::numeric AS sold_qty,
          SUM(sold_amount)::numeric AS sold_amount
        FROM (
          ${parts.join('\nUNION ALL\n')}
        ) u
        GROUP BY bucket, marketplace, product_id, sku
        HAVING SUM(sold_qty) <> 0 OR SUM(sold_amount) <> 0
        ORDER BY bucket ASC, marketplace ASC
      `;

      const res = await query(sql, params);
      return mergeDynamicsRows((res.rows || []).map(mapDynamicsRow));
    };

    const periodResults = await Promise.all(
      periods.map(async (period) => {
        const rows = await fetchPeriod(period, { productFilter: null });
        const series = buildPeriodSeries(rows, {
          productId: productFilter,
          productIds: productIdList,
          granularity: gran,
          maxProducts: productIdList?.length ? Math.max(productIdList.length, 50) : 150,
        });
        return {
          id: period.id,
          label: period.label,
          dateFrom: period.dateFrom,
          dateTo: period.dateTo,
          ...series,
        };
      })
    );

    const productCatalog =
      periodResults[0]?.products?.map((p) => ({
        productId: p.productId,
        sku: p.sku,
        erpSku: p.erpSku,
        productName: p.productName,
        soldQty: p.soldQty,
        soldAmount: p.soldAmount,
      })) || [];

    return {
      granularity: gran,
      marketplace: mpFilter ? marketplace : 'all',
      scheme: schemeNorm,
      productId: productFilter,
      periods: periodResults,
      productCatalog,
    };
  }

  /**
   * Поденная экономика выбранных товаров (FBO+FBS) — для сравнения периодов гипотез.
   * Без ensureOzonFinanceSkuLinks и без ozon_name_map: они сканируют все отчёты/заказы профиля.
   */
  async getProductDayEconomics({
    profileId,
    productIds = [],
    dateFrom = null,
    dateTo = null,
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

    const ids = [...new Set((Array.isArray(productIds) ? productIds : []).map((x) => Number(x)))]
      .filter((n) => Number.isFinite(n) && n > 0);
    if (!ids.length) return [];

    const defaults = defaultDateRange();
    const fromYmd = parseDateYmd(dateFrom, defaults.dateFrom);
    const toYmd = parseDateYmd(dateTo, defaults.dateTo);
    const params = [pid, fromYmd, toYmd, ids];
    const hypDaySelect = (schemeLabel, productIdExpr) => `
    l.operation_date::date AS operation_date,
    CASE LOWER(TRIM(l.marketplace))
      WHEN 'wildberries' THEN 'wb'
      WHEN 'yandex' THEN 'ym'
      WHEN 'yandexmarket' THEN 'ym'
      ELSE LOWER(TRIM(l.marketplace))
    END AS marketplace,
    '${schemeLabel}'::text AS scheme,
    ${productIdExpr} AS product_id,
    SUM(CASE WHEN ${FBO_SALE} THEN GREATEST(l.quantity, 0) ELSE 0 END)::numeric AS sold_qty,
    SUM(CASE WHEN ${FBO_SALE} THEN l.retail_amount ELSE 0 END)::numeric AS sold_amount,
    SUM(l.commission_amount)::numeric AS commission_amount,
    SUM(l.logistics_amount)::numeric AS logistics_amount,
    SUM(l.storage_amount)::numeric AS storage_amount,
    SUM(l.penalty_amount)::numeric AS penalty_amount,
    SUM(l.acquiring_amount)::numeric AS acquiring_amount,
    SUM(l.other_deductions)::numeric AS other_deductions,
    SUM(l.payout_amount)::numeric AS payout_amount,
    SUM(
      CASE WHEN ${FBO_SALE}
        THEN GREATEST(l.quantity, 0) * COALESCE(p.cost, 0)
        ELSE 0
      END
    )::numeric AS cost_amount,
    SUM(
      CASE WHEN ${FBO_SALE}
        THEN GREATEST(l.quantity, 0) * COALESCE(p.additional_expenses, 0)
        ELSE 0
      END
    )::numeric AS additional_expenses_amount
  `;
    const hypDayGroupBy = (productIdExpr) => `
    l.operation_date::date,
    CASE LOWER(TRIM(l.marketplace))
      WHEN 'wildberries' THEN 'wb'
      WHEN 'yandex' THEN 'ym'
      WHEN 'yandexmarket' THEN 'ym'
      ELSE LOWER(TRIM(l.marketplace))
    END,
    ${productIdExpr}
  `;
    const linkedPart = (table, scheme) => `
        SELECT ${hypDaySelect(scheme, 'l.product_id')}
        FROM ${table} l
        LEFT JOIN products p ON p.id = l.product_id
        WHERE l.profile_id = $1
          AND l.operation_date >= $2::date AND l.operation_date <= $3::date
          AND l.product_id = ANY($4::bigint[])
        GROUP BY ${hypDayGroupBy('l.product_id')}
    `;
    const unlinkedPart = (table, scheme) => `
        SELECT ${hypDaySelect(scheme, 'm.product_id')}
        FROM ${table} l
        INNER JOIN hyp_sku_map m
          ON LOWER(TRIM(l.marketplace)) = 'ozon'
          AND l.sku IS NOT NULL
          AND TRIM(l.sku) <> ''
          AND m.mp_sku = TRIM(l.sku)
        LEFT JOIN products p ON p.id = m.product_id
        WHERE l.profile_id = $1
          AND l.operation_date >= $2::date AND l.operation_date <= $3::date
          AND l.product_id IS NULL
        GROUP BY ${hypDayGroupBy('m.product_id')}
    `;

    const sql = `
      WITH hyp_sku_map AS (
        SELECT TRIM(ps.mp_extra->>'ozon_sku') AS mp_sku, ps.product_id
        FROM product_skus ps
        WHERE ps.product_id = ANY($4::bigint[])
          AND ps.marketplace = 'ozon'
          AND NULLIF(TRIM(ps.mp_extra->>'ozon_sku'), '') IS NOT NULL
        UNION
        SELECT TRIM(CAST(ps.marketplace_product_id AS TEXT)), ps.product_id
        FROM product_skus ps
        WHERE ps.product_id = ANY($4::bigint[])
          AND ps.marketplace = 'ozon'
          AND ps.marketplace_product_id IS NOT NULL
      )
      SELECT
        to_char(operation_date, 'YYYY-MM-DD') AS operation_date,
        marketplace,
        scheme,
        product_id,
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
        ${linkedPart('marketplace_fbo_report_lines', 'fbo')}
        UNION ALL
        ${unlinkedPart('marketplace_fbo_report_lines', 'fbo')}
        UNION ALL
        ${linkedPart('marketplace_fbs_report_lines', 'fbs')}
        UNION ALL
        ${unlinkedPart('marketplace_fbs_report_lines', 'fbs')}
      ) u
      GROUP BY operation_date, marketplace, scheme, product_id
    `;

    const res = await query(sql, params);
    return (res.rows || []).map(mapDayEconomicsRow).filter((r) => r.productId > 0);
  }
}

export default new MarketplaceCategoryAnalyticsService();
