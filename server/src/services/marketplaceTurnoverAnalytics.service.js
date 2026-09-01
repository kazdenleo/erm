/**
 * Оборачиваемость товаров на маркетплейсах:
 * продажи за период vs текущий остаток на складах МП (последний снапшот).
 */

import { query } from '../config/database.js';
import repositoryFactory from '../config/repository-factory.js';
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
  from.setDate(from.getDate() - 27);
  const fmt = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };
  return { dateFrom: fmt(from), dateTo: fmt(to) };
}

function daysInclusive(fromYmd, toYmd) {
  const [y1, m1, d1] = fromYmd.split('-').map((x) => parseInt(x, 10));
  const [y2, m2, d2] = toYmd.split('-').map((x) => parseInt(x, 10));
  const start = Date.UTC(y1, m1 - 1, d1);
  const end = Date.UTC(y2, m2 - 1, d2);
  return Math.max(1, Math.floor((end - start) / 86400000) + 1);
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

const SALE_LINE = `(
  (LOWER(TRIM(l.marketplace)) IN ('wb', 'wildberries') AND l.operation_type = 'Продажа')
  OR (LOWER(TRIM(l.marketplace)) = 'ozon' AND l.operation_type = 'OperationAgentDeliveredToCustomer')
  OR (LOWER(TRIM(l.marketplace)) IN ('ym', 'yandex', 'yandexmarket') AND (
    l.operation_type ILIKE '%Плат%покупателя%'
    OR l.operation_type ILIKE '%платеж покупателя%'
  ))
)`;

const SQL_MP_NORM = `CASE LOWER(TRIM(l.marketplace))
  WHEN 'wildberries' THEN 'wb'
  WHEN 'yandex' THEN 'ym'
  WHEN 'yandexmarket' THEN 'ym'
  ELSE LOWER(TRIM(l.marketplace))
END`;

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
        LEFT JOIN products p ON p.id = COALESCE(l.product_id, m.product_id, nm.product_id)`;
}

const SQL_EXCLUDE_JUNK = `
  AND NOT (
    l.product_id IS NULL
    AND m.product_id IS NULL
    AND nm.product_id IS NULL
    AND (l.sku IS NULL OR TRIM(l.sku) = '' OR TRIM(l.sku) = '0')
  )
`;

function skuJoinForSnapshot() {
  return `
    JOIN product_skus ps
      ON ps.marketplace = s.norm_mp
     AND (
       TRIM(ps.sku) = TRIM(l.external_sku)
       OR (
         s.norm_mp = 'ozon'
         AND NULLIF(ps.marketplace_product_id, 0) IS NOT NULL
         AND TRIM(l.external_sku) ~ '^[0-9]+$'
         AND ps.marketplace_product_id = (TRIM(l.external_sku))::bigint
       )
       OR (
         s.norm_mp = 'wb'
         AND (
           TRIM(ps.sku) = NULLIF(split_part(TRIM(l.external_sku), ':', 1), '')
           OR (
             NULLIF(split_part(TRIM(l.external_sku), ':', 2), '') IS NOT NULL
             AND TRIM(ps.sku) = NULLIF(split_part(TRIM(l.external_sku), ':', 2), '')
           )
           OR (
             NULLIF(TRIM(l.wb_vendor_code), '') IS NOT NULL
             AND LOWER(TRIM(ps.sku)) = LOWER(TRIM(l.wb_vendor_code))
           )
         )
       )
     )
    JOIN products p ON p.id = ps.product_id AND p.profile_id = $1`;
}

function classifyTurnover({ stockQty, soldQty, avgDaily, daysOfStock }) {
  if (stockQty > 0 && soldQty <= 0) return { code: 'dead', label: 'Не продаётся' };
  if (stockQty <= 0 && soldQty > 0) return { code: 'stockout', label: 'Нет остатка' };
  if (stockQty <= 0 && soldQty <= 0) return { code: 'empty', label: 'Нет данных' };
  if (avgDaily <= 0) return { code: 'dead', label: 'Не продаётся' };
  if (daysOfStock != null && daysOfStock < 14) return { code: 'fast', label: 'Быстрая' };
  if (daysOfStock != null && daysOfStock <= 45) return { code: 'ok', label: 'Норма' };
  return { code: 'slow', label: 'Медленная' };
}

class MarketplaceTurnoverAnalyticsService {
  async getTurnover({
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
    const days = daysInclusive(fromYmd, toYmd);
    const mpFilter = normalizeMarketplaceFilter(marketplace);
    const schemeNorm = normalizeScheme(scheme);

    const params = [pid, fromYmd, toYmd];
    let mpClause = '';
    if (mpFilter) {
      params.push(mpFilterValues(mpFilter));
      mpClause = `AND LOWER(TRIM(l.marketplace)) = ANY($${params.length}::text[])`;
    }

    try {
      await ensureOzonFinanceSkuLinks(pid, { limit: 50 });
    } catch (e) {
      logger.warn('[Turnover] ensureOzonFinanceSkuLinks failed', e?.message || e);
    }

    const salesSelect = `
      ${SQL_MP_NORM} AS marketplace,
      COALESCE(l.product_id, m.product_id, nm.product_id, 0) AS product_id,
      COALESCE(NULLIF(TRIM(p.sku), ''), NULLIF(TRIM(l.sku), ''), '—') AS sku,
      MAX(COALESCE(p.name, l.product_name, '—')) AS product_name,
      MAX(p.sku) AS erp_sku,
      SUM(CASE WHEN ${SALE_LINE} THEN GREATEST(l.quantity, 0) ELSE 0 END)::numeric AS sold_qty,
      SUM(CASE WHEN ${SALE_LINE} THEN l.retail_amount ELSE 0 END)::numeric AS sold_amount
    `;
    const salesGroup = `
      ${SQL_MP_NORM},
      COALESCE(l.product_id, m.product_id, nm.product_id, 0),
      COALESCE(NULLIF(TRIM(p.sku), ''), NULLIF(TRIM(l.sku), ''), '—')
    `;

    const parts = [];
    if (schemeNorm === 'all' || schemeNorm === 'fbo') {
      parts.push(`
        SELECT ${salesSelect}
        FROM marketplace_fbo_report_lines l
        ${lineProductJoins()}
        WHERE l.profile_id = $1
          AND l.operation_date >= $2::date AND l.operation_date <= $3::date
          ${mpClause}
          ${SQL_EXCLUDE_JUNK}
        GROUP BY ${salesGroup}
      `);
    }
    if (schemeNorm === 'all' || schemeNorm === 'fbs') {
      parts.push(`
        SELECT ${salesSelect}
        FROM marketplace_fbs_report_lines l
        ${lineProductJoins()}
        WHERE l.profile_id = $1
          AND l.operation_date >= $2::date AND l.operation_date <= $3::date
          ${mpClause}
          ${SQL_EXCLUDE_JUNK}
        GROUP BY ${salesGroup}
      `);
    }

    const salesSql = `
      WITH ${sqlOzonSkuMapCte()},
      ${sqlOzonNameMapCte()}
      SELECT
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
      GROUP BY marketplace, product_id, sku
      HAVING SUM(sold_qty) <> 0 OR SUM(sold_amount) <> 0
    `;

    const stockParams = [pid];
    let stockMpClause = '';
    if (mpFilter) {
      stockParams.push(mpFilterValues(mpFilter));
      stockMpClause = `AND s.norm_mp = ANY($${stockParams.length}::text[])`;
    }

    const stockSql = `
      WITH latest AS (
        SELECT DISTINCT ON (norm_mp)
          id,
          norm_mp,
          created_at
        FROM (
          SELECT
            id,
            CASE LOWER(TRIM(marketplace))
              WHEN 'wildberries' THEN 'wb'
              WHEN 'yandex' THEN 'ym'
              WHEN 'yandexmarket' THEN 'ym'
              ELSE LOWER(TRIM(marketplace))
            END AS norm_mp,
            created_at
          FROM marketplace_inventory_snapshots
          WHERE profile_id = $1
        ) raw
        ORDER BY norm_mp, created_at DESC, id DESC
      )
      SELECT
        s.norm_mp AS marketplace,
        p.id AS product_id,
        MAX(p.sku) AS erp_sku,
        MAX(p.name) AS product_name,
        SUM(GREATEST(l.quantity, 0))::int AS stock_qty,
        MAX(s.created_at) AS snapshot_at
      FROM latest s
      JOIN marketplace_inventory_snapshot_lines l
        ON l.snapshot_id = s.id
       AND l.state = 'mp_warehouse'
      ${skuJoinForSnapshot()}
      WHERE 1=1
        ${stockMpClause}
      GROUP BY s.norm_mp, p.id
    `;

    const [salesRes, stockRes] = await Promise.all([
      query(salesSql, params),
      query(stockSql, stockParams).catch((e) => {
        logger.warn('[Turnover] stock snapshot query failed', e?.message || e);
        return { rows: [] };
      }),
    ]);

    const map = new Map();
    const put = (key, patch) => {
      const prev = map.get(key) || {
        marketplace: patch.marketplace,
        productId: patch.productId,
        sku: patch.sku || '—',
        erpSku: patch.erpSku || null,
        productName: patch.productName || '—',
        soldQty: 0,
        soldAmount: 0,
        stockQty: 0,
        snapshotAt: null,
      };
      if (patch.soldQty) prev.soldQty += Number(patch.soldQty) || 0;
      if (patch.soldAmount) prev.soldAmount += Number(patch.soldAmount) || 0;
      if (patch.stockQty) prev.stockQty += Number(patch.stockQty) || 0;
      if (patch.snapshotAt && !prev.snapshotAt) prev.snapshotAt = patch.snapshotAt;
      if ((!prev.erpSku || prev.erpSku === '—') && patch.erpSku) prev.erpSku = patch.erpSku;
      if ((!prev.productName || prev.productName === '—') && patch.productName && patch.productName !== '—') {
        prev.productName = patch.productName;
      }
      if ((!prev.sku || prev.sku === '—') && patch.sku && patch.sku !== '—') prev.sku = patch.sku;
      map.set(key, prev);
    };

    for (const row of salesRes.rows || []) {
      const productId = Number(row.product_id) || 0;
      const mp = String(row.marketplace || '').trim();
      const key = productId > 0 ? `${mp}|p:${productId}` : `${mp}|s:${String(row.sku || '').trim()}`;
      put(key, {
        marketplace: mp,
        productId: productId || null,
        sku: row.sku,
        erpSku: row.erp_sku,
        productName: row.product_name,
        soldQty: Number(row.sold_qty) || 0,
        soldAmount: Number(row.sold_amount) || 0,
      });
    }

    const snapshotAtByMp = {};
    for (const row of stockRes.rows || []) {
      const productId = Number(row.product_id) || 0;
      const mp = String(row.marketplace || '').trim();
      if (row.snapshot_at && !snapshotAtByMp[mp]) snapshotAtByMp[mp] = row.snapshot_at;
      if (productId < 1) continue;
      const key = `${mp}|p:${productId}`;
      put(key, {
        marketplace: mp,
        productId,
        sku: row.erp_sku,
        erpSku: row.erp_sku,
        productName: row.product_name,
        stockQty: Number(row.stock_qty) || 0,
        snapshotAt: row.snapshot_at,
      });
    }

    const items = [...map.values()]
      .map((row) => {
        const soldQty = Number(row.soldQty) || 0;
        const stockQty = Number(row.stockQty) || 0;
        const avgDaily = Math.round((soldQty / days) * 100) / 100;
        const daysOfStock =
          avgDaily > 0 ? Math.round((stockQty / avgDaily) * 10) / 10 : stockQty > 0 ? null : 0;
        const turnover =
          stockQty > 0 ? Math.round((soldQty / stockQty) * 100) / 100 : soldQty > 0 ? null : 0;
        const status = classifyTurnover({ stockQty, soldQty, avgDaily, daysOfStock });
        return {
          marketplace: row.marketplace,
          productId: row.productId,
          sku: row.sku,
          erpSku: row.erpSku,
          productName: row.productName,
          soldQty,
          soldAmount: Number(row.soldAmount) || 0,
          avgDaily,
          stockQty,
          daysOfStock,
          turnover,
          status: status.code,
          statusLabel: status.label,
        };
      })
      .filter((r) => r.soldQty > 0 || r.stockQty > 0)
      .sort((a, b) => {
        const da = a.daysOfStock == null ? 1e9 : a.daysOfStock;
        const db = b.daysOfStock == null ? 1e9 : b.daysOfStock;
        if (a.status === 'dead' && b.status !== 'dead') return -1;
        if (b.status === 'dead' && a.status !== 'dead') return 1;
        return db - da || (b.stockQty - a.stockQty);
      });

    const summary = {
      productsCount: items.length,
      soldQty: items.reduce((s, r) => s + r.soldQty, 0),
      soldAmount: items.reduce((s, r) => s + r.soldAmount, 0),
      stockQty: items.reduce((s, r) => s + r.stockQty, 0),
      deadCount: items.filter((r) => r.status === 'dead').length,
      stockoutCount: items.filter((r) => r.status === 'stockout').length,
      slowCount: items.filter((r) => r.status === 'slow').length,
      fastCount: items.filter((r) => r.status === 'fast').length,
    };

    return {
      period: { dateFrom: fromYmd, dateTo: toYmd, days },
      marketplace: mpFilter ? marketplace : 'all',
      scheme: schemeNorm,
      snapshotAtByMp,
      summary,
      items,
    };
  }
}

export default new MarketplaceTurnoverAnalyticsService();
