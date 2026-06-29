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
