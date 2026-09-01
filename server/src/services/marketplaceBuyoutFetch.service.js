/**
 * Загрузка % выкупа из API маркетплейсов (не из финотчётов ERP).
 */

import { query } from '../config/database.js';
import logger from '../utils/logger.js';
import integrationsService from './integrations.service.js';
import { computeBuyoutFromMpAnalytics, computeBuyoutPercent } from '../utils/marketplaceBuyoutRate.js';

const OZON_ANALYTICS_URL = 'https://api-seller.ozon.ru/v1/analytics/data';
const WB_SALES_FUNNEL_URL =
  'https://seller-analytics-api.wildberries.ru/api/analytics/v3/sales-funnel/products';

function windowDays(options = {}) {
  const fromOpt = Number(options.windowDays);
  if (Number.isFinite(fromOpt) && fromOpt >= 7 && fromOpt <= 180) return Math.round(fromOpt);
  const n = Number(process.env.BUYOUT_RATE_WINDOW_DAYS);
  return Number.isFinite(n) && n >= 7 && n <= 180 ? Math.round(n) : 30;
}

function minUnits(options = {}) {
  const fromOpt = Number(options.minUnits);
  if (Number.isFinite(fromOpt) && fromOpt >= 1) return Math.round(fromOpt);
  const n = Number(process.env.BUYOUT_RATE_MIN_UNITS);
  return Number.isFinite(n) && n >= 1 ? Math.round(n) : 3;
}

function fetchDelayMs() {
  const n = Number(process.env.BUYOUT_RATE_FETCH_DELAY_MS);
  return Number.isFinite(n) && n >= 0 ? n : 350;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dateRangeYmd(days) {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - days);
  const fmt = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };
  return { dateFrom: fmt(from), dateTo: fmt(to) };
}

function averageOf(rates) {
  const vals = [rates.ozon, rates.wb, rates.ym].filter((v) => v != null && Number.isFinite(v));
  if (!vals.length) return null;
  return Math.round(vals.reduce((s, x) => s + x, 0) / vals.length);
}

function parseWbNmId(product) {
  const fromPs = Number(product.wb_nm_id);
  if (Number.isFinite(fromPs) && fromPs > 0) return fromPs;
  let draft = product.wb_draft;
  if (typeof draft === 'string') {
    try {
      draft = JSON.parse(draft);
    } catch {
      draft = null;
    }
  }
  const fromDraft = Number(draft?.nmId ?? draft?.nmID ?? draft?.nm_id);
  return Number.isFinite(fromDraft) && fromDraft > 0 ? fromDraft : null;
}

function readOzonMetrics(item) {
  const m = item?.metrics;
  if (m && typeof m === 'object' && !Array.isArray(m)) {
    return {
      ordered: Number(m.ordered_units) || 0,
      delivered: Number(m.delivered_units) || 0,
      returns: Number(m.returns) || 0,
    };
  }
  if (Array.isArray(m)) {
    return {
      ordered: Number(m[0]) || 0,
      delivered: Number(m[1]) || 0,
      returns: Number(m[2]) || 0,
    };
  }
  return { ordered: 0, delivered: 0, returns: 0 };
}

function ozonKeyFromRow(item) {
  const dim = Array.isArray(item?.dimensions) ? item.dimensions[0] : null;
  if (dim?.id != null && String(dim.id).trim() !== '') return String(dim.id).trim();
  return null;
}

function resolveOzonBuyoutPct(ozonMap, productRow) {
  const keys = [productRow.ozon_sku_id, productRow.ozon_offer_id]
    .map((k) => (k != null ? String(k).trim() : ''))
    .filter(Boolean);
  for (const key of keys) {
    const pct = ozonMap.get(key) ?? ozonMap.get(key.toLowerCase());
    if (pct != null) return pct;
  }
  return null;
}

async function loadProductMpRows(profileId) {
  const r = await query(
    `SELECT
       p.id,
       p.organization_id,
       p.wb_draft,
       MAX(CASE WHEN ps.marketplace = 'ozon' THEN NULLIF(TRIM(ps.mp_extra->>'ozon_sku'), '') END) AS ozon_sku_id,
       MAX(CASE WHEN ps.marketplace = 'ozon' THEN ps.sku END) AS ozon_offer_id,
       MAX(CASE WHEN ps.marketplace = 'wb' THEN ps.sku END) AS wb_sku,
       MAX(CASE WHEN ps.marketplace = 'wb' THEN ps.marketplace_product_id END) AS wb_nm_id,
       MAX(CASE WHEN ps.marketplace = 'ym' THEN ps.sku END) AS ym_sku
     FROM products p
     LEFT JOIN product_skus ps ON ps.product_id = p.id
     WHERE p.profile_id = $1
     GROUP BY p.id, p.organization_id, p.wb_draft
     ORDER BY p.id ASC`,
    [profileId]
  );
  return r.rows || [];
}

async function fetchOzonBuyoutMap(scope, days, minSample) {
  const cfg = await integrationsService.getMarketplaceConfig('ozon', scope);
  if (!cfg?.client_id || !cfg?.api_key) return new Map();

  const { dateFrom, dateTo } = dateRangeYmd(days);
  const map = new Map();
  let offset = 0;
  const limit = 1000;

  while (true) {
    let response;
    try {
      response = await fetch(OZON_ANALYTICS_URL, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'Client-Id': String(cfg.client_id),
          'Api-Key': String(cfg.api_key),
        },
        body: JSON.stringify({
          date_from: dateFrom,
          date_to: dateTo,
          dimension: ['sku'],
          metrics: ['ordered_units', 'delivered_units', 'returns'],
          limit,
          offset,
        }),
      });
    } catch (e) {
      logger.warn('[BuyoutFetch] Ozon analytics request failed', { message: e?.message || String(e) });
      break;
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      logger.warn('[BuyoutFetch] Ozon analytics error', {
        status: response.status,
        body: text.slice(0, 300),
        organizationId: scope.organizationId ?? null,
      });
      break;
    }

    const data = await response.json();
    const rows = data?.result?.data;
    if (!Array.isArray(rows) || !rows.length) break;

    for (const row of rows) {
      const ozonKey = ozonKeyFromRow(row);
      if (!ozonKey) continue;
      const pct = computeBuyoutFromMpAnalytics(readOzonMetrics(row), minSample);
      if (pct != null) map.set(ozonKey, pct);
    }

    if (rows.length < limit) break;
    offset += limit;
    await sleep(fetchDelayMs());
  }

  return map;
}

async function fetchWbBuyoutMap(scope, days) {
  const cfg = await integrationsService.getMarketplaceConfig('wildberries', scope);
  const apiKey = cfg?.api_key || cfg?.token;
  if (!apiKey) return new Map();

  const { dateFrom, dateTo } = dateRangeYmd(days);
  const map = new Map();
  let offset = 0;
  const limit = 1000;

  while (true) {
    let response;
    try {
      response = await fetch(WB_SALES_FUNNEL_URL, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: String(apiKey),
        },
        body: JSON.stringify({
          selectedPeriod: { start: dateFrom, end: dateTo },
          skipDeletedNm: true,
          limit,
          offset,
        }),
      });
    } catch (e) {
      logger.warn('[BuyoutFetch] WB sales funnel request failed', { message: e?.message || String(e) });
      break;
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      logger.warn('[BuyoutFetch] WB sales funnel error', {
        status: response.status,
        body: text.slice(0, 300),
        organizationId: scope.organizationId ?? null,
      });
      break;
    }

    const data = await response.json();
    const products = data?.data?.products ?? data?.products ?? [];
    if (!Array.isArray(products) || !products.length) break;

    for (const entry of products) {
      const nmId = Number(entry?.product?.nmId ?? entry?.product?.nmID);
      const pctRaw =
        entry?.statistic?.selected?.conversions?.buyoutPercent ??
        entry?.statistic?.selected?.buyoutPercent;
      const pct = Number(pctRaw);
      if (Number.isFinite(nmId) && nmId > 0 && Number.isFinite(pct)) {
        map.set(nmId, Math.max(0, Math.min(100, Math.round(pct))));
      }
    }

    if (products.length < limit) break;
    offset += limit;
    await sleep(fetchDelayMs());
  }

  return map;
}

/** YM: заказы, синхронизированные с API МП (не финотчёты). */
async function loadYmBuyoutFromOrders(profileId, days, minSample) {
  const r = await query(
    `SELECT
       o.product_id,
       SUM(CASE WHEN LOWER(TRIM(o.status)) = 'delivered'
         THEN GREATEST(COALESCE(o.quantity, 1), 1) ELSE 0 END)::float AS delivered_qty,
       SUM(CASE WHEN LOWER(TRIM(o.status)) IN ('cancelled', 'canceled')
         THEN GREATEST(COALESCE(o.quantity, 1), 1) ELSE 0 END)::float AS cancelled_qty
     FROM orders o
     WHERE o.profile_id = $1
       AND o.product_id IS NOT NULL
       AND LOWER(TRIM(o.marketplace)) IN ('ym', 'yandex', 'yandexmarket')
       AND LOWER(TRIM(o.status)) IN ('delivered', 'cancelled', 'canceled')
       AND COALESCE(o.terminal_status_at, o.created_at, o.updated_at)
           >= (CURRENT_TIMESTAMP - ($2::text || ' days')::interval)
     GROUP BY o.product_id`,
    [profileId, String(days)]
  );
  const map = new Map();
  for (const row of r.rows || []) {
    const pct = computeBuyoutPercent(row.delivered_qty, row.cancelled_qty, minSample);
    if (pct != null) map.set(Number(row.product_id), pct);
  }
  return map;
}

function groupProductsByOrg(products) {
  const groups = new Map();
  for (const p of products) {
    const orgKey =
      p.organization_id != null && String(p.organization_id).trim() !== ''
        ? String(p.organization_id)
        : '__profile__';
    if (!groups.has(orgKey)) groups.set(orgKey, []);
    groups.get(orgKey).push(p);
  }
  return groups;
}

/**
 * Загрузить % выкупа с маркетплейсов и обновить товары профиля.
 */
export async function fetchMarketplaceBuyoutRatesForProfile(profileId, options = {}) {
  const pid = Number(profileId);
  if (!Number.isFinite(pid) || pid < 1) {
    return { ok: false, error: 'invalid_profile' };
  }

  const days = windowDays(options);
  const minSample = minUnits(options);
  const products = await loadProductMpRows(pid);
  if (!products.length) {
    return { ok: true, profileId: pid, windowDays: days, productsWithData: 0, updated: 0 };
  }

  const ymMap = await loadYmBuyoutFromOrders(pid, days, minSample);
  const byProduct = new Map();

  for (const [orgKey, orgProducts] of groupProductsByOrg(products)) {
    const scope =
      orgKey === '__profile__'
        ? { profileId: pid }
        : { profileId: pid, organizationId: Number(orgKey) };

    const [ozonMap, wbMap] = await Promise.all([
      fetchOzonBuyoutMap(scope, days, minSample),
      fetchWbBuyoutMap(scope, days),
    ]);

    for (const p of orgProducts) {
      const productId = Number(p.id);
      const rates = {};

      const ozonPct = resolveOzonBuyoutPct(ozonMap, p);
      if (ozonPct != null) rates.ozon = ozonPct;

      const wbNmId = parseWbNmId(p);
      if (wbNmId != null) {
        const pct = wbMap.get(wbNmId);
        if (pct != null) rates.wb = pct;
      }

      const ymPct = ymMap.get(productId);
      if (ymPct != null) rates.ym = ymPct;

      if (rates.ozon != null || rates.wb != null || rates.ym != null) {
        rates.avg = averageOf(rates);
        byProduct.set(productId, rates);
      }
    }
  }

  let updated = 0;
  const ids = [...byProduct.keys()];
  const chunkSize = 200;
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const values = [];
    const params = [];
    let n = 1;
    for (const productId of chunk) {
      const rates = byProduct.get(productId) || {};
      values.push(`($${n++}::bigint, $${n++}::int, $${n++}::int, $${n++}::int, $${n++}::int)`);
      params.push(productId, rates.ozon ?? null, rates.wb ?? null, rates.ym ?? null, rates.avg ?? null);
    }
    const result = await query(
      `UPDATE products p
       SET
         buyout_rate_ozon = COALESCE(v.ozon, p.buyout_rate_ozon),
         buyout_rate_wb = COALESCE(v.wb, p.buyout_rate_wb),
         buyout_rate_ym = COALESCE(v.ym, p.buyout_rate_ym),
         buyout_rate = COALESCE(v.avg, p.buyout_rate),
         updated_at = CURRENT_TIMESTAMP
       FROM (VALUES ${values.join(', ')}) AS v(product_id, ozon, wb, ym, avg)
       WHERE p.id = v.product_id AND p.profile_id = $${n}`,
      [...params, pid]
    );
    updated += result.rowCount || 0;
  }

  logger.info('[BuyoutFetch] Profile sync done', {
    profileId: pid,
    days,
    minSample,
    productsWithData: ids.length,
    updated,
  });

  return {
    ok: true,
    profileId: pid,
    windowDays: days,
    minUnits: minSample,
    productsWithData: ids.length,
    updated,
    source: 'marketplace_api',
  };
}

export async function fetchMarketplaceBuyoutRatesForAllProfiles(options = {}) {
  const r = await query(`SELECT id FROM profiles ORDER BY id`);
  const results = [];
  for (const row of r.rows || []) {
    try {
      results.push(await fetchMarketplaceBuyoutRatesForProfile(row.id, options));
    } catch (e) {
      logger.error('[BuyoutFetch] profile failed', {
        profileId: row.id,
        message: e?.message || String(e),
      });
      results.push({ ok: false, profileId: Number(row.id), error: e?.message || String(e) });
    }
  }
  return { ok: true, results };
}

/**
 * Синхронизировать % выкупа одного товара с API маркетплейсов.
 */
export async function syncMarketplaceBuyoutForProduct(productId, options = {}) {
  const pid = Number(productId);
  if (!Number.isFinite(pid) || pid < 1) {
    return { ok: false, error: 'invalid_product' };
  }

  const days = windowDays(options);
  const minSample = minUnits(options);

  const r = await query(
    `SELECT p.id, p.profile_id, p.organization_id, p.wb_draft,
            p.buyout_rate, p.buyout_rate_ozon, p.buyout_rate_wb, p.buyout_rate_ym,
            MAX(CASE WHEN ps.marketplace = 'ozon' THEN NULLIF(TRIM(ps.mp_extra->>'ozon_sku'), '') END) AS ozon_sku_id,
            MAX(CASE WHEN ps.marketplace = 'ozon' THEN ps.sku END) AS ozon_offer_id,
            MAX(CASE WHEN ps.marketplace = 'wb' THEN ps.sku END) AS wb_sku,
            MAX(CASE WHEN ps.marketplace = 'wb' THEN ps.marketplace_product_id END) AS wb_nm_id,
            MAX(CASE WHEN ps.marketplace = 'ym' THEN ps.sku END) AS ym_sku
     FROM products p
     LEFT JOIN product_skus ps ON ps.product_id = p.id
     WHERE p.id = $1
     GROUP BY p.id, p.profile_id, p.organization_id, p.wb_draft,
              p.buyout_rate, p.buyout_rate_ozon, p.buyout_rate_wb, p.buyout_rate_ym`,
    [pid]
  );
  const p = r.rows?.[0];
  if (!p) return { ok: false, error: 'product_not_found' };

  const profileId = Number(p.profile_id);
  const scope = {
    profileId,
    ...(p.organization_id != null ? { organizationId: Number(p.organization_id) } : {}),
  };

  const rates = {};
  const ozonPct = resolveOzonBuyoutPct(await fetchOzonBuyoutMap(scope, days, minSample), p);
  if (ozonPct != null) rates.ozon = ozonPct;

  const wbNmId = parseWbNmId(p);
  if (wbNmId != null) {
    const pct = (await fetchWbBuyoutMap(scope, days)).get(wbNmId);
    if (pct != null) rates.wb = pct;
  }

  const ymPct = (await loadYmBuyoutFromOrders(profileId, days, minSample)).get(pid);
  if (ymPct != null) rates.ym = ymPct;

  if (rates.ozon == null && rates.wb == null && rates.ym == null) {
    return { ok: true, productId: pid, updated: false, reason: 'no_marketplace_data' };
  }

  const avg = averageOf(rates);
  await query(
    `UPDATE products
     SET buyout_rate_ozon = COALESCE($2, buyout_rate_ozon),
         buyout_rate_wb = COALESCE($3, buyout_rate_wb),
         buyout_rate_ym = COALESCE($4, buyout_rate_ym),
         buyout_rate = COALESCE($5, buyout_rate),
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [pid, rates.ozon ?? null, rates.wb ?? null, rates.ym ?? null, avg]
  );

  return {
    ok: true,
    productId: pid,
    updated: true,
    buyoutRates: {
      ozon: rates.ozon ?? p.buyout_rate_ozon,
      wb: rates.wb ?? p.buyout_rate_wb,
      ym: rates.ym ?? p.buyout_rate_ym,
      average: avg ?? p.buyout_rate,
    },
    source: 'marketplace_api',
  };
}

export default {
  fetchMarketplaceBuyoutRatesForProfile,
  fetchMarketplaceBuyoutRatesForAllProfiles,
  syncMarketplaceBuyoutForProduct,
};
