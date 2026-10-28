/**
 * Wildberries Advert API → unified ads_*.
 * Docs: https://advert-api.wildberries.ru
 */

import integrationsService from '../integrations.service.js';
import logger from '../../utils/logger.js';
import {
  computeDrrPercent,
  formatYmd,
  normalizeSkuKey,
  parseMoney,
  sleep,
} from '../../utils/adsDrr.js';
import {
  finishSyncRun,
  logAction,
  markActiveMembership,
  resolveScope,
  startSyncRun,
  upsertCampaign,
  upsertCampaignProduct,
  upsertDailyStats,
  upsertSkuStats,
} from './adsStore.js';
import { query } from '../../config/database.js';

const MARKETPLACE = 'wildberries';
const BASE = 'https://advert-api.wildberries.ru';

function readAdvertToken(config) {
  if (!config || typeof config !== 'object') return null;
  const advert = String(config.advert_api_key ?? config.advertApiKey ?? '').trim();
  const main = String(config.api_key ?? config.apiKey ?? '').trim();
  return advert || main || null;
}

async function wbFetch(token, path, { method = 'GET', body = null } = {}) {
  const url = path.startsWith('http') ? path : `${BASE}${path.startsWith('/') ? path : `/${path}`}`;
  const opts = {
    method,
    headers: {
      Authorization: token,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
  };
  if (body) opts.body = JSON.stringify(body);

  let lastErr = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await fetch(url, opts);
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (response.status === 429) {
      await sleep(1500 * (attempt + 1));
      lastErr = new Error(`WB Advert 429: ${(text || '').slice(0, 200)}`);
      continue;
    }
    if (!response.ok) {
      const err = new Error(`WB Advert ${response.status}: ${(text || '').slice(0, 400)}`);
      err.statusCode = response.status;
      throw err;
    }
    return json ?? text;
  }
  throw lastErr || new Error('WB Advert: слишком много 429');
}

function mapStatus(raw) {
  const n = Number(raw);
  // WB: 9=active, 11=paused, 7=finished, etc.
  if (n === 9) return 'RUNNING';
  if (n === 11) return 'PAUSED';
  if (n === 7) return 'FINISHED';
  if (n === 8) return 'READY';
  return raw != null ? String(raw) : null;
}

function isActiveStatus(status) {
  return String(status || '').toUpperCase() === 'RUNNING' || Number(status) === 9;
}

async function listAdverts(token) {
  // v1/promotion/count → then adverts; also try v2/adverts
  try {
    const data = await wbFetch(token, '/adv/v1/promotion/count');
    const ids = [];
    const groups = Array.isArray(data?.adverts) ? data.adverts : Array.isArray(data) ? data : [];
    for (const g of groups) {
      const advertList = Array.isArray(g?.advert_list)
        ? g.advert_list
        : Array.isArray(g?.advertList)
          ? g.advertList
          : [];
      for (const a of advertList) {
        const id = a?.advertId ?? a?.advert_id ?? a?.id;
        if (id != null) ids.push(Number(id));
      }
      const typeIds = Array.isArray(g?.advert_id) ? g.advert_id : [];
      for (const id of typeIds) if (id != null) ids.push(Number(id));
    }
    if (ids.length) {
      // Fetch details in chunks
      const unique = [...new Set(ids.filter((n) => Number.isFinite(n)))];
      const details = [];
      for (let i = 0; i < unique.length; i += 50) {
        const chunk = unique.slice(i, i + 50);
        try {
          const res = await wbFetch(
            token,
            `/adv/v1/promotion/adverts?status=&type=&limit=50&offset=0`
          );
          // Alternative: POST with ids
          void res;
        } catch {
          /* ignore */
        }
        try {
          const res = await wbFetch(token, '/adv/v1/promotion/adverts', {
            method: 'POST',
            body: chunk,
          });
          const list = Array.isArray(res) ? res : Array.isArray(res?.adverts) ? res.adverts : [];
          details.push(...list);
        } catch (e) {
          logger.warn('[Ads WB] adverts details failed', { message: e?.message || String(e) });
        }
        await sleep(400);
      }
      if (details.length) return details;
      return unique.map((id) => ({ advertId: id, status: 9 }));
    }
  } catch (e) {
    logger.warn('[Ads WB] promotion/count failed', { message: e?.message || String(e) });
  }

  try {
    const res = await wbFetch(token, '/adv/v1/promotion/adverts');
    if (Array.isArray(res)) return res;
    if (Array.isArray(res?.adverts)) return res.adverts;
  } catch (e) {
    logger.warn('[Ads WB] promotion/adverts GET failed', { message: e?.message || String(e) });
  }
  return [];
}

function extractNmIdsFromAdvert(advert) {
  const out = new Set();
  const push = (v) => {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) out.add(String(n));
    const s = normalizeSkuKey(v);
    if (s) out.add(s);
  };
  const walk = (node) => {
    if (!node) return;
    if (Array.isArray(node)) {
      for (const x of node) walk(x);
      return;
    }
    if (typeof node !== 'object') return;
    push(node.nm ?? node.nmId ?? node.nm_id ?? node.nmid);
    for (const key of ['nms', 'nmIds', 'nm_ids', 'params', 'autoParams', 'unitedParams', 'auction_multibids']) {
      if (node[key] != null) walk(node[key]);
    }
  };
  walk(advert);
  return [...out];
}

async function fetchFullstats(token, campaignIds, dateFrom, dateTo) {
  if (!campaignIds.length) return [];
  const body = campaignIds.slice(0, 100).map((id) => ({
    id: Number(id),
    dates: [],
    interval: { begin: dateFrom, end: dateTo },
  }));
  try {
    const res = await wbFetch(token, '/adv/v2/fullstats', { method: 'POST', body });
    return Array.isArray(res) ? res : [];
  } catch (e) {
    logger.warn('[Ads WB] fullstats failed', { message: e?.message || String(e) });
    return [];
  }
}

function aggregateFullstats(fullstats) {
  /** @type {Map<string, { spend: number, revenue: number, views: number, clicks: number, orders: number, daily: Map<string, object> }>} */
  const byNm = new Map();
  const ensure = (nm) => {
    const key = String(nm);
    if (!byNm.has(key)) {
      byNm.set(key, {
        spend: 0,
        revenue: 0,
        views: 0,
        clicks: 0,
        orders: 0,
        daily: new Map(),
      });
    }
    return byNm.get(key);
  };

  for (const camp of fullstats || []) {
    const days = Array.isArray(camp?.days) ? camp.days : [];
    for (const day of days) {
      const date = day?.date ? String(day.date).slice(0, 10) : null;
      const apps = Array.isArray(day?.apps) ? day.apps : [day];
      for (const app of apps) {
        const nms = Array.isArray(app?.nms) ? app.nms : Array.isArray(app?.nm) ? app.nm : [];
        const list = nms.length ? nms : [app];
        for (const nmRow of list) {
          const nm = nmRow?.nm ?? nmRow?.nmId ?? nmRow?.nm_id ?? null;
          if (nm == null && !nms.length) continue;
          const key = nm != null ? String(nm) : null;
          if (!key) continue;
          const spend = parseMoney(nmRow.sum ?? nmRow.spent ?? nmRow.spend ?? app.sum ?? day.sum);
          const revenue = parseMoney(
            nmRow.sum_price ?? nmRow.ordersSum ?? nmRow.order_sum ?? nmRow.atbs ?? 0
          );
          const views = Number(nmRow.views ?? nmRow.shows ?? 0) || 0;
          const clicks = Number(nmRow.clicks ?? 0) || 0;
          const orders = Number(nmRow.orders ?? nmRow.shks ?? 0) || 0;
          const agg = ensure(key);
          agg.spend += spend;
          agg.revenue += revenue;
          agg.views += views;
          agg.clicks += clicks;
          agg.orders += orders;
          if (date) {
            const d = agg.daily.get(date) || {
              spend: 0,
              revenue: 0,
              views: 0,
              clicks: 0,
              orders: 0,
            };
            d.spend += spend;
            d.revenue += revenue;
            d.views += views;
            d.clicks += clicks;
            d.orders += orders;
            agg.daily.set(date, d);
          }
        }
      }
    }
  }
  return byNm;
}

export async function testConnection(scope = {}) {
  const cfg = await integrationsService.getMarketplaceConfig('wildberries', scope);
  const token = readAdvertToken(cfg);
  if (!token) {
    return { ok: false, message: 'Укажите API Key WB (с правом «Продвижение») или Advert API Key' };
  }
  try {
    const count = await wbFetch(token, '/adv/v1/promotion/count');
    const adverts = Array.isArray(count?.adverts) ? count.adverts.length : 0;
    return { ok: true, message: `WB Advert: OK (групп: ${adverts})`, raw: count };
  } catch (e) {
    return { ok: false, message: e?.message || 'Ошибка WB Advert API' };
  }
}

export async function syncStats(scope = {}, { days = 14 } = {}) {
  const runId = await startSyncRun({ scope, marketplace: MARKETPLACE, kind: 'stats', days });
  try {
    const cfg = await integrationsService.getMarketplaceConfig('wildberries', scope);
    const token = readAdvertToken(cfg);
    if (!token) {
      const result = { ok: false, skipped: true, reason: 'no_advert_token' };
      await finishSyncRun(runId, { status: 'skipped', meta: result });
      return result;
    }

    const adverts = await listAdverts(token);
    const campaignIds = [];
    const activeNm = new Set();

    for (const adv of adverts) {
      const externalId = String(adv.advertId ?? adv.advert_id ?? adv.id ?? '').trim();
      if (!externalId) continue;
      campaignIds.push(Number(externalId));
      const status = mapStatus(adv.status ?? adv.advertStatus);
      const campDbId = await upsertCampaign(scope, MARKETPLACE, {
        externalId,
        name: adv.name || adv.campaignName || `Кампания ${externalId}`,
        status,
        campaignType: String(adv.type ?? adv.advertType ?? ''),
        dailyBudget: parseMoney(adv.dailyBudget ?? adv.budget) || null,
        bid: parseMoney(adv.bid ?? adv.cpm) || null,
        raw: adv,
      });
      const nms = extractNmIdsFromAdvert(adv);
      if (isActiveStatus(status)) {
        for (const nm of nms) activeNm.add(nm);
      }
      if (campDbId) {
        for (const nm of nms) {
          await upsertCampaignProduct(campDbId, {
            skuKey: nm,
            externalProductId: nm,
            inActive: isActiveStatus(status),
            bid: parseMoney(adv.bid) || null,
          });
        }
      }
    }

    const to = new Date();
    to.setHours(0, 0, 0, 0);
    const from = new Date(to);
    from.setDate(from.getDate() - (Math.max(1, Math.min(Number(days) || 14, 31)) - 1));
    const dateFrom = formatYmd(from);
    const dateTo = formatYmd(to);

    const fullstats = await fetchFullstats(
      token,
      campaignIds.filter((n) => Number.isFinite(n)),
      dateFrom,
      dateTo
    );
    const byNm = aggregateFullstats(fullstats);
    let upserted = 0;
    const dailyRows = [];
    for (const [nm, agg] of byNm.entries()) {
      await upsertSkuStats(scope, MARKETPLACE, {
        skuKey: nm,
        spend: agg.spend,
        revenue: agg.revenue,
        views: agg.views,
        clicks: agg.clicks,
        orders: agg.orders,
        drrPercent: computeDrrPercent(agg.spend, agg.revenue),
        inActiveCampaign: activeNm.has(nm) ? true : activeNm.size ? false : null,
        periodFrom: dateFrom,
        periodTo: dateTo,
        source: 'wb_advert',
      });
      upserted += 1;
      for (const [statDate, d] of agg.daily.entries()) {
        dailyRows.push({
          skuKey: nm,
          statDate,
          spend: d.spend,
          revenue: d.revenue,
          views: d.views,
          clicks: d.clicks,
          orders: d.orders,
        });
      }
    }
    await upsertDailyStats(scope, MARKETPLACE, dailyRows);
    await markActiveMembership(scope, MARKETPLACE, [...activeNm]);

    const result = {
      ok: true,
      marketplace: MARKETPLACE,
      campaigns: campaignIds.length,
      upserted,
      activeSkus: activeNm.size,
      dateFrom,
      dateTo,
    };
    await finishSyncRun(runId, { status: 'ok', meta: result });
    return result;
  } catch (e) {
    await finishSyncRun(runId, { status: 'error', message: e?.message || String(e) });
    throw e;
  }
}

export async function syncMembership(scope = {}) {
  return syncStats(scope, { days: 7 });
}

export async function listCampaignsFromDb(scope = {}) {
  const { scopeKey, profileId } = resolveScope(scope);
  const r = await query(
    `SELECT * FROM ads_campaigns
     WHERE marketplace = $1
       AND (scope_key = $2 OR ($3::int IS NOT NULL AND profile_id = $3))
     ORDER BY updated_at DESC
     LIMIT 500`,
    [MARKETPLACE, scopeKey, profileId]
  );
  return r.rows || [];
}

export async function setCampaignStatus(scope, campaignRow, status, { userId = null } = {}) {
  const cfg = await integrationsService.getMarketplaceConfig('wildberries', scope);
  const token = readAdvertToken(cfg);
  if (!token) {
    const err = new Error('Нет токена WB Advert');
    err.statusCode = 400;
    throw err;
  }
  const id = campaignRow?.external_id;
  const action = status === 'pause' || status === 'PAUSED' ? 'pause' : 'start';
  try {
    const path =
      action === 'pause'
        ? `/adv/v0/pause?id=${encodeURIComponent(id)}`
        : `/adv/v0/start?id=${encodeURIComponent(id)}`;
    await wbFetch(token, path);
    await query(
      `UPDATE ads_campaigns SET status = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [campaignRow.id, action === 'pause' ? 'PAUSED' : 'RUNNING']
    );
    await logAction({
      scope,
      marketplace: MARKETPLACE,
      campaignId: campaignRow.id,
      userId,
      action,
      payload: { externalId: id },
      result: { ok: true },
      ok: true,
    });
    return { ok: true, status: action === 'pause' ? 'PAUSED' : 'RUNNING' };
  } catch (e) {
    await logAction({
      scope,
      marketplace: MARKETPLACE,
      campaignId: campaignRow?.id ?? null,
      userId,
      action,
      payload: { externalId: id },
      ok: false,
      errorMessage: e?.message || String(e),
    });
    throw e;
  }
}

export async function setBid(scope, campaignRow, { skuKey, bid }, { userId = null } = {}) {
  const cfg = await integrationsService.getMarketplaceConfig('wildberries', scope);
  const token = readAdvertToken(cfg);
  if (!token) {
    const err = new Error('Нет токена WB Advert');
    err.statusCode = 400;
    throw err;
  }
  const advertId = Number(campaignRow.external_id);
  const nm = Number(skuKey);
  const bidNum = Number(bid);
  if (!Number.isFinite(advertId) || !Number.isFinite(nm) || !Number.isFinite(bidNum)) {
    const err = new Error('Нужны advertId, nm (sku) и ставка');
    err.statusCode = 400;
    throw err;
  }
  try {
    // Common payload shapes across API versions
    await wbFetch(token, '/adv/v0/bids', {
      method: 'POST',
      body: [{ advertId, nm, bid: Math.round(bidNum) }],
    });
    if (campaignRow.id) {
      await upsertCampaignProduct(campaignRow.id, { skuKey: String(nm), bid: bidNum });
    }
    await logAction({
      scope,
      marketplace: MARKETPLACE,
      campaignId: campaignRow.id,
      userId,
      action: 'set_bid',
      payload: { skuKey, bid: bidNum },
      result: { ok: true },
      ok: true,
    });
    return { ok: true, bid: bidNum };
  } catch (e) {
    await logAction({
      scope,
      marketplace: MARKETPLACE,
      campaignId: campaignRow?.id ?? null,
      userId,
      action: 'set_bid',
      payload: { skuKey, bid: bidNum },
      ok: false,
      errorMessage: e?.message || String(e),
    });
    throw e;
  }
}

export async function setBudget(scope, campaignRow, dailyBudget, { userId = null } = {}) {
  const cfg = await integrationsService.getMarketplaceConfig('wildberries', scope);
  const token = readAdvertToken(cfg);
  if (!token) {
    const err = new Error('Нет токена WB Advert');
    err.statusCode = 400;
    throw err;
  }
  const id = campaignRow.external_id;
  const sum = Math.round(Number(dailyBudget));
  try {
    await wbFetch(token, `/adv/v1/budget/deposit?id=${encodeURIComponent(id)}`, {
      method: 'POST',
      body: { sum, type: 1, return: true },
    });
    await query(
      `UPDATE ads_campaigns SET daily_budget = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [campaignRow.id, sum]
    );
    await logAction({
      scope,
      marketplace: MARKETPLACE,
      campaignId: campaignRow.id,
      userId,
      action: 'set_budget',
      payload: { dailyBudget: sum },
      result: { ok: true },
      ok: true,
    });
    return { ok: true, dailyBudget: sum };
  } catch (e) {
    await logAction({
      scope,
      marketplace: MARKETPLACE,
      campaignId: campaignRow?.id ?? null,
      userId,
      action: 'set_budget',
      payload: { dailyBudget: sum },
      ok: false,
      errorMessage: e?.message || String(e),
    });
    throw e;
  }
}

export default {
  marketplace: MARKETPLACE,
  testConnection,
  syncStats,
  syncMembership,
  listCampaignsFromDb,
  setCampaignStatus,
  setBid,
  setBudget,
};
