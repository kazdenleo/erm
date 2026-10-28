/**
 * Автоматизация рекламы: автопауза при нулевом остатке + биддер целевого ДРР.
 */

import { query } from '../../config/database.js';
import logger from '../../utils/logger.js';
import { normalizeMarketplace } from '../../utils/adsDrr.js';
import { resolveScope } from './adsStore.js';
import adsService from './ads.service.js';

function scopeFromOptions(options = {}) {
  return {
    profileId: options.profileId ?? options.profile_id ?? null,
    organizationId: options.organizationId ?? options.organization_id ?? null,
    userId: options.userId ?? null,
  };
}

function rowToRule(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    profileId: Number(row.profile_id),
    organizationId: row.organization_id != null ? Number(row.organization_id) : null,
    marketplace: row.marketplace,
    name: row.name,
    ruleType: row.rule_type,
    enabled: row.enabled !== false,
    config: row.config && typeof row.config === 'object' ? row.config : {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listRules(options = {}) {
  const scope = resolveScope(scopeFromOptions(options));
  if (!scope.profileId) return [];
  const r = await query(
    `SELECT * FROM ads_automation_rules
     WHERE profile_id = $1
     ORDER BY id ASC`,
    [scope.profileId]
  );
  return (r.rows || []).map(rowToRule);
}

export async function createRule(body = {}, options = {}) {
  const scope = resolveScope(scopeFromOptions(options));
  if (!scope.profileId) {
    const err = new Error('Нужен профиль');
    err.statusCode = 400;
    throw err;
  }
  const ruleType = String(body.ruleType || body.rule_type || '').trim();
  if (!['zero_stock_pause', 'target_drr_bid'].includes(ruleType)) {
    const err = new Error('ruleType: zero_stock_pause | target_drr_bid');
    err.statusCode = 400;
    throw err;
  }
  const mp = body.marketplace ? normalizeMarketplace(body.marketplace) : null;
  const name = String(body.name || '').trim() || defaultName(ruleType);
  const config = body.config && typeof body.config === 'object' ? body.config : defaultConfig(ruleType);
  const r = await query(
    `INSERT INTO ads_automation_rules (
       profile_id, organization_id, marketplace, name, rule_type, enabled, config
     ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
     RETURNING *`,
    [
      scope.profileId,
      scope.organizationId,
      mp,
      name,
      ruleType,
      body.enabled !== false,
      JSON.stringify(config),
    ]
  );
  return rowToRule(r.rows[0]);
}

function defaultName(ruleType) {
  if (ruleType === 'zero_stock_pause') return 'Автопауза при нулевом остатке';
  if (ruleType === 'target_drr_bid') return 'Биддер целевого ДРР';
  return 'Правило';
}

function defaultConfig(ruleType) {
  if (ruleType === 'zero_stock_pause') {
    return { resumeOnStock: true, minStock: 1 };
  }
  return {
    targetDrrPercent: 10,
    bidStepPercent: 5,
    minBid: 50,
    maxBid: 500,
    cooldownMinutes: 60,
  };
}

export async function updateRule(id, body = {}, options = {}) {
  const scope = resolveScope(scopeFromOptions(options));
  const existing = await query(`SELECT * FROM ads_automation_rules WHERE id = $1`, [Number(id)]);
  const row = existing.rows?.[0];
  if (!row) {
    const err = new Error('Правило не найдено');
    err.statusCode = 404;
    throw err;
  }
  if (scope.profileId && Number(row.profile_id) !== Number(scope.profileId)) {
    const err = new Error('Чужое правило');
    err.statusCode = 403;
    throw err;
  }
  const name = body.name != null ? String(body.name).trim() : row.name;
  const enabled = body.enabled != null ? !!body.enabled : row.enabled !== false;
  const mp =
    body.marketplace !== undefined
      ? body.marketplace
        ? normalizeMarketplace(body.marketplace)
        : null
      : row.marketplace;
  const config =
    body.config && typeof body.config === 'object'
      ? { ...(row.config || {}), ...body.config }
      : row.config || {};
  const r = await query(
    `UPDATE ads_automation_rules
     SET name = $2, enabled = $3, marketplace = $4, config = $5::jsonb, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1
     RETURNING *`,
    [Number(id), name, enabled, mp, JSON.stringify(config)]
  );
  return rowToRule(r.rows[0]);
}

export async function deleteRule(id, options = {}) {
  const scope = resolveScope(scopeFromOptions(options));
  const existing = await query(`SELECT * FROM ads_automation_rules WHERE id = $1`, [Number(id)]);
  const row = existing.rows?.[0];
  if (!row) return { ok: true };
  if (scope.profileId && Number(row.profile_id) !== Number(scope.profileId)) {
    const err = new Error('Чужое правило');
    err.statusCode = 403;
    throw err;
  }
  await query(`DELETE FROM ads_automation_rules WHERE id = $1`, [Number(id)]);
  return { ok: true };
}

export async function listRuns(options = {}) {
  const scope = resolveScope(scopeFromOptions(options));
  if (!scope.profileId) return [];
  const r = await query(
    `SELECT * FROM ads_automation_runs
     WHERE profile_id = $1
     ORDER BY created_at DESC
     LIMIT 100`,
    [scope.profileId]
  );
  return r.rows || [];
}

async function logRun({ ruleId, profileId, marketplace, status, actionsCount, message, details }) {
  try {
    await query(
      `INSERT INTO ads_automation_runs (
         rule_id, profile_id, marketplace, status, actions_count, message, details
       ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
      [
        ruleId,
        profileId,
        marketplace,
        status,
        actionsCount || 0,
        message || null,
        JSON.stringify(details || {}),
      ]
    );
  } catch {
    /* ignore */
  }
}

/**
 * Остаток товара по ERP (склад) + marketplace stock snapshots если есть.
 */
async function loadSkuStockMap(profileId) {
  /** @type {Map<string, number>} key = `${marketplace}:${sku}` */
  const map = new Map();
  try {
    const r = await query(
      `SELECT ps.marketplace,
              TRIM(COALESCE(ps.marketplace_product_id::text,'')) AS mp_id,
              TRIM(COALESCE(ps.mp_extra->>'nm_id', ps.mp_extra->>'nmId', '')) AS nm_id,
              TRIM(COALESCE(ps.mp_extra->>'ozon_sku', ps.mp_extra->>'ozonSku', '')) AS ozon_sku,
              COALESCE(p.quantity, 0)::float AS qty
       FROM product_skus ps
       INNER JOIN products p ON p.id = ps.product_id
       WHERE p.profile_id = $1
         AND (p.is_archived IS NULL OR p.is_archived = false)`,
      [profileId]
    );
    for (const row of r.rows || []) {
      const mpRaw = String(row.marketplace || '').toLowerCase();
      const mp =
        mpRaw === 'ozon'
          ? 'ozon'
          : mpRaw === 'wb' || mpRaw === 'wildberries'
            ? 'wildberries'
            : mpRaw === 'ym' || mpRaw === 'yandex'
              ? 'yandex'
              : null;
      if (!mp) continue;
      const qty = Number(row.qty) || 0;
      for (const key of [row.mp_id, row.nm_id, row.ozon_sku]) {
        if (key) map.set(`${mp}:${key}`, qty);
      }
    }
  } catch (e) {
    logger.warn('[Ads Auto] stock map failed', { message: e?.message || String(e) });
  }
  return map;
}

async function runZeroStockPause(rule, options = {}) {
  const cfg = rule.config || {};
  const minStock = Number(cfg.minStock) >= 0 ? Number(cfg.minStock) : 1;
  const resumeOnStock = cfg.resumeOnStock !== false;
  const stockMap = await loadSkuStockMap(rule.profileId);
  const scope = {
    profileId: rule.profileId,
    organizationId: rule.organizationId,
    userId: options.userId ?? null,
  };

  const camps = await adsService.listCampaigns({
    ...scope,
    marketplace: rule.marketplace || undefined,
  });

  let actions = 0;
  const details = [];

  for (const camp of camps) {
    if (rule.marketplace && camp.marketplace !== rule.marketplace) continue;
    let full;
    try {
      full = await adsService.getCampaign(camp.id, scope);
    } catch {
      continue;
    }
    const products = full.products || [];
    if (!products.length) continue;

    let anyInStock = false;
    let allZero = products.length > 0;
    for (const p of products) {
      const qty = stockMap.get(`${camp.marketplace}:${p.skuKey}`);
      if (qty == null) {
        allZero = false;
        continue;
      }
      if (qty >= minStock) {
        anyInStock = true;
        allZero = false;
      }
    }

    const status = String(camp.status || '').toUpperCase();
    const isRunning = status === 'RUNNING' || status === 'ACTIVE' || status === '9';
    const isPaused = status === 'PAUSED' || status === '11' || status === 'PAUSE';

    try {
      if (allZero && isRunning) {
        await adsService.patchCampaign(camp.id, { status: 'pause' }, scope);
        actions += 1;
        details.push({ campaignId: camp.id, action: 'pause', reason: 'zero_stock' });
      } else if (resumeOnStock && anyInStock && isPaused) {
        await adsService.patchCampaign(camp.id, { status: 'resume' }, scope);
        actions += 1;
        details.push({ campaignId: camp.id, action: 'resume', reason: 'stock_available' });
      }
    } catch (e) {
      details.push({
        campaignId: camp.id,
        error: e?.message || String(e),
      });
    }
  }

  await logRun({
    ruleId: rule.id,
    profileId: rule.profileId,
    marketplace: rule.marketplace,
    status: 'ok',
    actionsCount: actions,
    message: `Автопауза: действий ${actions}`,
    details,
  });
  return { actions, details };
}

async function runTargetDrrBid(rule, options = {}) {
  const cfg = rule.config || {};
  const target = Number(cfg.targetDrrPercent) || 10;
  const stepPct = Number(cfg.bidStepPercent) || 5;
  const minBid = Number(cfg.minBid) || 50;
  const maxBid = Number(cfg.maxBid) || 500;
  const scope = {
    profileId: rule.profileId,
    organizationId: rule.organizationId,
    userId: options.userId ?? null,
  };

  const camps = await adsService.listCampaigns({
    ...scope,
    marketplace: rule.marketplace || undefined,
  });

  let actions = 0;
  const details = [];

  for (const camp of camps) {
    if (camp.marketplace === 'ozon' || camp.marketplace === 'yandex') {
      // Write bids primarily supported on WB for now
      continue;
    }
    let full;
    try {
      full = await adsService.getCampaign(camp.id, scope);
    } catch {
      continue;
    }
    for (const p of full.products || []) {
      if (!p.inActive) continue;
      const drr = p.drrPercent;
      if (drr == null) continue;
      const currentBid = Number(p.bid) || Number(camp.bid) || minBid;
      let next = currentBid;
      if (drr > target * 1.1) {
        next = currentBid * (1 - stepPct / 100);
      } else if (drr < target * 0.9) {
        next = currentBid * (1 + stepPct / 100);
      } else {
        continue;
      }
      next = Math.max(minBid, Math.min(maxBid, Math.round(next)));
      if (next === Math.round(currentBid)) continue;
      try {
        await adsService.patchCampaign(
          camp.id,
          { bid: next, skuKey: p.skuKey },
          scope
        );
        actions += 1;
        details.push({
          campaignId: camp.id,
          skuKey: p.skuKey,
          drr,
          from: currentBid,
          to: next,
        });
      } catch (e) {
        details.push({
          campaignId: camp.id,
          skuKey: p.skuKey,
          error: e?.message || String(e),
        });
      }
    }
  }

  await logRun({
    ruleId: rule.id,
    profileId: rule.profileId,
    marketplace: rule.marketplace,
    status: 'ok',
    actionsCount: actions,
    message: `Биддер: действий ${actions}`,
    details,
  });
  return { actions, details };
}

export async function runRule(ruleId, options = {}) {
  const scope = resolveScope(scopeFromOptions(options));
  const r = await query(`SELECT * FROM ads_automation_rules WHERE id = $1`, [Number(ruleId)]);
  const row = r.rows?.[0];
  if (!row) {
    const err = new Error('Правило не найдено');
    err.statusCode = 404;
    throw err;
  }
  const rule = rowToRule(row);
  if (scope.profileId && rule.profileId !== scope.profileId) {
    const err = new Error('Чужое правило');
    err.statusCode = 403;
    throw err;
  }
  if (rule.ruleType === 'zero_stock_pause') return runZeroStockPause(rule, options);
  if (rule.ruleType === 'target_drr_bid') return runTargetDrrBid(rule, options);
  const err = new Error('Неизвестный тип правила');
  err.statusCode = 400;
  throw err;
}

export async function runAllEnabled(options = {}) {
  let profiles = [];
  if (options.profileId) {
    profiles = [Number(options.profileId)];
  } else {
    try {
      const r = await query(
        `SELECT DISTINCT profile_id FROM ads_automation_rules WHERE enabled IS TRUE AND profile_id IS NOT NULL`
      );
      profiles = (r.rows || []).map((x) => Number(x.profile_id)).filter((n) => n > 0);
    } catch (e) {
      logger.warn('[Ads Auto] list profiles failed', { message: e?.message || String(e) });
      return { processed: 0 };
    }
  }

  let processed = 0;
  let actions = 0;
  for (const profileId of profiles) {
    const rules = await listRules({ profileId });
    for (const rule of rules.filter((x) => x.enabled)) {
      try {
        const out = await runRule(rule.id, { profileId });
        processed += 1;
        actions += out?.actions || 0;
      } catch (e) {
        logger.warn('[Ads Auto] rule failed', {
          ruleId: rule.id,
          message: e?.message || String(e),
        });
        await logRun({
          ruleId: rule.id,
          profileId,
          marketplace: rule.marketplace,
          status: 'error',
          actionsCount: 0,
          message: e?.message || String(e),
          details: {},
        });
      }
    }
  }
  return { processed, actions };
}

export default {
  listRules,
  createRule,
  updateRule,
  deleteRule,
  listRuns,
  runRule,
  runAllEnabled,
};
