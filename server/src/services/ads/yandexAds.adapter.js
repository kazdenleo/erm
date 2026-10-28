/**
 * Яндекс.Маркет — реклама / буст (Partner + ads_token).
 * При отсутствии стабильного Advertising API: синк кредов + ручной fallback %.
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
  upsertSkuStats,
} from './adsStore.js';
import { query } from '../../config/database.js';

const MARKETPLACE = 'yandex';
const PARTNER_BASE = 'https://api.partner.market.yandex.ru';

function readAdsCreds(config) {
  if (!config || typeof config !== 'object') return null;
  const adsToken = String(config.ads_token ?? config.adsToken ?? '').trim();
  const apiKey = String(config.api_key ?? config.apiKey ?? '').trim();
  const token = adsToken || apiKey;
  if (!token) return null;
  const campaignId = String(
    config.ads_campaign_id ??
      config.adsCampaignId ??
      config.campaign_id ??
      config.campaignId ??
      ''
  ).trim();
  const businessId = String(config.business_id ?? config.businessId ?? '').trim();
  const extraCampaignIds = String(config.ads_campaign_ids ?? config.adsCampaignIds ?? '')
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return { token, campaignId, businessId, extraCampaignIds, hasDedicatedAdsToken: !!adsToken };
}

async function ymFetch(token, path, { method = 'GET', body = null } = {}) {
  const url = path.startsWith('http') ? path : `${PARTNER_BASE}${path.startsWith('/') ? path : `/${path}`}`;
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
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
    const err = new Error(`YM Partner ${response.status}: ${(text || '').slice(0, 400)}`);
    err.statusCode = response.status;
    throw err;
  }
  return json ?? text;
}

export async function testConnection(scope = {}) {
  const cfg = await integrationsService.getMarketplaceConfig('yandex', scope);
  const creds = readAdsCreds(cfg);
  if (!creds) {
    return { ok: false, message: 'Укажите API Key / Ads Token Яндекс.Маркета' };
  }
  if (!creds.campaignId && !creds.extraCampaignIds.length) {
    return {
      ok: false,
      message: 'Укажите campaign_id кабинета или ads_campaign_ids для рекламы',
    };
  }
  try {
    const cid = creds.campaignId || creds.extraCampaignIds[0];
    await ymFetch(creds.token, `/campaigns/${encodeURIComponent(cid)}`);
    return {
      ok: true,
      message: creds.hasDedicatedAdsToken
        ? 'Яндекс: Ads Token принят, кабинет доступен'
        : 'Яндекс: Seller API Key принят (для рекламы лучше отдельный ads_token)',
    };
  } catch (e) {
    return { ok: false, message: e?.message || 'Ошибка Яндекс API' };
  }
}

/**
 * Попытка вытянуть статистику буста/продвижения.
 * Официальные Advertising-отчёты у МП меняются — собираем то, что доступно; иначе пишем кампании-заглушки.
 */
async function tryFetchBoostStats(creds, campaignId, dateFrom, dateTo) {
  const paths = [
    `/campaigns/${campaignId}/stats/offers?fromDate=${dateFrom}&toDate=${dateTo}`,
    `/campaigns/${campaignId}/offers/stats?fromDate=${dateFrom}&toDate=${dateTo}`,
    `/reports/boost/stats?campaignId=${campaignId}&dateFrom=${dateFrom}&dateTo=${dateTo}`,
  ];
  for (const path of paths) {
    try {
      const data = await ymFetch(creds.token, path);
      return data;
    } catch (e) {
      if (e?.statusCode === 404 || e?.statusCode === 400 || e?.statusCode === 405) continue;
      logger.warn('[Ads YM] stats path failed', { path, message: e?.message || String(e) });
    }
    await sleep(200);
  }
  return null;
}

function flattenYmOfferStats(data) {
  const rows = [];
  const lists = [
    data?.result?.offers,
    data?.offers,
    data?.result?.rows,
    data?.rows,
    Array.isArray(data) ? data : null,
  ];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const sku =
        normalizeSkuKey(item.offerId ?? item.offer_id ?? item.shopSku ?? item.shop_sku) ||
        normalizeSkuKey(item.sku);
      if (!sku) continue;
      const spend = parseMoney(
        item.spending ?? item.spend ?? item.cost ?? item.expenses ?? item.boostCost
      );
      const revenue = parseMoney(
        item.revenue ?? item.gmv ?? item.sales ?? item.orderedGoodsGmv ?? item.showsToOrder
      );
      rows.push({
        skuKey: sku,
        spend,
        revenue,
        views: Number(item.shows ?? item.views ?? 0) || 0,
        clicks: Number(item.clicks ?? 0) || 0,
        orders: Number(item.orders ?? item.orderCount ?? 0) || 0,
        drrPercent: computeDrrPercent(spend, revenue),
      });
    }
  }
  return rows;
}

export async function syncStats(scope = {}, { days = 14 } = {}) {
  const runId = await startSyncRun({ scope, marketplace: MARKETPLACE, kind: 'stats', days });
  try {
    const cfg = await integrationsService.getMarketplaceConfig('yandex', scope);
    const creds = readAdsCreds(cfg);
    if (!creds) {
      const result = { ok: false, skipped: true, reason: 'no_ym_token' };
      await finishSyncRun(runId, { status: 'skipped', meta: result });
      return result;
    }

    const campaignIds = [
      ...new Set(
        [creds.campaignId, ...creds.extraCampaignIds].filter(Boolean).map(String)
      ),
    ];
    if (!campaignIds.length) {
      const result = { ok: false, skipped: true, reason: 'no_campaign_id' };
      await finishSyncRun(runId, { status: 'skipped', meta: result });
      return result;
    }

    const to = new Date();
    to.setHours(0, 0, 0, 0);
    const from = new Date(to);
    from.setDate(from.getDate() - (Math.max(1, Math.min(Number(days) || 14, 62)) - 1));
    const dateFrom = formatYmd(from);
    const dateTo = formatYmd(to);

    let upserted = 0;
    const activeSkus = new Set();

    for (const cid of campaignIds) {
      const campDbId = await upsertCampaign(scope, MARKETPLACE, {
        externalId: cid,
        name: `YM кабинет ${cid}`,
        status: 'RUNNING',
        campaignType: 'market',
        raw: { campaignId: cid },
      });

      const statsData = await tryFetchBoostStats(creds, cid, dateFrom, dateTo);
      const rows = flattenYmOfferStats(statsData);
      if (!rows.length) {
        // Fallback: default ads % from config applied later in calculator; keep campaign row
        continue;
      }
      for (const row of rows) {
        activeSkus.add(row.skuKey);
        await upsertSkuStats(scope, MARKETPLACE, {
          ...row,
          inActiveCampaign: true,
          periodFrom: dateFrom,
          periodTo: dateTo,
          source: 'ym_partner',
        });
        if (campDbId) {
          await upsertCampaignProduct(campDbId, {
            skuKey: row.skuKey,
            spend: row.spend,
            revenue: row.revenue,
            drrPercent: row.drrPercent,
            inActive: true,
          });
        }
        upserted += 1;
      }
    }

    await markActiveMembership(scope, MARKETPLACE, [...activeSkus]);

    const result = {
      ok: true,
      marketplace: MARKETPLACE,
      campaigns: campaignIds.length,
      upserted,
      activeSkus: activeSkus.size,
      dateFrom,
      dateTo,
      note:
        upserted === 0
          ? 'Статистика рекламы YM API не вернула строк — проверьте ads_token и доступ к отчётам буста'
          : undefined,
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
  await logAction({
    scope,
    marketplace: MARKETPLACE,
    campaignId: campaignRow?.id ?? null,
    userId,
    action: status === 'pause' ? 'pause' : 'resume',
    payload: { externalId: campaignRow?.external_id },
    ok: false,
    errorMessage: 'Управление кампаниями Яндекс.Маркет через ERP пока ограничено API партнёра',
  });
  const err = new Error(
    'Пауза/старт рекламы Яндекс.Маркет пока доступны в кабинете Маркета'
  );
  err.statusCode = 501;
  throw err;
}

export async function setBid(scope, campaignRow, { skuKey, bid }, { userId = null } = {}) {
  await logAction({
    scope,
    marketplace: MARKETPLACE,
    campaignId: campaignRow?.id ?? null,
    userId,
    action: 'set_bid',
    payload: { skuKey, bid },
    ok: false,
    errorMessage: 'Ставки YM через ERP пока не поддерживаются',
  });
  const err = new Error('Изменение ставок Яндекс.Маркет пока доступно в кабинете');
  err.statusCode = 501;
  throw err;
}

export async function setBudget(scope, campaignRow, dailyBudget, { userId = null } = {}) {
  await logAction({
    scope,
    marketplace: MARKETPLACE,
    campaignId: campaignRow?.id ?? null,
    userId,
    action: 'set_budget',
    payload: { dailyBudget },
    ok: false,
    errorMessage: 'Бюджет YM через ERP пока не поддерживается',
  });
  const err = new Error('Изменение бюджета Яндекс.Маркет пока доступно в кабинете');
  err.statusCode = 501;
  throw err;
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
