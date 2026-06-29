/**
 * Wildberries Seller Analytics API (остатки на складах FBW/FBO).
 */

const WB_ANALYTICS_HOSTS = [
  'https://seller-analytics-api.wildberries.ru',
  'https://statistics-api.wildberries.ru',
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toInt(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.trunc(n);
}

function parseIsoDate(value) {
  const m = String(value ?? '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatIsoDate(d) {
  return d.toISOString().slice(0, 10);
}

function countInclusiveDays(startIso, endIso) {
  const start = parseIsoDate(startIso);
  const end = parseIsoDate(endIso);
  if (!start || !end || start > end) return 1;
  const ms = end.getTime() - start.getTime();
  return Math.max(1, Math.floor(ms / 86400000) + 1);
}

export function buildAnalyticsPeriod(planDays) {
  const days = Math.min(366, Math.max(1, toInt(planDays) || 30));
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - (days - 1));
  return { start: formatIsoDate(start), end: formatIsoDate(end), days };
}

export function buildAnalyticsPeriodFromRange({ start, end, days } = {}) {
  const startIso = String(start || '').trim().slice(0, 10);
  const endIso = String(end || '').trim().slice(0, 10);
  if (parseIsoDate(startIso) && parseIsoDate(endIso)) {
    const span = countInclusiveDays(startIso, endIso);
    return {
      start: startIso,
      end: endIso,
      days: Math.min(366, Math.max(1, toInt(days) || span)),
    };
  }
  return buildAnalyticsPeriod(days || 30);
}

/**
 * POST /api/v2/stocks-report/products/products — заказы по номенклатурам за период (склады WB).
 * @param {string} apiKey
 * @param {number|{start?: string, end?: string, days?: number}} periodInput
 * @returns {Promise<Map<string, number>>} nmId → ordersCount
 */
export async function fetchWbProductsOrdersCountMap(apiKey, periodInput = 30) {
  const token = String(apiKey || '').trim();
  const map = new Map();
  if (!token) return map;

  const period =
    periodInput != null && typeof periodInput === 'object'
      ? buildAnalyticsPeriodFromRange(periodInput)
      : buildAnalyticsPeriod(periodInput);
  const availabilityFilters = [
    'deficient',
    'actual',
    'balanced',
    'nonActual',
    'nonLiquid',
    'invalidData',
  ];
  let offset = 0;
  const limit = 1000;
  let lastErr = '';

  for (const base of WB_ANALYTICS_HOSTS) {
    try {
      map.clear();
      offset = 0;
      for (let page = 0; page < 30; page++) {
        const body = {
          nmIDs: [],
          currentPeriod: { start: period.start, end: period.end },
          stockType: 'wb',
          skipDeletedNm: true,
          orderBy: { field: 'ordersCount', mode: 'desc' },
          availabilityFilters,
          limit,
          offset,
        };
        const r = await fetch(`${base}/api/v2/stocks-report/products/products`, {
          method: 'POST',
          headers: {
            Authorization: token,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify(body),
        });
        if (!r.ok) {
          lastErr = `${r.status}: ${await r.text().catch(() => '')}`;
          break;
        }
        const data = await r.json();
        const items = Array.isArray(data?.data?.items)
          ? data.data.items
          : Array.isArray(data?.items)
            ? data.items
            : [];
        for (const it of items) {
          const nm = it?.nmID ?? it?.nmId;
          const cnt = it?.metrics?.ordersCount ?? it?.metrics?.orders ?? null;
          if (nm == null) continue;
          const key = String(nm).trim();
          if (!key) continue;
          map.set(key, toInt(cnt));
        }
        if (items.length < limit) return map;
        offset += limit;
        await sleep(300);
      }
      if (map.size > 0) return map;
    } catch (e) {
      lastErr = e?.message || String(e);
    }
  }

  if (lastErr) {
    const err = new Error(`WB orders report failed: ${lastErr}`);
    err.statusCode = 502;
    throw err;
  }
  return map;
}

/**
 * POST /api/analytics/v1/stocks-report/wb-warehouses
 * @param {string} apiKey
 * @returns {Promise<object[]>}
 */
export async function fetchWbWarehousesInventory(apiKey) {
  const token = String(apiKey || '').trim();
  if (!token) {
    const err = new Error('Не настроен API-ключ Wildberries (категория «Аналитика»).');
    err.statusCode = 400;
    throw err;
  }

  const limit = 250000;
  let offset = 0;
  const allItems = [];
  let lastErr = '';

  for (const base of WB_ANALYTICS_HOSTS) {
    try {
      allItems.length = 0;
      offset = 0;
      for (let page = 0; page < 50; page++) {
        const body = { nmIds: [], chrtIds: [], limit, offset };
        const r = await fetch(`${base}/api/analytics/v1/stocks-report/wb-warehouses`, {
          method: 'POST',
          headers: {
            Authorization: token,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify(body),
        });
        if (!r.ok) {
          lastErr = `${r.status}: ${await r.text().catch(() => '')}`;
          break;
        }
        const data = await r.json();
        const items = Array.isArray(data?.data?.items)
          ? data.data.items
          : Array.isArray(data?.items)
            ? data.items
            : [];
        allItems.push(...items);
        if (items.length < limit) {
          return allItems;
        }
        offset += limit;
        await sleep(300);
      }
      if (allItems.length > 0) return allItems;
    } catch (e) {
      lastErr = e?.message || String(e);
    }
  }

  const err = new Error(`WB inventory fetch failed: ${lastErr || 'unknown error'}`);
  err.statusCode = 502;
  throw err;
}

export function normalizeWbWarehouseInventoryItem(it) {
  const nmRaw = it?.nmId ?? it?.nmID;
  const chrtRaw = it?.chrtId ?? it?.chrtID;
  const nmStr = nmRaw != null && String(nmRaw).trim() !== '' ? String(nmRaw).trim() : '';
  const chrtStr = chrtRaw != null && String(chrtRaw).trim() !== '' ? String(chrtRaw).trim() : '';
  const chrtNum = chrtStr ? Number(chrtStr) : NaN;
  let externalSku = '';
  if (nmStr && chrtStr && Number.isFinite(chrtNum) && chrtNum > 0) {
    externalSku = `${nmStr}:${chrtStr}`;
  } else if (nmStr) {
    externalSku = nmStr;
  } else {
    externalSku = chrtStr;
  }

  const wid = it?.warehouseId ?? it?.warehouseID;
  const warehouseId = wid != null && String(wid).trim() !== '' ? Number(wid) : null;

  return {
    nmId: nmStr ? Number(nmStr) : null,
    chrtId: chrtStr ? Number(chrtStr) : null,
    warehouseId: Number.isFinite(warehouseId) ? warehouseId : null,
    warehouseName: String(it?.warehouseName || '').trim() || null,
    regionName: String(it?.regionName || '').trim() || null,
    quantity: toInt(it?.quantity),
    inWayToClient: toInt(it?.inWayToClient),
    inWayFromClient: toInt(it?.inWayFromClient),
    externalSku,
  };
}
