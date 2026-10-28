/**
 * Ozon Performance → unified ads_* + legacy ozon_ads_sku_stats.
 */

import integrationsService from '../integrations.service.js';
import ozonPerformanceAdsService from '../ozonPerformanceAds.service.js';
import logger from '../../utils/logger.js';
import { formatYmd, normalizeSkuKey } from '../../utils/adsDrr.js';
import {
  finishSyncRun,
  markActiveMembership,
  resolveScope,
  startSyncRun,
  upsertCampaign,
  upsertCampaignProduct,
  upsertSkuStats,
  logAction,
} from './adsStore.js';
import { query } from '../../config/database.js';

const MARKETPLACE = 'ozon';

function readCreds(config) {
  if (!config || typeof config !== 'object') return null;
  const clientId = String(
    config.performance_client_id ??
      config.performanceClientId ??
      config.ads_client_id ??
      ''
  ).trim();
  const clientSecret = String(
    config.performance_client_secret ??
      config.performanceClientSecret ??
      config.ads_client_secret ??
      ''
  ).trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

async function mirrorFromLegacy(scope, days = 14) {
  const { scopeKey, profileId, organizationId } = resolveScope(scope);
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - Math.max(1, Number(days) || 14));
  const periodFrom = formatYmd(from);
  const periodTo = formatYmd(to);

  let rows = [];
  try {
    const r = await query(
      `SELECT offer_id, spend, revenue, drr_percent, in_active_campaign,
              period_from, period_to, campaign_synced_at
       FROM ozon_ads_sku_stats
       WHERE scope_key = $1
          OR ($2::int IS NOT NULL AND profile_id = $2)
       ORDER BY updated_at DESC
       LIMIT 20000`,
      [scopeKey, profileId]
    );
    rows = r.rows || [];
  } catch (e) {
    logger.warn('[Ads Ozon] mirror legacy failed', { message: e?.message || String(e) });
    return { mirrored: 0 };
  }

  let mirrored = 0;
  for (const row of rows) {
    const skuKey = normalizeSkuKey(row.offer_id);
    if (!skuKey) continue;
    await upsertSkuStats(scope, MARKETPLACE, {
      skuKey,
      spend: row.spend,
      revenue: row.revenue,
      drrPercent: row.drr_percent,
      inActiveCampaign: row.in_active_campaign,
      periodFrom: row.period_from || periodFrom,
      periodTo: row.period_to || periodTo,
      campaignSyncedAt: row.campaign_synced_at,
      source: 'ozon_performance',
    });
    mirrored += 1;
  }
  return { mirrored, profileId, organizationId };
}

export async function testConnection(scope = {}) {
  const cfg = await integrationsService.getMarketplaceConfig('ozon', scope);
  const creds = readCreds(cfg);
  if (!creds) {
    return { ok: false, message: 'Укажите Performance Client ID и Secret' };
  }
  try {
    const res = await ozonPerformanceAdsService.testConnection(scope);
    return {
      ok: true,
      message: `Ozon Performance: OK, кампаний: ${res?.campaigns ?? 0}`,
      ...res,
    };
  } catch (e) {
    return { ok: false, message: e?.message || 'Ошибка Performance API' };
  }
}

export async function syncStats(scope = {}, { days = 14 } = {}) {
  const runId = await startSyncRun({ scope, marketplace: MARKETPLACE, kind: 'stats', days });
  try {
    const legacy = await ozonPerformanceAdsService.syncAdsStats(scope, { days });
    const mirror = await mirrorFromLegacy(scope, days);

    // Pull campaign list into ads_campaigns if Performance exposes them via DB/API side effects
    try {
      const cfg = await integrationsService.getMarketplaceConfig('ozon', scope);
      if (readCreds(cfg)) {
        // Best-effort: re-read membership offers into campaign_products placeholders
        const active = await query(
          `SELECT offer_id FROM ozon_ads_sku_stats
           WHERE in_active_campaign IS TRUE
             AND (scope_key = $1 OR profile_id = $2)
           LIMIT 5000`,
          [resolveScope(scope).scopeKey, resolveScope(scope).profileId]
        );
        const campId = await upsertCampaign(scope, MARKETPLACE, {
          externalId: 'active-delivery',
          name: 'Активная отдача (агрегат)',
          status: 'RUNNING',
          campaignType: 'aggregate',
          raw: { source: 'membership' },
        });
        if (campId) {
          for (const row of active.rows || []) {
            await upsertCampaignProduct(campId, {
              skuKey: row.offer_id,
              inActive: true,
            });
          }
        }
        await markActiveMembership(
          scope,
          MARKETPLACE,
          (active.rows || []).map((r) => r.offer_id)
        );
      }
    } catch (e) {
      logger.warn('[Ads Ozon] campaign mirror failed', { message: e?.message || String(e) });
    }

    const result = { ok: true, marketplace: MARKETPLACE, legacy, ...mirror };
    await finishSyncRun(runId, { status: 'ok', meta: result });
    return result;
  } catch (e) {
    await finishSyncRun(runId, { status: 'error', message: e?.message || String(e) });
    throw e;
  }
}

export async function syncMembership(scope = {}) {
  const runId = await startSyncRun({ scope, marketplace: MARKETPLACE, kind: 'membership' });
  try {
    // Полный syncAdsStats обновляет и membership; лёгкий путь — mirror после точечного sync
    const legacy = await ozonPerformanceAdsService.syncAdsStats(scope, { days: 1 });
    const mirror = await mirrorFromLegacy(scope, 14);
    const result = { ok: true, membership: legacy?.membership || null, ...mirror };
    await finishSyncRun(runId, { status: 'ok', meta: result });
    return result;
  } catch (e) {
    try {
      const mirror = await mirrorFromLegacy(scope, 14);
      await finishSyncRun(runId, { status: 'ok', meta: { fallback: true, ...mirror } });
      return { ok: true, fallback: true, ...mirror };
    } catch {
      await finishSyncRun(runId, { status: 'error', message: e?.message || String(e) });
      throw e;
    }
  }
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
    errorMessage:
      'Управление статусом кампаний Ozon Performance через API ограничено — используйте кабинет Performance',
  });
  const err = new Error(
    'Пауза/старт кампаний Ozon Performance пока доступны в рекламном кабинете Ozon'
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
    errorMessage: 'Изменение ставок Ozon через ERP пока не поддерживается Performance API',
  });
  const err = new Error('Изменение ставок Ozon пока доступно в рекламном кабинете');
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
    errorMessage: 'Изменение бюджета Ozon через ERP пока не поддерживается',
  });
  const err = new Error('Изменение бюджета Ozon пока доступно в рекламном кабинете');
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
