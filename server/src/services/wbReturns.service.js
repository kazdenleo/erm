/**
 * Возвраты Wildberries: отчёт goods-return (Analytics API).
 * По умолчанию — позиции, которые ещё ждут забора продавцом с ПВЗ.
 */

import integrationsService from './integrations.service.js';

const WB_GOODS_RETURN_URL = 'https://seller-analytics-api.wildberries.ru/api/v1/analytics/goods-return';
const MAX_DAYS_PER_REQUEST = 31;
const DEFAULT_DAYS = 31;
const CACHE_TTL_MS = 3 * 60 * 1000;

/** @type {Map<string, { at: number, normalized: object[] }>} */
const goodsReturnCache = new Map();

function formatDateYmd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseYmd(s) {
  const m = String(s || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

/** Интервалы по ≤31 дню для WB API. */
export function buildGoodsReturnDateRanges({ dateFrom, dateTo, days = DEFAULT_DAYS } = {}) {
  let from = parseYmd(dateFrom);
  let to = parseYmd(dateTo);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  if (!to) {
    to = today;
  }
  if (!from) {
    const span = Math.max(1, Math.min(Number(days) || DEFAULT_DAYS, 93));
    from = addDays(to, -(span - 1));
  }
  if (from > to) {
    const tmp = from;
    from = to;
    to = tmp;
  }

  const ranges = [];
  let cursor = new Date(from);
  while (cursor <= to) {
    const chunkEnd = addDays(cursor, MAX_DAYS_PER_REQUEST - 1);
    const end = chunkEnd > to ? to : chunkEnd;
    ranges.push({ dateFrom: formatDateYmd(cursor), dateTo: formatDateYmd(end) });
    cursor = addDays(end, 1);
  }
  return ranges;
}

/** Возврат уже на ПВЗ и ждёт, когда продавец заберёт (не «в пути»). */
export function isWbReturnWaitingPickup(row) {
  if (row == null || typeof row !== 'object') return false;
  const st = String(row.status || '').toLowerCase();
  if (!st) return false;

  if (/пути|транзит|доставля|отправлен|перемещ|в\s*дорог/.test(st)) return false;
  if (/получен|выдан|заверш|утилиз|закрыт/.test(st)) return false;

  if (/готов\s*к\s*выдач|ожидает\s*забор|жд(?:е|ё)т\s*забор|можно\s*забрать|ожидает\s*получен/.test(st)) {
    return true;
  }
  if (/на\s*пвз/.test(st) && !/пути/.test(st)) return true;

  return false;
}

function normalizeGoodsReturnRow(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const row = {
    barcode: r.barcode ?? null,
    brand: r.brand ?? null,
    completedDt: r.completedDt ?? null,
    dstOfficeAddress: r.dstOfficeAddress ?? null,
    dstOfficeId: r.dstOfficeId ?? null,
    expiredDt: r.expiredDt ?? null,
    isStatusActive: r.isStatusActive ?? null,
    nmId: r.nmId ?? null,
    orderDt: r.orderDt ?? null,
    orderId: r.orderId ?? null,
    readyToReturnDt: r.readyToReturnDt ?? null,
    reason: r.reason ?? null,
    returnType: r.returnType ?? null,
    shkId: r.shkId ?? null,
    srid: r.srid ?? null,
    status: r.status ?? null,
    stickerId: r.stickerId ?? null,
    subjectName: r.subjectName ?? null,
    techSize: r.techSize ?? null,
  };
  row.waitingPickup = isWbReturnWaitingPickup(row);
  row.id = String(r.srid || r.shkId || `${r.orderId || 'o'}-${r.nmId || 'n'}-${r.stickerId || 's'}`);
  return row;
}

async function resolveWbApiKey(profileId, organizationId) {
  let config = await integrationsService.getMarketplaceConfig('wildberries', { profileId, organizationId });
  if ((!config?.api_key || !String(config.api_key).trim()) && organizationId != null) {
    config = await integrationsService.getMarketplaceConfig('wildberries', { profileId, organizationId: null });
  }
  const raw = config?.api_key ?? config?.apiKey;
  const apiKey = raw ? integrationsService._normalizeWbToken(raw) : null;
  if (!apiKey) {
    const err = new Error('Wildberries: не настроен API-ключ (нужна категория «Аналитика» в токене).');
    err.statusCode = 400;
    throw err;
  }
  return apiKey;
}

async function fetchGoodsReturnChunk(apiKey, dateFrom, dateTo) {
  const qs = new URLSearchParams({ dateFrom, dateTo });
  const url = `${WB_GOODS_RETURN_URL}?${qs.toString()}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: apiKey,
      Accept: 'application/json',
    },
  });
  const text = await response.text();
  if (!response.ok) {
    const err = new Error(`Wildberries Analytics ${response.status}: ${text.substring(0, 400)}`);
    err.statusCode = response.status === 401 ? 403 : response.status;
    throw err;
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('Wildberries: неверный JSON в ответе goods-return');
  }
  const report = json?.report ?? json?.data?.report ?? [];
  return Array.isArray(report) ? report : [];
}

function dedupeRows(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = row.id || `${row.srid}-${row.shkId}-${row.nmId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function applyPickupFilter(rows, filter) {
  const f = String(filter || 'waiting').toLowerCase();
  if (f === 'all') return rows;
  if (f === 'completed') return rows.filter((r) => !r.waitingPickup);
  return rows.filter((r) => r.waitingPickup);
}

function sortRows(rows) {
  return [...rows].sort((a, b) => {
    const da = a.readyToReturnDt || a.orderDt || '';
    const db = b.readyToReturnDt || b.orderDt || '';
    return String(db).localeCompare(String(da));
  });
}

function cacheKey(profileId, options) {
  const organizationId = options.organizationId ?? '';
  const days = options.days ?? DEFAULT_DAYS;
  const dateFrom = options.dateFrom ?? '';
  const dateTo = options.dateTo ?? '';
  return `pickup-ready-v2|${profileId}|${organizationId}|${days}|${dateFrom}|${dateTo}`;
}

async function fetchNormalizedGoodsReturns(profileId, options = {}) {
  const key = cacheKey(profileId, options);
  const hit = goodsReturnCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return { normalized: hit.normalized, ranges: hit.ranges };
  }

  const organizationId = options.organizationId ?? null;
  const apiKey = await resolveWbApiKey(profileId, organizationId);
  const ranges = buildGoodsReturnDateRanges({
    dateFrom: options.dateFrom,
    dateTo: options.dateTo,
    days: options.days,
  });

  const allRaw = [];
  for (const range of ranges) {
    const chunk = await fetchGoodsReturnChunk(apiKey, range.dateFrom, range.dateTo);
    allRaw.push(...chunk);
  }

  const normalized = dedupeRows(allRaw.map(normalizeGoodsReturnRow));
  goodsReturnCache.set(key, { at: Date.now(), normalized, ranges });
  return { normalized, ranges };
}

/**
 * @param {number|string} profileId
 * @param {object} [options]
 * @param {string|null} [options.organizationId]
 * @param {string} [options.filter] waiting | all | completed
 * @param {string} [options.dateFrom] YYYY-MM-DD
 * @param {string} [options.dateTo] YYYY-MM-DD
 * @param {number} [options.days]
 */
export async function listWbGoodsReturns(profileId, options = {}) {
  const { normalized, ranges } = await fetchNormalizedGoodsReturns(profileId, options);
  const filtered = applyPickupFilter(normalized, options.filter);
  const items = sortRows(filtered);

  const waitingCount = normalized.filter((r) => r.waitingPickup).length;
  return {
    items,
    meta: {
      totalFetched: normalized.length,
      waitingCount,
      completedCount: normalized.length - waitingCount,
      filter: String(options.filter || 'waiting').toLowerCase(),
      dateRanges: ranges,
    },
  };
}

export async function getWbGoodsReturnsStats(profileId, options = {}) {
  const { meta } = await listWbGoodsReturns(profileId, { ...options, filter: 'all' });
  return {
    waitingCount: meta.waitingCount,
    totalCount: meta.totalFetched,
    completedCount: meta.completedCount,
  };
}
