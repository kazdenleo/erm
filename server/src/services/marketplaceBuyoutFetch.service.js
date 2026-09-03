/**
 * Загрузка % выкупа из API маркетплейсов (не из финотчётов ERP).
 */

import { query } from '../config/database.js';
import logger from '../utils/logger.js';
import ExcelJS from 'exceljs';
import integrationsService from './integrations.service.js';
import { computeBuyoutFromMpAnalytics, computeBuyoutPercent } from '../utils/marketplaceBuyoutRate.js';
import { getYandexHttpsAgent, formatYandexNetworkError } from '../utils/yandex-https-agent.js';

const OZON_ANALYTICS_URL = 'https://api-seller.ozon.ru/v1/analytics/data';
const WB_SALES_FUNNEL_URL =
  'https://seller-analytics-api.wildberries.ru/api/analytics/v3/sales-funnel/products';
const YM_API = 'https://api.partner.market.yandex.ru';

/** Кэш shows-sales: 1 генерация / 10 мин на businessId у YM. */
const ymShowsSalesCache = new Map();
const YM_SHOWS_SALES_CACHE_MS = 15 * 60 * 1000;

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
  // 0% = нет статистики (часто у SKU без продаж), в среднее не берём
  const vals = [rates.ozon, rates.wb, rates.ym].filter(
    (v) => v != null && Number.isFinite(v) && v > 0
  );
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

/** Ozon Analytics ключуется market sku; в mp_extra бывает ozon_sku / ozonSku. */
const OZON_SKU_SQL = `NULLIF(TRIM(COALESCE(
  ps.mp_extra->>'ozon_sku',
  ps.mp_extra->>'ozonSku',
  ps.mp_extra->>'marketSku'
)), '')`;

async function loadProductMpRows(profileId) {
  const r = await query(
    `SELECT
       p.id,
       p.organization_id,
       p.wb_draft,
       MAX(CASE WHEN ps.marketplace = 'ozon' THEN ${OZON_SKU_SQL} END) AS ozon_sku_id,
       MAX(CASE WHEN ps.marketplace = 'ozon' THEN ps.sku END) AS ozon_offer_id,
       MAX(CASE WHEN ps.marketplace = 'ozon' THEN ps.marketplace_product_id END) AS ozon_product_id,
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

function pickOzonMarketSkuFromInfo(info) {
  const candidates = [
    info?.sku,
    info?.ozon_sku,
    info?.ozonSku,
    ...(Array.isArray(info?.sources) ? info.sources.map((s) => s?.sku) : []),
    ...(Array.isArray(info?.stocks?.stocks) ? info.stocks.stocks.map((s) => s?.sku) : []),
  ];
  for (const sku of candidates) {
    const skuStr = sku != null ? String(sku).trim() : '';
    if (skuStr && /^\d+$/.test(skuStr)) return skuStr;
  }
  return null;
}

/**
 * Добирает market sku в mp_extra для товаров без ozon_sku (иначе analytics не матчится).
 */
async function backfillMissingOzonSkus(orgProducts, scope) {
  const need = orgProducts.filter(
    (p) =>
      (!p.ozon_sku_id || String(p.ozon_sku_id).trim() === '') &&
      ((p.ozon_offer_id && String(p.ozon_offer_id).trim() !== '') ||
        (p.ozon_product_id && String(p.ozon_product_id).trim() !== ''))
  );
  if (!need.length) return 0;

  let filled = 0;
  const chunkSize = 50;
  for (let i = 0; i < need.length; i += chunkSize) {
    const chunk = need.slice(i, i + chunkSize);
    const offerIds = [
      ...new Set(
        chunk
          .map((p) => (p.ozon_offer_id != null ? String(p.ozon_offer_id).trim() : ''))
          .filter(Boolean)
      ),
    ];
    const productIds = [
      ...new Set(
        chunk
          .map((p) => Number(p.ozon_product_id))
          .filter((n) => Number.isFinite(n) && n > 0)
      ),
    ];

    let items = [];
    try {
      if (offerIds.length) {
        const data = await integrationsService._ozonApiPost(
          '/v3/product/info/list',
          { offer_id: offerIds },
          {
            profileId: scope.profileId ?? null,
            organizationId: scope.organizationId != null ? String(scope.organizationId) : null,
          }
        );
        items = data?.result?.items ?? data?.items ?? [];
      }
      if (!items.length && productIds.length) {
        const data = await integrationsService._ozonApiPost(
          '/v3/product/info/list',
          { product_id: productIds },
          {
            profileId: scope.profileId ?? null,
            organizationId: scope.organizationId != null ? String(scope.organizationId) : null,
          }
        );
        items = data?.result?.items ?? data?.items ?? [];
      }
    } catch (e) {
      logger.warn('[BuyoutFetch] Ozon sku backfill failed', {
        message: e?.message || String(e),
        organizationId: scope.organizationId ?? null,
      });
      break;
    }

    const byOffer = new Map();
    const byProductId = new Map();
    for (const item of items) {
      const sku = pickOzonMarketSkuFromInfo(item);
      if (!sku) continue;
      if (item?.offer_id != null) byOffer.set(String(item.offer_id).trim(), sku);
      if (item?.id != null) byProductId.set(String(item.id).trim(), sku);
    }

    for (const p of chunk) {
      const offer = p.ozon_offer_id != null ? String(p.ozon_offer_id).trim() : '';
      const pid = p.ozon_product_id != null ? String(p.ozon_product_id).trim() : '';
      const sku = (offer && byOffer.get(offer)) || (pid && byProductId.get(pid)) || null;
      if (!sku) continue;
      p.ozon_sku_id = sku;
      try {
        await query(
          `UPDATE product_skus
           SET mp_extra = COALESCE(mp_extra, '{}'::jsonb) || $2::jsonb
           WHERE product_id = $1 AND marketplace = 'ozon'`,
          [Number(p.id), JSON.stringify({ ozon_sku: sku, ozonSku: sku })]
        );
        filled += 1;
      } catch (e) {
        logger.warn('[BuyoutFetch] mp_extra ozon_sku patch failed', {
          productId: p.id,
          message: e?.message || String(e),
        });
      }
    }

    await sleep(fetchDelayMs());
  }

  if (filled) {
    logger.info('[BuyoutFetch] Backfilled ozon_sku', {
      filled,
      needed: need.length,
      organizationId: scope.organizationId ?? null,
    });
  }
  return filled;
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
      // WB часто отдаёт 0% без продаж — это не реальный выкуп, пропускаем
      if (Number.isFinite(nmId) && nmId > 0 && Number.isFinite(pct) && pct > 0) {
        map.set(nmId, Math.max(1, Math.min(100, Math.round(pct))));
      }
    }

    if (products.length < limit) break;
    offset += limit;
    await sleep(fetchDelayMs());
  }

  return map;
}

/** YM: заказы, синхронизированные с API МП (fallback, если нет shows-sales). */
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

function ymNormOfferKey(raw) {
  if (raw == null) return '';
  let s = String(raw).trim();
  while (s.endsWith(';')) s = s.slice(0, -1).trim();
  return s;
}

function ymNumCell(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const n = Number(String(v).replace(/\s/g, '').replace(',', '.').replace(/[^\d.\-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function ymShowsSalesHeaderField(header) {
  const raw = String(header || '').trim();
  const h = raw
    .toLowerCase()
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!h) return null;

  // Точные JSON/CSV-имена из доки YM
  const exact = {
    offerid: 'offerId',
    offer_id: 'offerId',
    shopsku: 'offerId',
    shop_sku: 'offerId',
    orderitems: 'orderItems',
    order_items: 'orderItems',
    orderitemsdeliveredfromorderedcount: 'deliveredFromOrdered',
    order_items_delivered_from_ordered_count: 'deliveredFromOrdered',
    orderitemscanceledbycreatedatcount: 'canceledFromOrdered',
    order_items_canceled_by_created_at_count: 'canceledFromOrdered',
    orderitemscanceledcount: 'canceled',
    order_items_canceled_count: 'canceled',
    orderitemsreturnedcount: 'returned',
    order_items_returned_count: 'returned',
  };
  const compact = h.replace(/[^a-z0-9_]/g, '');
  if (exact[compact]) return exact[compact];

  if (h.includes('ваш sku') || h === 'sku' || h === 'offer id') return 'offerId';

  // Только штуки, не суммы (₽)
  const isMoney = h.includes('сумм') || h.includes('₽') || h.includes('руб');
  if (isMoney) return null;

  if (h.includes('доставлено из заказан') && h.includes('шт')) {
    return 'deliveredFromOrdered';
  }
  if (h.includes('отмены и невыкупы заказанного') && h.includes('шт')) {
    return 'canceledFromOrdered';
  }
  if (h.includes('отмены и невыкупы') && h.includes('шт')) {
    return 'canceled';
  }
  if (h.includes('возвращ') && h.includes('товар') && h.includes('шт')) {
    return 'returned';
  }
  // «Заказанные товары, шт.» / «Заказано товаров»
  if (
    (h.includes('заказанн') || h.includes('заказано')) &&
    h.includes('шт') &&
    !h.includes('акци') &&
    !h.includes('достав') &&
    !h.includes('отмен') &&
    !h.includes('невыкуп') &&
    !h.includes('возврат') &&
    !h.includes('доля') &&
    !h.includes('буст')
  ) {
    return 'orderItems';
  }
  return null;
}

function normalizeYmShowsSalesCell(cell) {
  if (!cell) return '';
  let v = cell.value;
  if (v == null) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if (v.richText && Array.isArray(v.richText)) return v.richText.map((t) => t.text || '').join('');
    if (v.text != null) return String(v.text);
    if (v.result != null) return normalizeYmShowsSalesCell({ value: v.result });
  }
  return String(v).trim();
}

async function parseYmShowsSalesXlsx(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const rows = [];
  const debugHeaders = [];

  for (const sheet of wb.worksheets) {
    if (!sheet || sheet.rowCount < 2) continue;
    let headerRowNum = 1;
    let fieldByCol = null;
    let bestHits = 0;

    for (let r = 1; r <= Math.min(15, sheet.rowCount || 15); r += 1) {
      const row = sheet.getRow(r);
      const mapping = {};
      const headerLabels = [];
      row.eachCell({ includeEmpty: false }, (cell, col) => {
        const label = normalizeYmShowsSalesCell(cell);
        headerLabels.push(String(label));
        const field = ymShowsSalesHeaderField(label);
        if (field) mapping[col] = field;
      });
      const values = Object.values(mapping);
      const hits = values.length;
      const hasOffer = values.includes('offerId');
      const hasOrdered = values.includes('orderItems');
      if (hasOffer) {
        debugHeaders.push({ sheet: sheet.name, row: r, hits, headers: headerLabels.slice(0, 40) });
      }
      const score = hits + (hasOffer ? 5 : 0) + (hasOrdered ? 10 : 0);
      if (hasOffer && score > bestHits) {
        bestHits = score;
        headerRowNum = r;
        fieldByCol = mapping;
      }
    }

    if (!fieldByCol || !Object.values(fieldByCol).includes('offerId')) continue;

    for (let r = headerRowNum + 1; r <= sheet.rowCount; r += 1) {
      const row = sheet.getRow(r);
      const obj = {};
      for (const [col, field] of Object.entries(fieldByCol)) {
        // первая колонка поля побеждает (не перетирать шт. суммой ₽)
        if (obj[field] != null && obj[field] !== '') continue;
        obj[field] = normalizeYmShowsSalesCell(row.getCell(Number(col)));
      }
      const offerId = ymNormOfferKey(obj.offerId);
      if (!offerId) continue;
      rows.push({
        offerId,
        orderItems: ymNumCell(obj.orderItems),
        deliveredFromOrdered: ymNumCell(obj.deliveredFromOrdered),
        canceledFromOrdered: ymNumCell(obj.canceledFromOrdered),
        canceled: ymNumCell(obj.canceled),
        returned: ymNumCell(obj.returned),
      });
    }
  }

  if (rows.length && rows.every((r) => !(r.orderItems > 0))) {
    logger.warn('[BuyoutFetch] YM shows-sales: rows without orderItems — check headers', {
      samples: debugHeaders.slice(0, 3),
    });
  }

  return rows;
}

function ymBuyoutPctFromShowsSalesRow(row, minSample) {
  const ordered = Math.max(0, Number(row.orderItems) || 0);
  if (ordered < minSample) return null;

  const canceled =
    Math.max(0, Number(row.canceledFromOrdered) || 0) || Math.max(0, Number(row.canceled) || 0);
  let deliveredFromOrdered = Math.max(0, Number(row.deliveredFromOrdered) || 0);
  // защита: если по ошибке попала сумма ₽, delivered >> ordered
  if (deliveredFromOrdered > ordered) deliveredFromOrdered = 0;

  if (deliveredFromOrdered > 0 || canceled > 0) {
    const kept = deliveredFromOrdered > 0 ? deliveredFromOrdered : Math.max(0, ordered - canceled);
    const pct = Math.max(0, Math.min(100, Math.round((kept / ordered) * 100)));
    return pct > 0 ? pct : null;
  }

  // Есть заказы, но ещё нет финальных статусов доставки/отмен — не затираем
  return null;
}

/**
 * YM «Аналитика продаж» (shows-sales, grouping=OFFERS) → Map(offerId → % выкупа).
 * @returns {Promise<Map<string, number>>}
 */
async function fetchYmBuyoutMapFromShowsSales(scope, days, minSample) {
  const map = new Map();
  let ctx;
  try {
    ctx = await integrationsService._resolveYandexBusinessApiContext(scope);
  } catch (e) {
    logger.warn('[BuyoutFetch] YM credentials missing for shows-sales', {
      message: e?.message || String(e),
      profileId: scope?.profileId ?? null,
      organizationId: scope?.organizationId ?? null,
    });
    return map;
  }

  const cacheKey = `${ctx.businessId}:${days}:${minSample}`;
  const cached = ymShowsSalesCache.get(cacheKey);
  if (cached && Date.now() - cached.at < YM_SHOWS_SALES_CACHE_MS) {
    return new Map(cached.map);
  }

  const { dateFrom, dateTo } = dateRangeYmd(days);
  const agent = getYandexHttpsAgent();
  const headers = {
    'Api-Key': ctx.apiKey,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };

  let genRes;
  try {
    genRes = await fetch(`${YM_API}/v2/reports/shows-sales/generate?format=FILE&language=RU`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        businessId: Number(ctx.businessId),
        dateFrom,
        dateTo,
        grouping: 'OFFERS',
      }),
      ...(agent ? { agent } : {}),
    });
  } catch (e) {
    logger.warn('[BuyoutFetch] YM shows-sales generate failed', {
      message: formatYandexNetworkError(e),
    });
    return map;
  }

  if (!genRes.ok) {
    const text = await genRes.text().catch(() => '');
    logger.warn('[BuyoutFetch] YM shows-sales generate HTTP', {
      status: genRes.status,
      body: text.slice(0, 300),
    });
    return map;
  }

  const genData = await genRes.json().catch(() => null);
  const reportId = genData?.result?.reportId;
  if (!reportId) {
    logger.warn('[BuyoutFetch] YM shows-sales: no reportId');
    return map;
  }

  const waitMs = Math.max(5000, Number(genData?.result?.estimatedGenerationTime) || 20000);
  const deadline = Date.now() + Math.min(12 * 60 * 1000, waitMs + 8 * 60 * 1000);
  let fileUrl = null;

  while (Date.now() < deadline) {
    let infoRes;
    try {
      infoRes = await fetch(`${YM_API}/v2/reports/info/${encodeURIComponent(String(reportId))}`, {
        method: 'GET',
        headers,
        ...(agent ? { agent } : {}),
      });
    } catch (e) {
      logger.warn('[BuyoutFetch] YM shows-sales info failed', {
        message: formatYandexNetworkError(e),
      });
      return map;
    }

    if (!infoRes.ok) {
      logger.warn('[BuyoutFetch] YM shows-sales info HTTP', { status: infoRes.status });
      return map;
    }

    const info = await infoRes.json().catch(() => null);
    const status = String(info?.result?.status || info?.status || '').toUpperCase();
    if (status === 'FAILED' || status === 'ERROR') {
      logger.warn('[BuyoutFetch] YM shows-sales generation failed', {
        error: info?.result?.error || info?.errors?.[0]?.message,
      });
      return map;
    }

    fileUrl = info?.result?.file ?? info?.result?.url ?? info?.result?.downloadUrl ?? null;
    if (status === 'DONE' && fileUrl) break;

    const nextWait = Math.min(20000, Math.max(4000, Number(info?.result?.estimatedGenerationTime) || waitMs));
    await sleep(nextWait);
  }

  if (!fileUrl) {
    logger.warn('[BuyoutFetch] YM shows-sales: timeout waiting for report');
    return map;
  }

  let buffer;
  try {
    const fileRes = await fetch(fileUrl, { ...(agent ? { agent } : {}) });
    if (!fileRes.ok) {
      logger.warn('[BuyoutFetch] YM shows-sales download HTTP', { status: fileRes.status });
      return map;
    }
    buffer = Buffer.from(await fileRes.arrayBuffer());
  } catch (e) {
    logger.warn('[BuyoutFetch] YM shows-sales download failed', {
      message: e?.message || String(e),
    });
    return map;
  }

  let rows = [];
  try {
    rows = await parseYmShowsSalesXlsx(buffer);
  } catch (e) {
    logger.warn('[BuyoutFetch] YM shows-sales parse failed', {
      message: e?.message || String(e),
    });
    return map;
  }

  // Несколько строк на один offer (по дням/категориям) — суммируем.
  const agg = new Map();
  for (const row of rows) {
    const key = ymNormOfferKey(row.offerId);
    if (!key) continue;
    const prev = agg.get(key) || {
      orderItems: 0,
      deliveredFromOrdered: 0,
      canceledFromOrdered: 0,
      canceled: 0,
      returned: 0,
    };
    prev.orderItems += row.orderItems;
    prev.deliveredFromOrdered += row.deliveredFromOrdered;
    prev.canceledFromOrdered += row.canceledFromOrdered;
    prev.canceled += row.canceled;
    prev.returned += row.returned;
    agg.set(key, prev);
  }

  for (const [offerId, metrics] of agg) {
    const pct = ymBuyoutPctFromShowsSalesRow(metrics, minSample);
    if (pct != null) {
      map.set(offerId, pct);
      map.set(offerId.toLowerCase(), pct);
    }
  }

  logger.info('[BuyoutFetch] YM shows-sales parsed', {
    rows: rows.length,
    offersWithBuyout: Math.round(map.size / 2),
    businessId: ctx.businessId,
    dateFrom,
    dateTo,
  });

  ymShowsSalesCache.set(cacheKey, { at: Date.now(), map: new Map(map) });
  return map;
}

function resolveYmBuyoutPct(ymOfferMap, productRow) {
  const sku = ymNormOfferKey(productRow?.ym_sku);
  if (!sku) return null;
  return ymOfferMap.get(sku) ?? ymOfferMap.get(sku.toLowerCase()) ?? null;
}

/**
 * YM % выкупа: сначала shows-sales API, иначе заказы ERP (по товарам без API-данных).
 * @returns {Promise<Map<number, number>>} productId → %
 */
async function loadYmBuyoutMap(profileId, orgProducts, scope, days, minSample) {
  const byProduct = new Map();
  let offerMap = new Map();
  try {
    offerMap = await fetchYmBuyoutMapFromShowsSales(scope, days, minSample);
  } catch (e) {
    logger.warn('[BuyoutFetch] YM shows-sales unexpected error', {
      message: e?.message || String(e),
    });
  }

  for (const p of orgProducts) {
    const pct = resolveYmBuyoutPct(offerMap, p);
    if (pct != null) byProduct.set(Number(p.id), pct);
  }

  const missing = orgProducts.filter((p) => !byProduct.has(Number(p.id)));
  if (missing.length) {
    const fromOrders = await loadYmBuyoutFromOrders(profileId, days, minSample);
    for (const p of missing) {
      const pct = fromOrders.get(Number(p.id));
      if (pct != null) byProduct.set(Number(p.id), pct);
    }
  }

  return byProduct;
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

  const byProduct = new Map();

  for (const [orgKey, orgProducts] of groupProductsByOrg(products)) {
    const scope =
      orgKey === '__profile__'
        ? { profileId: pid }
        : { profileId: pid, organizationId: Number(orgKey) };

    await backfillMissingOzonSkus(orgProducts, scope);

    const [ozonMap, wbMap, ymMap] = await Promise.all([
      fetchOzonBuyoutMap(scope, days, minSample),
      fetchWbBuyoutMap(scope, days),
      loadYmBuyoutMap(pid, orgProducts, scope, days, minSample),
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
         buyout_rate_ozon = COALESCE(v.ozon, NULLIF(p.buyout_rate_ozon, 0)),
         buyout_rate_wb = COALESCE(v.wb, NULLIF(p.buyout_rate_wb, 0)),
         buyout_rate_ym = COALESCE(v.ym, NULLIF(p.buyout_rate_ym, 0)),
         buyout_rate = COALESCE(
           v.avg,
           NULLIF(p.buyout_rate, 0),
           95
         ),
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
            MAX(CASE WHEN ps.marketplace = 'ozon' THEN ${OZON_SKU_SQL} END) AS ozon_sku_id,
            MAX(CASE WHEN ps.marketplace = 'ozon' THEN ps.sku END) AS ozon_offer_id,
            MAX(CASE WHEN ps.marketplace = 'ozon' THEN ps.marketplace_product_id END) AS ozon_product_id,
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

  await backfillMissingOzonSkus([p], scope);

  const rates = {};
  const ozonPct = resolveOzonBuyoutPct(await fetchOzonBuyoutMap(scope, days, minSample), p);
  if (ozonPct != null) rates.ozon = ozonPct;

  const wbNmId = parseWbNmId(p);
  if (wbNmId != null) {
    const pct = (await fetchWbBuyoutMap(scope, days)).get(wbNmId);
    if (pct != null) rates.wb = pct;
  }

  const ymPct = (await loadYmBuyoutMap(profileId, [p], scope, days, minSample)).get(pid);
  if (ymPct != null) rates.ym = ymPct;

  if (rates.ozon == null && rates.wb == null && rates.ym == null) {
    return { ok: true, productId: pid, updated: false, reason: 'no_marketplace_data' };
  }

  const avg = averageOf(rates);
  await query(
    `UPDATE products
     SET buyout_rate_ozon = COALESCE($2, NULLIF(buyout_rate_ozon, 0)),
         buyout_rate_wb = COALESCE($3, NULLIF(buyout_rate_wb, 0)),
         buyout_rate_ym = COALESCE($4, NULLIF(buyout_rate_ym, 0)),
         buyout_rate = COALESCE($5, NULLIF(buyout_rate, 0), 95),
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
