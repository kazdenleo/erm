/**
 * Ozon Performance API: токен, кампании, агрегированный ДРР по offer_id.
 * Для включения рекламного % в расчёт минимальной цены.
 */

import { query } from '../config/database.js';
import integrationsService from './integrations.service.js';
import logger from '../utils/logger.js';
import {
  computeDrrPercent,
  diffCampaignMembership,
  normalizeOzonAdsPercent,
} from '../utils/ozonAdsPromotion.js';

const TOKEN_URL = 'https://api-performance.ozon.ru/api/client/token';
const CAMPAIGNS_URL = 'https://api-performance.ozon.ru/api/client/campaign';
const STATS_JSON_URL = 'https://api-performance.ozon.ru/api/client/statistics/json';
const STATS_STATUS_URL = 'https://api-performance.ozon.ru/api/client/statistics';
const STATS_REPORT_URL = 'https://api-performance.ozon.ru/api/client/statistics/report';

const DEFAULT_DAYS = 14;
const MAX_CAMPAIGNS_PER_REQUEST = 10;
/** Ozon: максимум 1 активный отчёт — ждём дольше, иначе следующий chunk ловит 429 */
const POLL_ATTEMPTS = 90;
const POLL_DELAY_MS = 3000;
const REQUEST_429_RETRIES = 12;
const REQUEST_429_DELAY_MS = 15000;
const CHUNK_GAP_MS = 2000;
const CAMPAIGN_PRODUCTS_PAGE_SIZE = 100;

/** Кампании с активной отдачей (товар сейчас в рекламе). */
const ACTIVE_DELIVERY_STATES = new Set([
  'CAMPAIGN_STATE_RUNNING',
  'RUNNING',
  'ACTIVE',
  'STATE_RUNNING',
]);

/** @type {Map<string, { token: string, expiresAt: number }>} */
const tokenCache = new Map();

function formatYmd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseMoney(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const s = String(v).replace(/\s/g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function normalizeOfferId(raw) {
  const s = String(raw ?? '').trim();
  return s || null;
}

function extractOfferFromRow(row) {
  if (!row || typeof row !== 'object') return null;
  return (
    normalizeOfferId(row.offer_id) ||
    normalizeOfferId(row.offerId) ||
    normalizeOfferId(row.sku) ||
    normalizeOfferId(row.SKU) ||
    normalizeOfferId(row.article) ||
    normalizeOfferId(row.vendorCode) ||
    normalizeOfferId(row.vendor_code) ||
    null
  );
}

function extractSpend(row) {
  return parseMoney(
    row.moneySpent ??
      row.money_spent ??
      row.spend ??
      row.expense ??
      row.cost ??
      row.spent ??
      0
  );
}

function extractRevenue(row) {
  return parseMoney(
    row.ordersMoney ??
      row.orders_money ??
      row.product_gmv ??
      row.productGmv ??
      row.gmv ??
      row.revenue ??
      row.sales ??
      0
  );
}

function extractDrr(row) {
  const direct =
    row.drr ??
    row.DRR ??
    row.drr_percent ??
    row.drrPercent ??
    row.acos ??
    null;
  return normalizeOzonAdsPercent(direct);
}

function scopeKey(profileId, organizationId) {
  return `${profileId ?? ''}|${organizationId ?? ''}`;
}

function readPerformanceCreds(config) {
  if (!config || typeof config !== 'object') return null;
  const clientId = String(
    config.performance_client_id ??
      config.performanceClientId ??
      config.ads_client_id ??
      config.adsClientId ??
      ''
  ).trim();
  const clientSecret = String(
    config.performance_client_secret ??
      config.performanceClientSecret ??
      config.ads_client_secret ??
      config.adsClientSecret ??
      ''
  ).trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

async function getAccessToken(creds) {
  const cacheKey = creds.clientId;
  const hit = tokenCache.get(cacheKey);
  if (hit && hit.expiresAt > Date.now() + 60_000) return hit.token;

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      grant_type: 'client_credentials',
    }),
  });
  const text = await response.text();
  if (!response.ok) {
    const err = new Error(`Ozon Performance token ${response.status}: ${text.slice(0, 300)}`);
    err.statusCode = response.status === 401 ? 403 : response.status;
    throw err;
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('Ozon Performance: неверный JSON токена');
  }
  const token = json.access_token || json.accessToken;
  if (!token) throw new Error('Ozon Performance: access_token отсутствует');
  const expiresIn = Number(json.expires_in) || 1800;
  tokenCache.set(cacheKey, { token, expiresAt: Date.now() + expiresIn * 1000 });
  return token;
}

async function perfFetch(token, url, { method = 'GET', body = null } = {}) {
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const response = await fetch(url, opts);
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!response.ok) {
    const err = new Error(
      `Ozon Performance ${response.status}: ${(text || '').slice(0, 400)}`
    );
    err.statusCode = response.status;
    throw err;
  }
  return json ?? text;
}

async function listCampaigns(token) {
  const data = await perfFetch(token, CAMPAIGNS_URL);
  const list = Array.isArray(data)
    ? data
    : Array.isArray(data?.list)
      ? data.list
      : Array.isArray(data?.campaigns)
        ? data.campaigns
        : [];
  return list.filter((c) => c && (c.id != null || c.campaignId != null || c.campaign_id != null));
}

async function listCampaignIds(token) {
  const list = await listCampaigns(token);
  const ids = [];
  for (const c of list) {
    const id = c?.id ?? c?.campaignId ?? c?.campaign_id;
    if (id == null) continue;
    const st = String(c?.state ?? c?.status ?? '').toUpperCase();
    // Берём активные и недавно завершённые — для статистики за период
    if (st && /ARCHIVED|DELETED|REJECTED/.test(st)) continue;
    ids.push(Number(id) || String(id));
  }
  return [...new Set(ids)];
}

function campaignIsActivelyDelivering(campaign) {
  const st = String(campaign?.state ?? campaign?.status ?? '').toUpperCase();
  if (!st) return false;
  if (ACTIVE_DELIVERY_STATES.has(st)) return true;
  // Иногда state без префикса
  return st === 'RUNNING' || st === 'ACTIVE';
}

async function listActiveDeliveryCampaignIds(token) {
  const list = await listCampaigns(token);
  const ids = [];
  for (const c of list) {
    if (!campaignIsActivelyDelivering(c)) continue;
    const id = c?.id ?? c?.campaignId ?? c?.campaign_id;
    if (id == null) continue;
    ids.push(Number(id) || String(id));
  }
  return [...new Set(ids)];
}

function extractOfferIdsFromCampaignProductsPayload(data) {
  const out = new Set();
  const push = (raw) => {
    const id = normalizeOfferId(raw);
    if (id) out.add(id);
  };
  const consumeItem = (item) => {
    if (item == null) return;
    if (typeof item === 'string' || typeof item === 'number') {
      push(item);
      return;
    }
    if (typeof item !== 'object') return;
    push(item.sku);
    push(item.SKU);
    push(item.offer_id);
    push(item.offerId);
    push(item.id);
    push(item.objectId);
    push(item.object_id);
    push(item.productId);
    push(item.product_id);
  };

  if (Array.isArray(data)) {
    for (const item of data) consumeItem(item);
    return out;
  }
  if (!data || typeof data !== 'object') return out;

  const lists = [
    data.products,
    data.list,
    data.objects,
    data.items,
    data.rows,
    data.result?.products,
    data.result?.list,
    data.result?.objects,
  ];
  for (const arr of lists) {
    if (Array.isArray(arr)) {
      for (const item of arr) consumeItem(item);
    }
  }
  return out;
}

async function fetchCampaignOfferIds(token, campaignId) {
  const offers = new Set();
  const cid = encodeURIComponent(String(campaignId));

  // v2/products с пагинацией
  try {
    let page = 1;
    for (let guard = 0; guard < 50; guard++) {
      const url = `${CAMPAIGNS_URL}/${cid}/v2/products?page=${page}&pageSize=${CAMPAIGN_PRODUCTS_PAGE_SIZE}`;
      const data = await perfFetch(token, url);
      const batch = extractOfferIdsFromCampaignProductsPayload(data);
      for (const id of batch) offers.add(id);
      const products = Array.isArray(data?.products)
        ? data.products
        : Array.isArray(data?.list)
          ? data.list
          : Array.isArray(data)
            ? data
            : [];
      if (products.length < CAMPAIGN_PRODUCTS_PAGE_SIZE) break;
      page += 1;
    }
    if (offers.size) return offers;
  } catch (e) {
    logger.warn('[Ozon Performance] campaign v2/products failed', {
      campaignId,
      message: e?.message || String(e),
    });
  }

  // fallback: /objects
  try {
    const data = await perfFetch(token, `${CAMPAIGNS_URL}/${cid}/objects`);
    const batch = extractOfferIdsFromCampaignProductsPayload(data);
    for (const id of batch) offers.add(id);
  } catch (e) {
    logger.warn('[Ozon Performance] campaign objects failed', {
      campaignId,
      message: e?.message || String(e),
    });
  }
  return offers;
}

async function requestStatsUuid(token, campaignIds, dateFrom, dateTo) {
  const payload = {
    campaigns: campaignIds.map((id) => (typeof id === 'number' ? id : Number(id) || id)),
    dateFrom,
    dateTo,
    groupBy: 'DATE',
  };
  let lastErr = null;
  for (let attempt = 0; attempt < REQUEST_429_RETRIES; attempt++) {
    try {
      const data = await perfFetch(token, STATS_JSON_URL, { method: 'POST', body: payload });
      return data?.UUID || data?.uuid || data?.reportUUID || null;
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message || '');
      const is429 =
        e?.statusCode === 429 ||
        /429|лимит активных|максимум 1/i.test(msg);
      if (!is429 || attempt === REQUEST_429_RETRIES - 1) throw e;
      logger.warn('[Ozon Performance] stats request busy, retry', {
        attempt: attempt + 1,
        delayMs: REQUEST_429_DELAY_MS,
      });
      await sleep(REQUEST_429_DELAY_MS);
    }
  }
  throw lastErr || new Error('Ozon Performance: не удалось запросить статистику');
}

async function waitReportReady(token, uuid) {
  for (let i = 0; i < POLL_ATTEMPTS; i++) {
    const data = await perfFetch(token, `${STATS_STATUS_URL}/${encodeURIComponent(uuid)}`);
    const state = String(data?.state || data?.status || '').toUpperCase();
    if (state === 'OK' || state === 'SUCCESS' || state === 'DONE' || data?.link) {
      return data;
    }
    if (state === 'ERROR' || state === 'FAILED') {
      throw new Error(`Ozon Performance report failed: ${JSON.stringify(data).slice(0, 200)}`);
    }
    await sleep(POLL_DELAY_MS);
  }
  throw new Error(`Ozon Performance report timeout (uuid=${uuid})`);
}

async function downloadReport(token, uuid) {
  const url = `${STATS_REPORT_URL}?UUID=${encodeURIComponent(uuid)}`;
  const data = await perfFetch(token, url);
  return data;
}

function flattenReportRows(report) {
  if (!report) return [];
  if (Array.isArray(report)) return report;
  if (typeof report === 'string') {
    try {
      return flattenReportRows(JSON.parse(report));
    } catch {
      return [];
    }
  }
  if (Array.isArray(report.rows)) return report.rows;
  if (Array.isArray(report.report)) return report.report;
  if (Array.isArray(report.data)) return report.data;
  // Формат { "campaignId": { "report": { "rows": [...] } } } или объект кампаний
  const out = [];
  for (const [key, val] of Object.entries(report)) {
    if (key === 'UUID' || key === 'uuid') continue;
    if (Array.isArray(val)) {
      out.push(...val);
      continue;
    }
    if (val && typeof val === 'object') {
      const nested =
        val.rows ||
        val.report?.rows ||
        val.data ||
        (Array.isArray(val.report) ? val.report : null);
      if (Array.isArray(nested)) out.push(...nested);
      else if (nested && typeof nested === 'object') {
        for (const dayRows of Object.values(nested)) {
          if (Array.isArray(dayRows)) out.push(...dayRows);
        }
      }
    }
  }
  return out;
}

function aggregateByOffer(rows) {
  /** @type {Map<string, { spend: number, revenue: number, drrSamples: number[] }>} */
  const map = new Map();
  for (const row of rows) {
    const offerId = extractOfferFromRow(row);
    if (!offerId) continue;
    const spend = extractSpend(row);
    const revenue = extractRevenue(row);
    const drr = extractDrr(row);
    let cur = map.get(offerId);
    if (!cur) {
      cur = { spend: 0, revenue: 0, drrSamples: [] };
      map.set(offerId, cur);
    }
    cur.spend += spend;
    cur.revenue += revenue;
    if (drr != null && drr > 0) cur.drrSamples.push(drr);
  }
  const out = new Map();
  for (const [offerId, agg] of map.entries()) {
    let drr = computeDrrPercent(agg.spend, agg.revenue);
    if (drr == null && agg.drrSamples.length) {
      const avg = agg.drrSamples.reduce((a, b) => a + b, 0) / agg.drrSamples.length;
      drr = normalizeOzonAdsPercent(avg);
    }
    if (drr == null && agg.spend <= 0) drr = 0;
    out.set(offerId, {
      offerId,
      spend: Math.round(agg.spend * 100) / 100,
      revenue: Math.round(agg.revenue * 100) / 100,
      drrPercent: drr,
    });
  }
  return out;
}

function adsScopeKey(profileId, organizationId) {
  const p = profileId != null && Number.isFinite(Number(profileId)) ? Number(profileId) : 0;
  const o =
    organizationId != null && Number.isFinite(Number(organizationId)) ? Number(organizationId) : 0;
  return `${p}:${o}`;
}

async function upsertStatsRows(rows, { profileId, organizationId, periodFrom, periodTo }) {
  let upserted = 0;
  const scopeKey = adsScopeKey(profileId, organizationId);
  for (const row of rows) {
    if (!row?.offerId) continue;
    const drr = row.drrPercent;
    await query(
      `INSERT INTO ozon_ads_sku_stats
         (scope_key, profile_id, organization_id, offer_id, spend, revenue, drr_percent, period_from, period_to, source, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'performance_api', CURRENT_TIMESTAMP)
       ON CONFLICT (scope_key, offer_id)
       DO UPDATE SET
         spend = EXCLUDED.spend,
         revenue = EXCLUDED.revenue,
         drr_percent = EXCLUDED.drr_percent,
         period_from = EXCLUDED.period_from,
         period_to = EXCLUDED.period_to,
         profile_id = EXCLUDED.profile_id,
         organization_id = EXCLUDED.organization_id,
         source = EXCLUDED.source,
         updated_at = CURRENT_TIMESTAMP`,
      [
        scopeKey,
        profileId,
        organizationId,
        row.offerId,
        row.spend,
        row.revenue,
        drr,
        periodFrom,
        periodTo,
      ]
    );
    upserted += 1;
  }
  return upserted;
}

/** JOIN product_skus ↔ offer_id (как в listHighDrrProducts). marketplace_product_id — bigint. */
const OZON_OFFER_JOIN = `
  (
    (ps.marketplace_product_id IS NOT NULL AND TRIM(ps.marketplace_product_id::text) = s.offer_id)
    OR TRIM(COALESCE(ps.mp_extra->>'ozon_sku', '')) = s.offer_id
    OR TRIM(COALESCE(ps.mp_extra->>'ozonSku', '')) = s.offer_id
    OR TRIM(COALESCE(ps.mp_extra->>'sku', '')) = s.offer_id
    OR TRIM(COALESCE(ps.mp_extra->>'finance_sku', '')) = s.offer_id
  )
`;

/**
 * product_id по offer_id Ozon.
 */
async function resolveProductIdsForOzonOffers(offerIds, { profileId = null } = {}) {
  const ids = [...new Set((offerIds || []).map((x) => String(x || '').trim()).filter(Boolean))];
  if (!ids.length) return [];
  const pid =
    profileId != null && profileId !== '' && Number.isFinite(Number(profileId))
      ? Number(profileId)
      : null;
  const r = await query(
    `SELECT DISTINCT ps.product_id
     FROM product_skus ps
     INNER JOIN products p ON p.id = ps.product_id
     WHERE ps.marketplace = 'ozon'
       AND COALESCE(p.is_archived, false) = false
       AND (
         (ps.marketplace_product_id IS NOT NULL AND TRIM(ps.marketplace_product_id::text) = ANY($1::text[]))
         OR TRIM(COALESCE(ps.mp_extra->>'ozon_sku', '')) = ANY($1::text[])
         OR TRIM(COALESCE(ps.mp_extra->>'ozonSku', '')) = ANY($1::text[])
         OR TRIM(COALESCE(ps.mp_extra->>'sku', '')) = ANY($1::text[])
         OR TRIM(COALESCE(ps.mp_extra->>'finance_sku', '')) = ANY($1::text[])
       )
       AND ($2::int IS NULL OR p.profile_id IS NULL OR p.profile_id = $2)`,
    [ids, pid]
  );
  return (r.rows || [])
    .map((row) => Number(row.product_id))
    .filter((id) => Number.isFinite(id) && id > 0);
}

/**
 * Товары вне активной кампании, но в сохранённых деталях мин. цены ещё «реклама > 0».
 * Нужно, чтобы снять завышенный пол сразу, а не ждать ночного пересчёта.
 */
async function findProductIdsWithStaleAdsMinPrice({ profileId = null, scopeKey = null } = {}) {
  const pid =
    profileId != null && profileId !== '' && Number.isFinite(Number(profileId))
      ? Number(profileId)
      : null;
  try {
    const r = await query(
      `SELECT DISTINCT p.id AS product_id
       FROM ozon_ads_sku_stats s
       INNER JOIN product_skus ps
         ON ps.marketplace = 'ozon' AND ${OZON_OFFER_JOIN}
       INNER JOIN products p ON p.id = ps.product_id
       INNER JOIN product_marketplace_prices pmp
         ON pmp.product_id = p.id AND pmp.marketplace = 'ozon'
       WHERE s.in_active_campaign IS FALSE
         AND COALESCE(p.is_archived, false) = false
         AND (
           $1::text IS NULL
           OR s.scope_key = $1
           OR ($2::int IS NOT NULL AND (s.profile_id = $2 OR s.scope_key LIKE ($2::text || ':%')))
         )
         AND ($2::int IS NULL OR p.profile_id IS NULL OR p.profile_id = $2)
         AND (
           COALESCE((pmp.calculation_details->>'ads_promotion_percent')::numeric, 0) > 0
           OR COALESCE((pmp.calculation_details_fbs->>'ads_promotion_percent')::numeric, 0) > 0
           OR COALESCE((pmp.calculation_details_fbo->>'ads_promotion_percent')::numeric, 0) > 0
         )`,
      [scopeKey || null, pid]
    );
    return (r.rows || [])
      .map((row) => Number(row.product_id))
      .filter((id) => Number.isFinite(id) && id > 0);
  } catch (e) {
    if (String(e.message || '').includes('ozon_ads_sku_stats')) return [];
    if (String(e.message || '').includes('in_active_campaign')) return [];
    if (String(e.message || '').includes('ads_promotion')) return [];
    throw e;
  }
}

/**
 * Пересчёт мин. цены (из кэша) + отложенный пуш для товаров после смены рекламы.
 */
async function recalculateMinPricesForProductIds(productIds, reason = 'ads_membership') {
  const ids = [...new Set((productIds || []).map(Number).filter((id) => Number.isFinite(id) && id > 0))];
  if (!ids.length) return { recalculated: 0, errors: 0 };
  const pricesService = (await import('./prices.service.js')).default;
  let recalculated = 0;
  let errors = 0;
  for (const productId of ids) {
    try {
      await pricesService.recalculateAndSaveForProduct(productId, {
        useCalculatorCache: true,
      });
      recalculated += 1;
    } catch (e) {
      errors += 1;
      logger.warn('[Ozon Performance] min price recalc after ads change failed', {
        productId,
        reason,
        message: e?.message || String(e),
      });
    }
  }
  logger.info('[Ozon Performance] min prices recalculated after ads change', {
    reason,
    requested: ids.length,
    recalculated,
    errors,
  });
  return { recalculated, errors };
}

/**
 * Сбросить/проставить in_active_campaign по SKU из активных кампаний.
 * Если рекламу выключили — флаги станут false, товар уйдёт из «Высокий ДРР».
 * Возвращает leftOffers / joinedOffers для пересчёта мин. цен.
 */
async function syncActiveCampaignMembership(token, { profileId, organizationId }) {
  const scopeKey = adsScopeKey(profileId, organizationId);
  const activeCampaignIds = await listActiveDeliveryCampaignIds(token);
  const activeOffers = new Set();

  let previouslyActive = new Set();
  try {
    const prev = await query(
      `SELECT offer_id FROM ozon_ads_sku_stats
       WHERE scope_key = $1 AND in_active_campaign IS TRUE`,
      [scopeKey]
    );
    previouslyActive = new Set(
      (prev.rows || []).map((row) => String(row.offer_id || '').trim()).filter(Boolean)
    );
  } catch (e) {
    logger.warn('[Ozon Performance] previous membership snapshot failed', {
      message: e?.message || String(e),
    });
  }

  for (const campaignId of activeCampaignIds) {
    try {
      const offers = await fetchCampaignOfferIds(token, campaignId);
      for (const oid of offers) activeOffers.add(oid);
    } catch (e) {
      logger.warn('[Ozon Performance] membership campaign failed', {
        campaignId,
        message: e?.message || String(e),
      });
    }
    await sleep(200);
  }

  // Все ранее известные SKU scope — не в активной рекламе, пока не подтвердим.
  await query(
    `UPDATE ozon_ads_sku_stats
     SET in_active_campaign = false,
         campaign_synced_at = CURRENT_TIMESTAMP
     WHERE scope_key = $1`,
    [scopeKey]
  );

  let marked = 0;
  for (const offerId of activeOffers) {
    await query(
      `INSERT INTO ozon_ads_sku_stats
         (scope_key, profile_id, organization_id, offer_id, spend, revenue, drr_percent,
          period_from, period_to, source, in_active_campaign, campaign_synced_at, updated_at)
       VALUES (
         $1, $2, $3, $4, 0, 0, NULL,
         CURRENT_DATE, CURRENT_DATE, 'performance_api', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
       )
       ON CONFLICT (scope_key, offer_id)
       DO UPDATE SET
         in_active_campaign = true,
         campaign_synced_at = CURRENT_TIMESTAMP,
         profile_id = COALESCE(EXCLUDED.profile_id, ozon_ads_sku_stats.profile_id),
         organization_id = COALESCE(EXCLUDED.organization_id, ozon_ads_sku_stats.organization_id)`,
      [scopeKey, profileId, organizationId, offerId]
    );
    marked += 1;
  }

  const { leftOffers, joinedOffers } = diffCampaignMembership(previouslyActive, activeOffers);

  return {
    activeCampaigns: activeCampaignIds.length,
    activeOffers: activeOffers.size,
    marked,
    leftOffers,
    joinedOffers,
    scopeKey,
  };
}

class OzonPerformanceAdsService {
  async getCreds(scope = {}) {
    const config = await integrationsService.getMarketplaceConfig('ozon', scope);
    return readPerformanceCreds(config);
  }

  async testConnection(scope = {}) {
    const creds = await this.getCreds(scope);
    if (!creds) {
      const err = new Error(
        'Не заданы Performance Client ID / Client Secret (рекламный кабинет Ozon)'
      );
      err.statusCode = 400;
      throw err;
    }
    const token = await getAccessToken(creds);
    const campaigns = await listCampaignIds(token);
    return { ok: true, campaigns: campaigns.length };
  }

  /**
   * Синхронизация ДРР по offer_id за последние N дней.
   */
  async syncAdsStats(scope = {}, { days = DEFAULT_DAYS } = {}) {
    const profileId =
      scope.profileId != null && scope.profileId !== '' ? Number(scope.profileId) : null;
    const organizationId =
      scope.organizationId != null && scope.organizationId !== ''
        ? Number(scope.organizationId)
        : null;

    const creds = await this.getCreds(scope);
    if (!creds) {
      return { ok: false, skipped: true, reason: 'no_performance_creds', upserted: 0 };
    }

    const token = await getAccessToken(creds);
    const campaignIds = await listCampaignIds(token);
    if (!campaignIds.length) {
      return { ok: true, campaigns: 0, upserted: 0, offers: 0 };
    }

    const to = new Date();
    to.setHours(0, 0, 0, 0);
    const from = new Date(to);
    from.setDate(from.getDate() - (Math.max(1, Math.min(Number(days) || DEFAULT_DAYS, 62)) - 1));
    const dateFrom = formatYmd(from);
    const dateTo = formatYmd(to);

    /** @type {Map<string, { offerId: string, spend: number, revenue: number, drrPercent: number|null }>} */
    const merged = new Map();

    for (let i = 0; i < campaignIds.length; i += MAX_CAMPAIGNS_PER_REQUEST) {
      const chunk = campaignIds.slice(i, i + MAX_CAMPAIGNS_PER_REQUEST);
      try {
        const uuid = await requestStatsUuid(token, chunk, dateFrom, dateTo);
        if (!uuid) continue;
        await waitReportReady(token, uuid);
        const report = await downloadReport(token, uuid);
        const rows = flattenReportRows(report);
        const agg = aggregateByOffer(rows);
        for (const [offerId, stats] of agg.entries()) {
          const prev = merged.get(offerId);
          if (!prev) {
            merged.set(offerId, { ...stats });
          } else {
            prev.spend += stats.spend;
            prev.revenue += stats.revenue;
            prev.drrPercent = computeDrrPercent(prev.spend, prev.revenue) ?? prev.drrPercent;
          }
        }
      } catch (e) {
        logger.warn('[Ozon Performance] stats chunk failed', {
          message: e?.message || String(e),
          chunkSize: chunk.length,
        });
      }
      // Дать Ozon закрыть слот активного отчёта перед следующим запросом
      if (i + MAX_CAMPAIGNS_PER_REQUEST < campaignIds.length) {
        await sleep(CHUNK_GAP_MS);
      }
    }

    const list = [...merged.values()];
    const upserted = await upsertStatsRows(list, {
      profileId: Number.isFinite(profileId) ? profileId : null,
      organizationId: Number.isFinite(organizationId) ? organizationId : null,
      periodFrom: dateFrom,
      periodTo: dateTo,
    });

    let membership = { activeCampaigns: 0, activeOffers: 0, marked: 0 };
    try {
      membership = await syncActiveCampaignMembership(token, {
        profileId: Number.isFinite(profileId) ? profileId : null,
        organizationId: Number.isFinite(organizationId) ? organizationId : null,
      });
    } catch (e) {
      logger.warn('[Ozon Performance] campaign membership sync failed', {
        message: e?.message || String(e),
      });
    }

    logger.info('[Ozon Performance] ads sync done', {
      campaigns: campaignIds.length,
      offers: list.length,
      upserted,
      dateFrom,
      dateTo,
      scope: adsScopeKey(profileId, organizationId),
      membership,
    });

    return {
      ok: true,
      campaigns: campaignIds.length,
      offers: list.length,
      upserted,
      dateFrom,
      dateTo,
      membership,
    };
  }

  /**
   * Статистика ДРР + флаг участия в активной кампании.
   */
  async getAdsStatsForOffer(offerId, scope = {}) {
    const oid = normalizeOfferId(offerId);
    if (!oid) return null;

    const profileId =
      scope.profileId != null && scope.profileId !== '' ? Number(scope.profileId) : null;
    const organizationId =
      scope.organizationId != null && scope.organizationId !== ''
        ? Number(scope.organizationId)
        : null;

    try {
      const scopeKey = adsScopeKey(
        Number.isFinite(profileId) ? profileId : null,
        Number.isFinite(organizationId) ? organizationId : null
      );
      const r = await query(
        `SELECT drr_percent, spend, revenue, in_active_campaign, updated_at, campaign_synced_at
         FROM ozon_ads_sku_stats
         WHERE offer_id = $1
           AND (
             scope_key = $2
             OR ($3::int IS NOT NULL AND profile_id = $3)
             OR scope_key = '0:0'
           )
         ORDER BY
           CASE WHEN scope_key = $2 THEN 0
                WHEN $3::int IS NOT NULL AND profile_id = $3 THEN 1
                ELSE 2 END,
           updated_at DESC
         LIMIT 1`,
        [
          oid,
          scopeKey,
          Number.isFinite(profileId) ? profileId : null,
        ]
      );
      const row = r.rows?.[0];
      if (!row) return null;
      let drrPercent = null;
      if (row.drr_percent != null && !Number.isNaN(Number(row.drr_percent))) {
        drrPercent = normalizeOzonAdsPercent(row.drr_percent);
      } else {
        drrPercent = computeDrrPercent(row.spend, row.revenue);
      }
      return {
        drrPercent,
        spend: Number(row.spend) || 0,
        revenue: Number(row.revenue) || 0,
        inActiveCampaign:
          row.in_active_campaign === true
            ? true
            : row.in_active_campaign === false
              ? false
              : null,
        updatedAt: row.updated_at || null,
        campaignSyncedAt: row.campaign_synced_at || null,
      };
    } catch (e) {
      if (String(e.message || '').includes('ozon_ads_sku_stats')) return null;
      throw e;
    }
  }

  /**
   * ДРР % для offer_id (sku_ozon). Сначала точный scope, затем без organization.
   * Если SKU не в активной кампании — возвращает 0 (рекламу в мин. цене не учитываем).
   */
  async getDrrPercentForOffer(offerId, scope = {}) {
    const stats = await this.getAdsStatsForOffer(offerId, scope);
    if (!stats) return null;
    if (stats.inActiveCampaign === false) return 0;
    return stats.drrPercent;
  }

  /**
   * Товары с высоким ДРР, которые сейчас в активной рекламе (для «Работа с карточками»).
   */
  async listHighDrrProducts({ profileId, highDrrPercent, organizationId = null } = {}) {
    const pid = Number(profileId);
    const threshold = Number(highDrrPercent);
    if (!Number.isFinite(pid) || pid < 1 || !Number.isFinite(threshold) || threshold <= 0) {
      return [];
    }
    const orgId =
      organizationId != null && organizationId !== '' && Number.isFinite(Number(organizationId))
        ? Number(organizationId)
        : null;
    const scopeExact = adsScopeKey(pid, orgId);

    try {
      const r = await query(
        `SELECT DISTINCT ON (p.id)
            p.id AS product_id,
            p.sku AS erp_sku,
            p.name AS product_name,
            s.offer_id,
            s.drr_percent,
            s.spend,
            s.revenue,
            s.in_active_campaign
         FROM ozon_ads_sku_stats s
         INNER JOIN product_skus ps
           ON ps.marketplace = 'ozon'
          AND (
            TRIM(COALESCE(ps.marketplace_product_id, '')) = s.offer_id
            OR TRIM(COALESCE(ps.mp_extra->>'ozon_sku', '')) = s.offer_id
            OR TRIM(COALESCE(ps.mp_extra->>'ozonSku', '')) = s.offer_id
            OR TRIM(COALESCE(ps.mp_extra->>'sku', '')) = s.offer_id
            OR TRIM(COALESCE(ps.mp_extra->>'finance_sku', '')) = s.offer_id
          )
         INNER JOIN products p ON p.id = ps.product_id
         WHERE s.in_active_campaign IS TRUE
           AND s.drr_percent IS NOT NULL
           AND s.drr_percent > $1
           AND (
             s.scope_key = $2
             OR s.profile_id = $3
             OR s.scope_key LIKE ($3::text || ':%')
           )
           AND (p.profile_id IS NULL OR p.profile_id = $3)
         ORDER BY p.id, s.drr_percent DESC, s.updated_at DESC`,
        [threshold, scopeExact, pid]
      );
      return (r.rows || []).map((row) => ({
        productId: Number(row.product_id),
        sku: row.offer_id || null,
        erpSku: row.erp_sku || null,
        productName: row.product_name || null,
        drrPercent: normalizeOzonAdsPercent(row.drr_percent),
        spend: Number(row.spend) || 0,
        revenue: Number(row.revenue) || 0,
        marketplace: 'ozon',
      }));
    } catch (e) {
      if (String(e.message || '').includes('ozon_ads_sku_stats')) return [];
      if (String(e.message || '').includes('in_active_campaign')) return [];
      throw e;
    }
  }

  async syncAllConfiguredScopes({ days = DEFAULT_DAYS } = {}) {
    let cabinets = { rows: [] };
    try {
      cabinets = await query(
        `SELECT mc.organization_id, mc.config, o.profile_id
         FROM marketplace_cabinets mc
         LEFT JOIN organizations o ON o.id = mc.organization_id
         WHERE mc.marketplace_type = 'ozon'
           AND (mc.is_active IS NULL OR mc.is_active = true)`
      );
    } catch (e) {
      logger.warn('[Ozon Performance] marketplace_cabinets query failed:', e?.message || e);
    }

    let processed = 0;
    let upserted = 0;
    const errors = [];

    const rows = cabinets.rows?.length
      ? cabinets.rows
      : [{ profile_id: null, organization_id: null, config: null }];

    for (const row of rows) {
      const scope = {
        profileId: row.profile_id ?? null,
        organizationId: row.organization_id ?? null,
      };
      let config = row.config;
      if (!config || typeof config !== 'object') {
        try {
          config = await integrationsService.getMarketplaceConfig('ozon', scope);
        } catch {
          config = null;
        }
      }
      if (!readPerformanceCreds(config)) continue;
      try {
        const out = await this.syncAdsStats(scope, { days });
        processed += 1;
        upserted += out.upserted || 0;
      } catch (e) {
        errors.push({ scope, message: e?.message || String(e) });
        logger.warn('[Ozon Performance] sync scope failed', {
          ...scope,
          message: e?.message || String(e),
        });
      }
    }

    return { processed, upserted, errors };
  }

  /**
   * Пересчитать мин. цены для офферов, сменивших членство, + снять «залипший» ДРР
   * у товаров уже вне кампании (старые calculation_details).
   */
  async recalculatePricesAfterMembershipChange(membership, scope = {}) {
    const leftOffers = membership?.leftOffers || [];
    const joinedOffers = membership?.joinedOffers || [];
    const profileId =
      scope.profileId != null && scope.profileId !== '' ? Number(scope.profileId) : null;
    const productIds = new Set();

    for (const oid of [...leftOffers, ...joinedOffers]) {
      const ids = await resolveProductIdsForOzonOffers([oid], { profileId });
      for (const id of ids) productIds.add(id);
    }

    const staleIds = await findProductIdsWithStaleAdsMinPrice({
      profileId: Number.isFinite(profileId) ? profileId : null,
      scopeKey: membership?.scopeKey || null,
    });
    for (const id of staleIds) productIds.add(id);

    if (!productIds.size) {
      return { recalculated: 0, errors: 0, leftOffers: leftOffers.length, joinedOffers: joinedOffers.length, stale: staleIds.length };
    }

    const recalc = await recalculateMinPricesForProductIds([...productIds], 'ads_membership');
    return {
      ...recalc,
      leftOffers: leftOffers.length,
      joinedOffers: joinedOffers.length,
      stale: staleIds.length,
      products: productIds.size,
    };
  }

  /**
   * Только членство в активных кампаниях (без тяжёлой статистики).
   * Нужно днём: после отключения рекламы товар быстро уходит из «Высокий ДРР»
   * и мин. цена пересчитывается/пушится без ожидания ночного прогона.
   */
  async syncMembershipAllConfiguredScopes({ recalculatePrices = true } = {}) {
    let cabinets = { rows: [] };
    try {
      cabinets = await query(
        `SELECT mc.organization_id, mc.config, o.profile_id
         FROM marketplace_cabinets mc
         LEFT JOIN organizations o ON o.id = mc.organization_id
         WHERE mc.marketplace_type = 'ozon'
           AND (mc.is_active IS NULL OR mc.is_active = true)`
      );
    } catch (e) {
      logger.warn('[Ozon Performance] marketplace_cabinets query failed:', e?.message || e);
    }

    let processed = 0;
    let marked = 0;
    let recalculated = 0;
    const errors = [];
    const rows = cabinets.rows?.length
      ? cabinets.rows
      : [{ profile_id: null, organization_id: null, config: null }];

    for (const row of rows) {
      const scope = {
        profileId: row.profile_id ?? null,
        organizationId: row.organization_id ?? null,
      };
      let config = row.config;
      if (!config || typeof config !== 'object') {
        try {
          config = await integrationsService.getMarketplaceConfig('ozon', scope);
        } catch {
          config = null;
        }
      }
      if (!readPerformanceCreds(config)) continue;
      try {
        const creds = readPerformanceCreds(config);
        const token = await getAccessToken(creds);
        const out = await syncActiveCampaignMembership(token, {
          profileId: scope.profileId != null ? Number(scope.profileId) : null,
          organizationId: scope.organizationId != null ? Number(scope.organizationId) : null,
        });
        processed += 1;
        marked += out.marked || 0;

        if (recalculatePrices) {
          try {
            const priceRes = await this.recalculatePricesAfterMembershipChange(out, scope);
            recalculated += priceRes.recalculated || 0;
          } catch (e) {
            logger.warn('[Ozon Performance] price recalc after membership failed', {
              ...scope,
              message: e?.message || String(e),
            });
          }
        }
      } catch (e) {
        errors.push({ scope, message: e?.message || String(e) });
        logger.warn('[Ozon Performance] membership scope failed', {
          ...scope,
          message: e?.message || String(e),
        });
      }
    }

    return { processed, marked, recalculated, errors };
  }
}

export default new OzonPerformanceAdsService();
