/**
 * Facade: реклама Ozon / WB / YM.
 */

import { query } from '../../config/database.js';
import logger from '../../utils/logger.js';
import {
  ADS_MARKETPLACES,
  normalizeAdsPercent,
  normalizeMarketplace,
  computeDrrPercent,
} from '../../utils/adsDrr.js';
import { getAdsStatsForSku, resolveScope } from './adsStore.js';
import ozonAdapter from './ozonAds.adapter.js';
import wbAdapter from './wbAds.adapter.js';
import yandexAdapter from './yandexAds.adapter.js';

const adapters = {
  ozon: ozonAdapter,
  wildberries: wbAdapter,
  yandex: yandexAdapter,
};

function getAdapter(marketplace) {
  const mp = normalizeMarketplace(marketplace);
  if (!mp || !adapters[mp]) {
    const err = new Error(`Неизвестный маркетплейс: ${marketplace}`);
    err.statusCode = 400;
    throw err;
  }
  return { mp, adapter: adapters[mp] };
}

function scopeFromReq(options = {}) {
  return {
    profileId: options.profileId ?? options.profile_id ?? null,
    organizationId: options.organizationId ?? options.organization_id ?? null,
  };
}

export async function testConnection(marketplace, options = {}) {
  const { adapter } = getAdapter(marketplace);
  return adapter.testConnection(scopeFromReq(options));
}

export async function syncStats(marketplace, options = {}) {
  const { mp, adapter } = getAdapter(marketplace);
  const days = Math.max(1, Math.min(Number(options.days) || 14, 62));
  logger.info('[Ads] syncStats', { marketplace: mp, days, ...scopeFromReq(options) });
  return adapter.syncStats(scopeFromReq(options), { days });
}

export async function syncMembership(marketplace, options = {}) {
  const { adapter } = getAdapter(marketplace);
  return adapter.syncMembership(scopeFromReq(options));
}

export async function syncAll(options = {}) {
  const days = Math.max(1, Math.min(Number(options.days) || 14, 62));
  const marketplaces = options.marketplace
    ? [normalizeMarketplace(options.marketplace)].filter(Boolean)
    : ADS_MARKETPLACES;
  const results = {};
  for (const mp of marketplaces) {
    try {
      results[mp] = await syncStats(mp, { ...options, days });
    } catch (e) {
      results[mp] = { ok: false, error: e?.message || String(e) };
      logger.warn('[Ads] syncAll failed', { mp, message: e?.message || String(e) });
    }
  }
  return { ok: true, days, results };
}

export async function syncAllConfiguredProfiles({ days = 14, kind = 'stats' } = {}) {
  let cabinets = { rows: [] };
  try {
    cabinets = await query(
      `SELECT mc.organization_id, mc.marketplace_type, o.profile_id
       FROM marketplace_cabinets mc
       LEFT JOIN organizations o ON o.id = mc.organization_id
       WHERE (mc.is_active IS NULL OR mc.is_active = true)
         AND mc.marketplace_type IN ('ozon', 'wildberries', 'yandex')`
    );
  } catch (e) {
    logger.warn('[Ads] cabinets query failed', { message: e?.message || String(e) });
  }

  const seen = new Set();
  const results = [];
  for (const row of cabinets.rows || []) {
    const mp = normalizeMarketplace(row.marketplace_type);
    if (!mp) continue;
    const scope = {
      profileId: row.profile_id ?? null,
      organizationId: row.organization_id ?? null,
    };
    const key = `${mp}|${scope.profileId}|${scope.organizationId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const out =
        kind === 'membership'
          ? await syncMembership(mp, scope)
          : await syncStats(mp, { ...scope, days });
      results.push({ marketplace: mp, ...scope, ...out });
    } catch (e) {
      results.push({
        marketplace: mp,
        ...scope,
        ok: false,
        error: e?.message || String(e),
      });
    }
  }
  return { processed: results.length, results };
}

export async function getDashboard(options = {}) {
  const scope = resolveScope(scopeFromReq(options));
  const mpFilter = normalizeMarketplace(options.marketplace);
  const days = Math.max(1, Math.min(Number(options.days) || 14, 90));
  const params = [scope.profileId, scope.scopeKey];
  let mpSql = '';
  let mpSqlS = '';
  if (mpFilter) {
    params.push(mpFilter);
    mpSql = ` AND marketplace = $${params.length}`;
    // В JOIN с product_skus колонка marketplace неоднозначна — только alias s.
    mpSqlS = ` AND s.marketplace = $${params.length}`;
  }

  const kpi = await query(
    `SELECT marketplace,
            COUNT(*)::int AS skus,
            COALESCE(SUM(spend),0)::float AS spend,
            COALESCE(SUM(revenue),0)::float AS revenue,
            COALESCE(SUM(clicks),0)::bigint AS clicks,
            COALESCE(SUM(views),0)::bigint AS views,
            COALESCE(SUM(orders),0)::bigint AS orders,
            COUNT(*) FILTER (WHERE in_active_campaign IS TRUE)::int AS active_skus
     FROM ads_sku_stats
     WHERE (profile_id = $1 OR scope_key = $2 OR scope_key LIKE ($1::text || ':%'))
       ${mpSql}
     GROUP BY marketplace
     ORDER BY marketplace`,
    params
  );

  const skus = await query(
    `SELECT s.marketplace, s.sku_key, s.spend, s.revenue, s.drr_percent,
            s.views, s.clicks, s.orders, s.in_active_campaign, s.updated_at,
            p.id AS product_id, p.name AS product_name, p.sku AS erp_sku
     FROM ads_sku_stats s
     LEFT JOIN product_skus ps
       ON (
         (s.marketplace = 'ozon' AND ps.marketplace = 'ozon' AND (
            TRIM(COALESCE(ps.marketplace_product_id::text,'')) = s.sku_key
            OR TRIM(COALESCE(ps.mp_extra->>'ozon_sku','')) = s.sku_key
            OR TRIM(COALESCE(ps.mp_extra->>'sku','')) = s.sku_key
         ))
         OR (s.marketplace = 'wildberries' AND ps.marketplace IN ('wb','wildberries') AND (
            TRIM(COALESCE(ps.marketplace_product_id::text,'')) = s.sku_key
            OR TRIM(COALESCE(ps.mp_extra->>'nm_id','')) = s.sku_key
            OR TRIM(COALESCE(ps.mp_extra->>'nmId','')) = s.sku_key
         ))
         OR (s.marketplace = 'yandex' AND ps.marketplace IN ('ym','yandex') AND (
            TRIM(COALESCE(ps.marketplace_product_id::text,'')) = s.sku_key
            OR TRIM(COALESCE(ps.mp_extra->>'offer_id','')) = s.sku_key
         ))
       )
     LEFT JOIN products p ON p.id = ps.product_id
       AND (p.profile_id IS NULL OR p.profile_id = $1)
     WHERE (s.profile_id = $1 OR s.scope_key = $2 OR s.scope_key LIKE ($1::text || ':%'))
       ${mpSqlS}
     ORDER BY s.spend DESC NULLS LAST, s.drr_percent DESC NULLS LAST
     LIMIT 500`,
    params
  );

  const syncRuns = await query(
    `SELECT id, marketplace, kind, status, days, message, started_at, finished_at, meta
     FROM ads_sync_runs
     WHERE profile_id = $1 OR scope_key = $2
     ORDER BY started_at DESC
     LIMIT 20`,
    [scope.profileId, scope.scopeKey]
  );

  const totals = (kpi.rows || []).reduce(
    (acc, r) => {
      acc.spend += Number(r.spend) || 0;
      acc.revenue += Number(r.revenue) || 0;
      acc.skus += Number(r.skus) || 0;
      acc.activeSkus += Number(r.active_skus) || 0;
      return acc;
    },
    { spend: 0, revenue: 0, skus: 0, activeSkus: 0 }
  );
  totals.drrPercent = computeDrrPercent(totals.spend, totals.revenue);

  return {
    days,
    marketplace: mpFilter,
    totals,
    byMarketplace: (kpi.rows || []).map((r) => ({
      marketplace: r.marketplace,
      skus: Number(r.skus) || 0,
      spend: Number(r.spend) || 0,
      revenue: Number(r.revenue) || 0,
      clicks: Number(r.clicks) || 0,
      views: Number(r.views) || 0,
      orders: Number(r.orders) || 0,
      activeSkus: Number(r.active_skus) || 0,
      drrPercent: computeDrrPercent(r.spend, r.revenue),
    })),
    skus: (skus.rows || []).map((r) => ({
      marketplace: r.marketplace,
      skuKey: r.sku_key,
      spend: Number(r.spend) || 0,
      revenue: Number(r.revenue) || 0,
      drrPercent: normalizeAdsPercent(r.drr_percent),
      views: Number(r.views) || 0,
      clicks: Number(r.clicks) || 0,
      orders: Number(r.orders) || 0,
      inActiveCampaign: r.in_active_campaign,
      updatedAt: r.updated_at,
      productId: r.product_id != null ? Number(r.product_id) : null,
      productName: r.product_name || null,
      erpSku: r.erp_sku || null,
    })),
    syncRuns: syncRuns.rows || [],
  };
}

export async function listCampaigns(options = {}) {
  const scope = resolveScope(scopeFromReq(options));
  const mpFilter = normalizeMarketplace(options.marketplace);
  const params = [scope.profileId, scope.scopeKey];
  let mpSql = '';
  if (mpFilter) {
    params.push(mpFilter);
    mpSql = ` AND c.marketplace = $${params.length}`;
  }
  const r = await query(
    `SELECT c.*,
            (SELECT COUNT(*)::int FROM ads_campaign_products p WHERE p.campaign_id = c.id) AS products_count
     FROM ads_campaigns c
     WHERE (c.profile_id = $1 OR c.scope_key = $2 OR c.scope_key LIKE ($1::text || ':%'))
       ${mpSql}
     ORDER BY c.updated_at DESC
     LIMIT 500`,
    params
  );
  return (r.rows || []).map((row) => ({
    id: Number(row.id),
    marketplace: row.marketplace,
    externalId: row.external_id,
    name: row.name,
    status: row.status,
    campaignType: row.campaign_type,
    dailyBudget: row.daily_budget != null ? Number(row.daily_budget) : null,
    bid: row.bid != null ? Number(row.bid) : null,
    productsCount: Number(row.products_count) || 0,
    syncedAt: row.synced_at,
    updatedAt: row.updated_at,
  }));
}

export async function getCampaign(campaignId, options = {}) {
  const scope = resolveScope(scopeFromReq(options));
  const id = Number(campaignId);
  const r = await query(`SELECT * FROM ads_campaigns WHERE id = $1 LIMIT 1`, [id]);
  const row = r.rows?.[0];
  if (!row) {
    const err = new Error('Кампания не найдена');
    err.statusCode = 404;
    throw err;
  }
  if (
    scope.profileId &&
    row.profile_id != null &&
    Number(row.profile_id) !== Number(scope.profileId)
  ) {
    const err = new Error('Кампания другого профиля');
    err.statusCode = 403;
    throw err;
  }
  const products = await query(
    `SELECT * FROM ads_campaign_products WHERE campaign_id = $1 ORDER BY spend DESC NULLS LAST LIMIT 1000`,
    [id]
  );
  return {
    id: Number(row.id),
    marketplace: row.marketplace,
    externalId: row.external_id,
    name: row.name,
    status: row.status,
    campaignType: row.campaign_type,
    dailyBudget: row.daily_budget != null ? Number(row.daily_budget) : null,
    bid: row.bid != null ? Number(row.bid) : null,
    raw: row.raw,
    products: (products.rows || []).map((p) => ({
      id: Number(p.id),
      skuKey: p.sku_key,
      externalProductId: p.external_product_id,
      bid: p.bid != null ? Number(p.bid) : null,
      status: p.status,
      inActive: p.in_active,
      spend: Number(p.spend) || 0,
      revenue: Number(p.revenue) || 0,
      drrPercent: normalizeAdsPercent(p.drr_percent),
    })),
  };
}

async function loadCampaignRow(campaignId, options = {}) {
  const camp = await getCampaign(campaignId, options);
  const r = await query(`SELECT * FROM ads_campaigns WHERE id = $1`, [Number(campaignId)]);
  return { camp, row: r.rows[0] };
}

export async function patchCampaign(campaignId, body = {}, options = {}) {
  const { row } = await loadCampaignRow(campaignId, options);
  const { mp, adapter } = getAdapter(row.marketplace);
  const scope = scopeFromReq(options);
  const userId = options.userId ?? null;

  if (body.status != null) {
    const st = String(body.status).toLowerCase();
    const normalized =
      st === 'pause' || st === 'paused' || st === 'stop' ? 'pause' : 'resume';
    return adapter.setCampaignStatus(scope, row, normalized, { userId });
  }
  if (body.dailyBudget != null || body.daily_budget != null) {
    const budget = body.dailyBudget ?? body.daily_budget;
    return adapter.setBudget(scope, row, budget, { userId });
  }
  if (body.bid != null && (body.skuKey || body.sku_key)) {
    return adapter.setBid(
      scope,
      row,
      { skuKey: body.skuKey || body.sku_key, bid: body.bid },
      { userId }
    );
  }
  const err = new Error('Укажите status, dailyBudget или bid+skuKey');
  err.statusCode = 400;
  throw err;
}

export async function patchCampaignProduct(campaignId, productId, body = {}, options = {}) {
  const { row } = await loadCampaignRow(campaignId, options);
  const { adapter } = getAdapter(row.marketplace);
  const pr = await query(
    `SELECT * FROM ads_campaign_products WHERE id = $1 AND campaign_id = $2`,
    [Number(productId), Number(campaignId)]
  );
  const prod = pr.rows?.[0];
  if (!prod) {
    const err = new Error('Товар кампании не найден');
    err.statusCode = 404;
    throw err;
  }
  if (body.bid != null) {
    return adapter.setBid(
      scopeFromReq(options),
      row,
      { skuKey: prod.sku_key, bid: body.bid },
      { userId: options.userId ?? null }
    );
  }
  const err = new Error('Укажите bid');
  err.statusCode = 400;
  throw err;
}

export async function listActionLog(options = {}) {
  const scope = resolveScope(scopeFromReq(options));
  const r = await query(
    `SELECT * FROM ads_action_log
     WHERE profile_id = $1 OR scope_key = $2
     ORDER BY created_at DESC
     LIMIT 100`,
    [scope.profileId, scope.scopeKey]
  );
  return r.rows || [];
}

/**
 * ДРР для калькулятора мин. цены (единая таблица).
 */
export async function getStatsForSku(marketplace, skuKey, scope = {}) {
  const mp = normalizeMarketplace(marketplace);
  if (!mp) return null;
  return getAdsStatsForSku(mp, skuKey, scope);
}

export async function listHighDrrProducts({
  profileId,
  highDrrPercent,
  organizationId = null,
  marketplace = null,
} = {}) {
  const pid = Number(profileId);
  const threshold = Number(highDrrPercent);
  if (!Number.isFinite(pid) || pid < 1 || !Number.isFinite(threshold) || threshold <= 0) {
    return [];
  }
  const mp = normalizeMarketplace(marketplace);
  const params = [threshold, pid];
  let mpSql = '';
  if (mp) {
    params.push(mp);
    mpSql = ` AND s.marketplace = $${params.length}`;
  }
  try {
    const r = await query(
      `SELECT DISTINCT ON (p.id, s.marketplace)
          p.id AS product_id,
          p.sku AS erp_sku,
          p.name AS product_name,
          s.sku_key,
          s.marketplace,
          s.drr_percent,
          s.spend,
          s.revenue
       FROM ads_sku_stats s
       INNER JOIN product_skus ps
         ON (
           (s.marketplace = 'ozon' AND ps.marketplace = 'ozon' AND (
              TRIM(COALESCE(ps.marketplace_product_id::text,'')) = s.sku_key
              OR TRIM(COALESCE(ps.mp_extra->>'ozon_sku','')) = s.sku_key
           ))
           OR (s.marketplace = 'wildberries' AND ps.marketplace IN ('wb','wildberries') AND (
              TRIM(COALESCE(ps.marketplace_product_id::text,'')) = s.sku_key
              OR TRIM(COALESCE(ps.mp_extra->>'nm_id','')) = s.sku_key
           ))
           OR (s.marketplace = 'yandex' AND ps.marketplace IN ('ym','yandex') AND (
              TRIM(COALESCE(ps.marketplace_product_id::text,'')) = s.sku_key
           ))
         )
       INNER JOIN products p ON p.id = ps.product_id
       WHERE s.in_active_campaign IS TRUE
         AND s.drr_percent IS NOT NULL
         AND s.drr_percent > $1
         AND (s.profile_id = $2 OR s.scope_key LIKE ($2::text || ':%'))
         AND (p.profile_id IS NULL OR p.profile_id = $2)
         ${mpSql}
       ORDER BY p.id, s.marketplace, s.drr_percent DESC`,
      params
    );
    return (r.rows || []).map((row) => ({
      productId: Number(row.product_id),
      sku: row.sku_key || null,
      erpSku: row.erp_sku || null,
      productName: row.product_name || null,
      drrPercent: normalizeAdsPercent(row.drr_percent),
      spend: Number(row.spend) || 0,
      revenue: Number(row.revenue) || 0,
      marketplace: row.marketplace,
    }));
  } catch (e) {
    if (String(e.message || '').includes('ads_sku_stats')) return [];
    logger.warn('[Ads] listHighDrrProducts failed', { message: e?.message || String(e) });
    return [];
  }
}

export default {
  testConnection,
  syncStats,
  syncMembership,
  syncAll,
  syncAllConfiguredProfiles,
  getDashboard,
  listCampaigns,
  getCampaign,
  patchCampaign,
  patchCampaignProduct,
  listActionLog,
  getStatsForSku,
  listHighDrrProducts,
};
