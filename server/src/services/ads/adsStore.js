/**
 * Persist / query helpers for unified ads_* tables.
 */

import { query } from '../../config/database.js';
import {
  adsScopeKey,
  computeDrrPercent,
  normalizeAdsPercent,
  normalizeSkuKey,
} from '../../utils/adsDrr.js';

export function resolveScope(scope = {}) {
  const profileId =
    scope.profileId != null && scope.profileId !== ''
      ? Number(scope.profileId)
      : scope.profile_id != null && scope.profile_id !== ''
        ? Number(scope.profile_id)
        : null;
  const organizationId =
    scope.organizationId != null && scope.organizationId !== ''
      ? Number(scope.organizationId)
      : scope.organization_id != null && scope.organization_id !== ''
        ? Number(scope.organization_id)
        : null;
  const pid = Number.isFinite(profileId) ? profileId : null;
  const oid = Number.isFinite(organizationId) ? organizationId : null;
  return {
    profileId: pid,
    organizationId: oid,
    scopeKey: adsScopeKey(pid, oid),
  };
}

export async function startSyncRun({
  scope,
  marketplace = null,
  kind = 'stats',
  days = null,
} = {}) {
  const { scopeKey, profileId, organizationId } = resolveScope(scope);
  try {
    const r = await query(
      `INSERT INTO ads_sync_runs (scope_key, profile_id, organization_id, marketplace, kind, status, days)
       VALUES ($1, $2, $3, $4, $5, 'running', $6)
       RETURNING id`,
      [scopeKey, profileId, organizationId, marketplace, kind, days]
    );
    return r.rows?.[0]?.id ?? null;
  } catch {
    return null;
  }
}

export async function finishSyncRun(runId, { status = 'ok', message = null, meta = {} } = {}) {
  if (!runId) return;
  try {
    await query(
      `UPDATE ads_sync_runs
       SET status = $2, message = $3, meta = $4::jsonb, finished_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [runId, status, message, JSON.stringify(meta || {})]
    );
  } catch {
    /* ignore */
  }
}

export async function upsertCampaign(scope, marketplace, campaign) {
  const { scopeKey, profileId, organizationId } = resolveScope(scope);
  const externalId = String(campaign.externalId ?? campaign.id ?? '').trim();
  if (!externalId) return null;
  const r = await query(
    `INSERT INTO ads_campaigns (
       scope_key, profile_id, organization_id, marketplace, external_id,
       name, status, campaign_type, daily_budget, bid, raw, synced_at, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT (scope_key, marketplace, external_id) DO UPDATE SET
       name = EXCLUDED.name,
       status = EXCLUDED.status,
       campaign_type = COALESCE(EXCLUDED.campaign_type, ads_campaigns.campaign_type),
       daily_budget = COALESCE(EXCLUDED.daily_budget, ads_campaigns.daily_budget),
       bid = COALESCE(EXCLUDED.bid, ads_campaigns.bid),
       raw = EXCLUDED.raw,
       synced_at = CURRENT_TIMESTAMP,
       updated_at = CURRENT_TIMESTAMP,
       profile_id = COALESCE(EXCLUDED.profile_id, ads_campaigns.profile_id),
       organization_id = COALESCE(EXCLUDED.organization_id, ads_campaigns.organization_id)
     RETURNING id`,
    [
      scopeKey,
      profileId,
      organizationId,
      marketplace,
      externalId,
      campaign.name ?? null,
      campaign.status ?? null,
      campaign.campaignType ?? campaign.type ?? null,
      campaign.dailyBudget ?? null,
      campaign.bid ?? null,
      JSON.stringify(campaign.raw ?? campaign),
    ]
  );
  return r.rows?.[0]?.id ?? null;
}

export async function upsertCampaignProduct(campaignId, product) {
  const skuKey = normalizeSkuKey(product.skuKey ?? product.sku ?? product.offerId);
  if (!campaignId || !skuKey) return;
  const drr =
    product.drrPercent != null
      ? normalizeAdsPercent(product.drrPercent)
      : computeDrrPercent(product.spend, product.revenue);
  await query(
    `INSERT INTO ads_campaign_products (
       campaign_id, sku_key, external_product_id, bid, status, in_active,
       spend, revenue, drr_percent, raw, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb, CURRENT_TIMESTAMP)
     ON CONFLICT (campaign_id, sku_key) DO UPDATE SET
       external_product_id = COALESCE(EXCLUDED.external_product_id, ads_campaign_products.external_product_id),
       bid = COALESCE(EXCLUDED.bid, ads_campaign_products.bid),
       status = COALESCE(EXCLUDED.status, ads_campaign_products.status),
       in_active = COALESCE(EXCLUDED.in_active, ads_campaign_products.in_active),
       spend = EXCLUDED.spend,
       revenue = EXCLUDED.revenue,
       drr_percent = EXCLUDED.drr_percent,
       raw = EXCLUDED.raw,
       updated_at = CURRENT_TIMESTAMP`,
    [
      campaignId,
      skuKey,
      product.externalProductId ?? null,
      product.bid ?? null,
      product.status ?? null,
      product.inActive ?? null,
      Number(product.spend) || 0,
      Number(product.revenue) || 0,
      drr,
      JSON.stringify(product.raw ?? {}),
    ]
  );
}

export async function upsertSkuStats(scope, marketplace, row) {
  const { scopeKey, profileId, organizationId } = resolveScope(scope);
  const skuKey = normalizeSkuKey(row.skuKey ?? row.offerId ?? row.sku);
  if (!skuKey) return;
  const spend = Number(row.spend) || 0;
  const revenue = Number(row.revenue) || 0;
  const drr =
    row.drrPercent != null
      ? normalizeAdsPercent(row.drrPercent)
      : computeDrrPercent(spend, revenue);
  await query(
    `INSERT INTO ads_sku_stats (
       scope_key, profile_id, organization_id, marketplace, sku_key,
       spend, revenue, views, clicks, orders, drr_percent,
       in_active_campaign, period_from, period_to, campaign_synced_at, source, updated_at
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
       COALESCE($15::timestamptz, CURRENT_TIMESTAMP), $16, CURRENT_TIMESTAMP
     )
     ON CONFLICT (scope_key, marketplace, sku_key) DO UPDATE SET
       spend = EXCLUDED.spend,
       revenue = EXCLUDED.revenue,
       views = EXCLUDED.views,
       clicks = EXCLUDED.clicks,
       orders = EXCLUDED.orders,
       drr_percent = EXCLUDED.drr_percent,
       in_active_campaign = COALESCE(EXCLUDED.in_active_campaign, ads_sku_stats.in_active_campaign),
       period_from = COALESCE(EXCLUDED.period_from, ads_sku_stats.period_from),
       period_to = COALESCE(EXCLUDED.period_to, ads_sku_stats.period_to),
       campaign_synced_at = COALESCE(EXCLUDED.campaign_synced_at, ads_sku_stats.campaign_synced_at),
       source = EXCLUDED.source,
       updated_at = CURRENT_TIMESTAMP,
       profile_id = COALESCE(EXCLUDED.profile_id, ads_sku_stats.profile_id),
       organization_id = COALESCE(EXCLUDED.organization_id, ads_sku_stats.organization_id)`,
    [
      scopeKey,
      profileId,
      organizationId,
      marketplace,
      skuKey,
      spend,
      revenue,
      Number(row.views) || 0,
      Number(row.clicks) || 0,
      Number(row.orders) || 0,
      drr,
      row.inActiveCampaign ?? null,
      row.periodFrom ?? null,
      row.periodTo ?? null,
      row.campaignSyncedAt ?? null,
      row.source || 'api',
    ]
  );
}

export async function markActiveMembership(scope, marketplace, activeSkuKeys) {
  const { scopeKey, profileId } = resolveScope(scope);
  const set = new Set(
    (activeSkuKeys || []).map((k) => normalizeSkuKey(k)).filter(Boolean)
  );
  await query(
    `UPDATE ads_sku_stats
     SET in_active_campaign = false,
         campaign_synced_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
     WHERE marketplace = $1
       AND (
         scope_key = $2
         OR ($3::int IS NOT NULL AND profile_id = $3)
       )`,
    [marketplace, scopeKey, profileId]
  );
  if (!set.size) return { marked: 0 };
  const keys = [...set];
  await query(
    `UPDATE ads_sku_stats
     SET in_active_campaign = true,
         campaign_synced_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
     WHERE marketplace = $1
       AND sku_key = ANY($2::text[])
       AND (
         scope_key = $3
         OR ($4::int IS NOT NULL AND profile_id = $4)
       )`,
    [marketplace, keys, scopeKey, profileId]
  );
  // Ensure rows exist for active SKUs without stats yet
  for (const skuKey of keys) {
    await query(
      `INSERT INTO ads_sku_stats (
         scope_key, profile_id, organization_id, marketplace, sku_key,
         in_active_campaign, campaign_synced_at, source, updated_at
       ) VALUES ($1,$2,$3,$4,$5,true,CURRENT_TIMESTAMP,'membership',CURRENT_TIMESTAMP)
       ON CONFLICT (scope_key, marketplace, sku_key) DO UPDATE SET
         in_active_campaign = true,
         campaign_synced_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP`,
      [
        scopeKey,
        resolveScope(scope).profileId,
        resolveScope(scope).organizationId,
        marketplace,
        skuKey,
      ]
    );
  }
  return { marked: keys.length };
}

export async function upsertDailyStats(scope, marketplace, rows) {
  const { scopeKey, profileId, organizationId } = resolveScope(scope);
  let n = 0;
  for (const row of rows || []) {
    const skuKey = normalizeSkuKey(row.skuKey ?? row.offerId ?? row.sku);
    const statDate = row.statDate || row.date;
    if (!skuKey || !statDate) continue;
    const spend = Number(row.spend) || 0;
    const revenue = Number(row.revenue) || 0;
    const drr =
      row.drrPercent != null
        ? normalizeAdsPercent(row.drrPercent)
        : computeDrrPercent(spend, revenue);
    await query(
      `INSERT INTO ads_sku_stats_daily (
         scope_key, profile_id, organization_id, marketplace, sku_key, stat_date,
         spend, revenue, views, clicks, orders, drr_percent, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6::date,$7,$8,$9,$10,$11,$12,CURRENT_TIMESTAMP)
       ON CONFLICT (scope_key, marketplace, sku_key, stat_date) DO UPDATE SET
         spend = EXCLUDED.spend,
         revenue = EXCLUDED.revenue,
         views = EXCLUDED.views,
         clicks = EXCLUDED.clicks,
         orders = EXCLUDED.orders,
         drr_percent = EXCLUDED.drr_percent,
         updated_at = CURRENT_TIMESTAMP`,
      [
        scopeKey,
        profileId,
        organizationId,
        marketplace,
        skuKey,
        statDate,
        spend,
        revenue,
        Number(row.views) || 0,
        Number(row.clicks) || 0,
        Number(row.orders) || 0,
        drr,
      ]
    );
    n += 1;
  }
  return n;
}

export async function logAction({
  scope,
  marketplace,
  campaignId = null,
  userId = null,
  action,
  payload = {},
  result = {},
  ok = false,
  errorMessage = null,
}) {
  const { scopeKey, profileId, organizationId } = resolveScope(scope);
  try {
    await query(
      `INSERT INTO ads_action_log (
         scope_key, profile_id, organization_id, marketplace, campaign_id,
         user_id, action, payload, result, ok, error_message
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11)`,
      [
        scopeKey,
        profileId,
        organizationId,
        marketplace,
        campaignId,
        userId,
        action,
        JSON.stringify(payload || {}),
        JSON.stringify(result || {}),
        !!ok,
        errorMessage,
      ]
    );
  } catch {
    /* ignore */
  }
}

export async function getAdsStatsForSku(marketplace, skuKey, scope = {}) {
  const oid = normalizeSkuKey(skuKey);
  if (!oid) return null;
  const { scopeKey, profileId } = resolveScope(scope);
  try {
    const r = await query(
      `SELECT drr_percent, spend, revenue, views, clicks, orders,
              in_active_campaign, updated_at, campaign_synced_at
       FROM ads_sku_stats
       WHERE marketplace = $1
         AND sku_key = $2
         AND (
           scope_key = $3
           OR ($4::int IS NOT NULL AND profile_id = $4)
           OR scope_key = '0:0'
         )
       ORDER BY
         CASE WHEN scope_key = $3 THEN 0
              WHEN $4::int IS NOT NULL AND profile_id = $4 THEN 1
              ELSE 2 END,
         updated_at DESC
       LIMIT 1`,
      [marketplace, oid, scopeKey, profileId]
    );
    const row = r.rows?.[0];
    if (!row) return null;
    let drrPercent = null;
    if (row.drr_percent != null && !Number.isNaN(Number(row.drr_percent))) {
      drrPercent = normalizeAdsPercent(row.drr_percent);
    } else {
      drrPercent = computeDrrPercent(row.spend, row.revenue);
    }
    return {
      drrPercent,
      spend: Number(row.spend) || 0,
      revenue: Number(row.revenue) || 0,
      views: Number(row.views) || 0,
      clicks: Number(row.clicks) || 0,
      orders: Number(row.orders) || 0,
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
    if (String(e.message || '').includes('ads_sku_stats')) return null;
    throw e;
  }
}
