/**
 * Возвраты с маркетплейсов (Ozon, Wildberries, Яндекс Маркет) — единый список «ждут забора».
 */

import integrationsService from './integrations.service.js';
import { listWbGoodsReturns } from './wbReturns.service.js';
import { getYandexBusinessAndCampaigns, normalizeYandexApiKey } from './orders.sync.service.js';
import { getYandexHttpsAgent } from '../utils/yandex-https-agent.js';

const CACHE_TTL_MS = 3 * 60 * 1000;
const CACHE_LOGIC_VERSION = 'pickup-ready-v2';
const DEFAULT_DAYS = 31;

/** @type {Map<string, { at: number, rows: object[] }>} */
const ozonCache = new Map();
/** @type {Map<string, { at: number, rows: object[] }>} */
const ymCache = new Map();

const YM_SHIPMENT_STATUS_LABELS = {
  CREATED: 'Создан',
  RECEIVED: 'Принят у покупателя',
  IN_TRANSIT: 'В пути',
  READY_FOR_PICKUP: 'Готов к выдаче',
  PICKED: 'Выдан магазину',
  LOST: 'Утерян',
  EXPIRED: 'Просрочен',
  CANCELLED: 'Отменён',
  FULFILMENT_RECEIVED: 'На складе Маркета',
  PREPARED_FOR_UTILIZATION: 'К утилизации',
  NOT_IN_DEMAND: 'Не забрали с почты',
  UTILIZED: 'Утилизирован',
  UNKNOWN: 'Неизвестно',
};

function formatDateYmd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function isoRangeForDays(days = DEFAULT_DAYS) {
  const span = Math.max(1, Math.min(Number(days) || DEFAULT_DAYS, 93));
  const to = new Date();
  to.setHours(23, 59, 59, 999);
  const from = addDays(to, -(span - 1));
  from.setHours(0, 0, 0, 0);
  return { timeFrom: from.toISOString(), timeTo: to.toISOString(), fromYmd: formatDateYmd(from), toYmd: formatDateYmd(to) };
}

function filterActiveReturns(rows) {
  return rows.filter((r) => Boolean(r.waitingPickup));
}

function sortUnifiedRows(rows) {
  return [...rows].sort((a, b) => {
    const da = a.readyFromDt || a.orderDt || '';
    const db = b.readyFromDt || b.orderDt || '';
    return String(db).localeCompare(String(da));
  });
}

function dedupeUnified(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = `${row.marketplace}:${row.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function countWaitingByMarketplace(rows) {
  const counts = { ozon: 0, wildberries: 0, yandex: 0 };
  for (const r of rows) {
    if (!r.waitingPickup) continue;
    const mp = String(r.marketplace || '').toLowerCase();
    if (mp === 'ozon' || mp === 'wildberries' || mp === 'yandex') counts[mp] += 1;
  }
  return counts;
}

const OZON_PICKUP_SYS_NAMES = new Set(['arrivedatreturnplace']);

export function isOzonReturnWaitingPickup(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  if (r.logistic?.final_moment) return false;
  const sys = String(r.visual?.status?.sys_name || '').trim().toLowerCase();
  const display = String(r.visual?.status?.display_name || '').trim().toLowerCase();

  if (OZON_PICKUP_SYS_NAMES.has(sys)) return true;
  if (/пункт\s*выдачи|в\s*пункте\s*выдачи|прибыл.*пункт|на\s*пвз/.test(display)) return true;

  return false;
}

export function isYmReturnWaitingPickup(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const st = String(r.shipmentStatus || '').toUpperCase();
  const recipient = String(r.shipmentRecipientType || '').toUpperCase();
  if (recipient && recipient !== 'SHOP') return false;
  return st === 'READY_FOR_PICKUP';
}

function mapWbRow(row) {
  return {
    marketplace: 'wildberries',
    id: String(row.id),
    status: row.status ?? null,
    statusDetail: row.returnType ?? null,
    waitingPickup: Boolean(row.waitingPickup),
    sku: row.nmId != null ? String(row.nmId) : null,
    barcode: row.barcode ?? null,
    productName: row.subjectName ?? null,
    productExtra: [row.brand, row.techSize].filter(Boolean).join(' · ') || null,
    pickupAddress: row.dstOfficeAddress ?? null,
    pickupPointId: row.dstOfficeId ?? null,
    readyFromDt: row.readyToReturnDt ?? null,
    expiredDt: row.expiredDt ?? null,
    reason: row.reason ?? null,
    orderId: row.orderId != null ? String(row.orderId) : null,
    orderDt: row.orderDt ?? null,
  };
}

function mapOzonRow(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const product = r.product && typeof r.product === 'object' ? r.product : {};
  const place = r.place && typeof r.place === 'object' ? r.place : {};
  const storage = r.storage && typeof r.storage === 'object' ? r.storage : {};
  const visual = r.visual?.status || {};
  const waitingPickup = isOzonReturnWaitingPickup(r);
  const schema = r.schema ?? null;
  const type = r.type ?? null;
  return {
    marketplace: 'ozon',
    id: String(r.id ?? `${r.order_number}-${product.offer_id}`),
    status: visual.display_name ?? r.status ?? null,
    statusDetail: [schema, type].filter(Boolean).join(' · ') || null,
    waitingPickup,
    sku: product.offer_id != null ? String(product.offer_id) : (product.sku != null ? String(product.sku) : null),
    barcode: r.logistic?.barcode ?? null,
    productName: product.name ?? null,
    productExtra: product.quantity != null ? `×${product.quantity}` : null,
    pickupAddress: place.address || place.name || null,
    pickupPointId: place.id ?? null,
    readyFromDt: storage.arrived_moment ?? r.visual?.change_moment ?? null,
    expiredDt: storage.utilization_forecast_date ?? null,
    reason: r.return_reason_name ?? null,
    orderId: r.order_number != null ? String(r.order_number) : (r.order_id != null ? String(r.order_id) : null),
    orderDt: r.logistic?.return_date ?? null,
  };
}

function formatYmAddress(addr) {
  if (!addr || typeof addr !== 'object') return null;
  const parts = [addr.city, addr.street, addr.house].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

function mapYmRow(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const items = Array.isArray(r.items) ? r.items : [];
  const first = items[0] && typeof items[0] === 'object' ? items[0] : {};
  const lp = r.logisticPickupPoint && typeof r.logisticPickupPoint === 'object' ? r.logisticPickupPoint : {};
  const st = String(r.shipmentStatus || '').toUpperCase();
  const returnType = r.returnType === 'UNREDEEMED' ? 'Невыкуп' : r.returnType === 'RETURN' ? 'Возврат' : r.returnType;
  const names = items.map((it) => it?.offerName || it?.shopSku).filter(Boolean);
  const productName = names.length > 1 ? `${names[0]} (+${names.length - 1})` : (names[0] || null);
  return {
    marketplace: 'yandex',
    id: String(r.id ?? `${r.orderId}-${r.creationDate}`),
    status: YM_SHIPMENT_STATUS_LABELS[st] || st || null,
    statusDetail: returnType ?? null,
    waitingPickup: isYmReturnWaitingPickup(r),
    sku: first.shopSku != null ? String(first.shopSku) : (first.marketSku != null ? String(first.marketSku) : null),
    barcode: null,
    productName,
    productExtra: items.length > 1 ? `${items.length} поз.` : null,
    pickupAddress: lp.name || formatYmAddress(lp.address) || null,
    pickupPointId: lp.id ?? null,
    readyFromDt: r.creationDate ?? r.updateDate ?? null,
    expiredDt: r.pickupTillDate ?? null,
    reason: first.returnReasonType || first.comments || null,
    orderId: r.orderId != null ? String(r.orderId) : null,
    orderDt: r.creationDate ?? null,
  };
}

async function resolveOzonCredentials(profileId, organizationId) {
  let config = await integrationsService.getMarketplaceConfig('ozon', { profileId, organizationId });
  if ((!config?.api_key || !String(config.api_key).trim()) && organizationId != null) {
    config = await integrationsService.getMarketplaceConfig('ozon', { profileId, organizationId: null });
  }
  const clientId = config?.client_id ?? config?.clientId;
  const apiKey = config?.api_key ?? config?.apiKey;
  if (!clientId || !String(clientId).trim() || !apiKey || !String(apiKey).trim()) {
    const err = new Error('Ozon: не настроены Client-Id и Api-Key.');
    err.statusCode = 400;
    throw err;
  }
  return { clientId: String(clientId).trim(), apiKey: String(apiKey).trim() };
}

async function fetchOzonReturnsRaw({ clientId, apiKey, timeFrom, timeTo }) {
  const acc = [];
  let lastId = 0;
  for (let page = 0; page < 200; page++) {
    const r = await fetch('https://api-seller.ozon.ru/v1/returns/list', {
      method: 'POST',
      headers: {
        'Client-Id': clientId,
        'Api-Key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        filter: {
          visual_status_change_moment: {
            time_from: timeFrom,
            time_to: timeTo,
          },
        },
        limit: 500,
        last_id: lastId,
      }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      const err = new Error(`Ozon returns/list ${r.status}: ${t.substring(0, 400)}`);
      err.statusCode = r.status === 401 ? 403 : r.status;
      throw err;
    }
    const data = await r.json();
    const rows = Array.isArray(data?.returns) ? data.returns : [];
    acc.push(...rows);
    if (!data?.has_next || rows.length === 0) break;
    const tail = rows[rows.length - 1];
    lastId = tail?.id ?? lastId;
  }
  return acc;
}

async function listOzonReturns(profileId, options = {}) {
  const key = `${CACHE_LOGIC_VERSION}|${profileId}|${options.organizationId ?? ''}|${options.days ?? DEFAULT_DAYS}`;
  const hit = ozonCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return hit.rows;
  }
  const { clientId, apiKey } = await resolveOzonCredentials(profileId, options.organizationId ?? null);
  const { timeFrom, timeTo } = isoRangeForDays(options.days);
  const raw = await fetchOzonReturnsRaw({ clientId, apiKey, timeFrom, timeTo });
  const rows = filterActiveReturns(raw.map(mapOzonRow));
  ozonCache.set(key, { at: Date.now(), rows });
  return rows;
}

async function resolveYandexConfig(profileId, organizationId) {
  let config = await integrationsService.getMarketplaceConfig('yandex', { profileId, organizationId });
  if ((!config?.api_key || !String(config.api_key).trim()) && organizationId != null) {
    config = await integrationsService.getMarketplaceConfig('yandex', { profileId, organizationId: null });
  }
  const apiKey = normalizeYandexApiKey(config?.api_key ?? config?.apiKey);
  if (!apiKey) {
    const err = new Error('Яндекс Маркет: не настроен Api-Key.');
    err.statusCode = 400;
    throw err;
  }
  return { config, apiKey };
}

async function fetchYmReturnsForCampaign(apiKey, campaignId, query) {
  const agent = getYandexHttpsAgent();
  const acc = [];
  let pageToken = '';
  for (let page = 0; page < 100; page++) {
    const qs = new URLSearchParams(query);
    if (pageToken) qs.set('pageToken', pageToken);
    const url = `https://api.partner.market.yandex.ru/v2/campaigns/${encodeURIComponent(String(campaignId))}/returns?${qs.toString()}`;
    const r = await fetch(url, {
      method: 'GET',
      headers: {
        'Api-Key': apiKey,
        Accept: 'application/json',
      },
      ...(agent && { agent }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      const err = new Error(`Яндекс Маркет returns ${r.status}: ${t.substring(0, 400)}`);
      err.statusCode = r.status === 401 ? 403 : r.status;
      throw err;
    }
    const data = await r.json();
    const result = data?.result ?? data;
    const rows = Array.isArray(result?.returns) ? result.returns : [];
    acc.push(...rows);
    const next = result?.paging?.nextPageToken;
    if (!next || rows.length === 0) break;
    pageToken = next;
  }
  return acc;
}

async function listYandexReturns(profileId, options = {}) {
  const key = `${CACHE_LOGIC_VERSION}|${profileId}|${options.organizationId ?? ''}|${options.days ?? DEFAULT_DAYS}`;
  const hit = ymCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return hit.rows;
  }
  const { config, apiKey } = await resolveYandexConfig(profileId, options.organizationId ?? null);
  const { campaignIds } = await getYandexBusinessAndCampaigns(config);
  const ids = Array.isArray(campaignIds) ? [...new Set(campaignIds.filter(Boolean))] : [];
  if (ids.length === 0) {
    const err = new Error('Яндекс Маркет: не найден campaign_id. Проверьте интеграцию.');
    err.statusCode = 400;
    throw err;
  }
  const { fromYmd, toYmd } = isoRangeForDays(options.days);
  const query = { fromDate: fromYmd, toDate: toYmd };
  const allRaw = [];
  for (const campaignId of ids) {
    const chunk = await fetchYmReturnsForCampaign(apiKey, campaignId, query);
    allRaw.push(...chunk);
  }
  const rows = filterActiveReturns(dedupeUnified(allRaw.map(mapYmRow)));
  ymCache.set(key, { at: Date.now(), rows });
  return rows;
}

async function listWildberriesReturns(profileId, options = {}) {
  const { items } = await listWbGoodsReturns(profileId, options);
  return items.map(mapWbRow);
}

function normalizeMarketplaceFilter(mp) {
  const s = String(mp || 'all').trim().toLowerCase();
  if (s === 'wb') return 'wildberries';
  if (s === 'ym') return 'yandex';
  if (['ozon', 'wildberries', 'yandex', 'all'].includes(s)) return s;
  return 'all';
}

async function fetchMarketplaceSlice(profileId, marketplace, options) {
  if (marketplace === 'ozon') return listOzonReturns(profileId, options);
  if (marketplace === 'wildberries') return listWildberriesReturns(profileId, options);
  if (marketplace === 'yandex') return listYandexReturns(profileId, options);
  return [];
}

/**
 * @param {number|string} profileId
 * @param {object} [options]
 * @param {string} [options.marketplace] all | ozon | wildberries | yandex
 * @param {string} [options.marketplace] all | ozon | wildberries | yandex
 */
export async function listMarketplaceReturns(profileId, options = {}) {
  const mpFilter = normalizeMarketplaceFilter(options.marketplace);
  const marketplaces =
    mpFilter === 'all' ? ['ozon', 'wildberries', 'yandex'] : [mpFilter];

  const errors = {};
  const slices = await Promise.all(
    marketplaces.map(async (mp) => {
      try {
        const rows = await fetchMarketplaceSlice(profileId, mp, options);
        return { mp, rows };
      } catch (e) {
        errors[mp] = e?.message || String(e);
        return { mp, rows: [] };
      }
    })
  );

  const items = sortUnifiedRows(dedupeUnified(slices.flatMap((s) => s.rows)));

  return {
    items,
    meta: {
      waitingCount: items.length,
      marketplace: mpFilter,
      countsByMarketplace: countWaitingByMarketplace(items),
      errors: Object.keys(errors).length ? errors : undefined,
    },
  };
}

export async function getMarketplaceReturnsStats(profileId, options = {}) {
  const { meta } = await listMarketplaceReturns(profileId, options);
  const byMp = meta.countsByMarketplace || { ozon: 0, wildberries: 0, yandex: 0 };
  return {
    waitingCount: meta.waitingCount,
    totalCount: meta.waitingCount,
    countsByMarketplace: byMp,
    errors: meta.errors,
  };
}
