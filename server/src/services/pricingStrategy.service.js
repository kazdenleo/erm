/**
 * Стратегии ценообразования: пресеты конфига и расчёт цены продажи.
 *
 * Режимы:
 * - floor — цена продажи = расчётный минимум
 * - target_margin — себестоимость + целевая маржа %, не ниже пола
 * - competitor — от цен конкурентов (WB/YM; на Ozon шаг пропускается)
 * - sales — корректировка от скорости продаж (FBS orders)
 * - hybrid — цель/пол → конкурент → продажи, всегда ≥ пол
 * Если задана max_price товара по МП — стратегия не ставит цену выше этого потолка.
 */

import { query } from '../config/database.js';
import {
  formatPriceChangeReason,
  logMarketplacePriceChange,
} from './marketplacePriceChanges.service.js';
import { applyToolPriceAttributeValues } from './computedAttributes.service.js';

export const PRICING_STRATEGY_MODES = ['floor', 'target_margin', 'competitor', 'sales', 'hybrid'];

function floorRub(minPrice) {
  if (minPrice == null || minPrice === '') return null;
  const n = Number(minPrice);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.max(1, Math.ceil(n));
}

/** Потолок продажи: положительное число ₽, иначе не задан. */
function ceilingRub(maxPrice) {
  if (maxPrice == null || maxPrice === '') return null;
  const n = Number(maxPrice);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/** Не выше потолка. Стратегия считает целыми рублями — округляем вниз, чтобы не превысить. */
function capToCeiling(price, ceilingN) {
  if (ceilingN == null || price == null || !Number.isFinite(price) || price <= ceilingN) {
    return price;
  }
  const floored = Math.floor(ceilingN);
  return floored >= 1 ? floored : ceilingN;
}

export function defaultStrategyConfig(mode = 'hybrid') {
  return {
    target_margin_percent: 25,
    competitor: {
      enabled: mode === 'competitor' || mode === 'hybrid',
      agg: 'min', // min | median | avg
      offset_rub: 0,
      offset_percent: -1,
      // если конкурентов нет — оставить базу
      if_missing: 'keep_base',
    },
    sales: {
      enabled: mode === 'sales' || mode === 'hybrid',
      window_days: 14,
      // шт/день
      high_per_day: 1.0,
      low_per_day: 0.1,
      // при высоких продажах поднимаем на %
      high_step_percent: 3,
      // при низких — снижаем на %
      low_step_percent: 5,
      mid_action: 'hold', // hold
    },
    band_percent: 2, // не менять, если новое в пределах ±band от текущего selling
    max_change_percent: 12, // ограничение шага за один пересчёт
    always_above_floor: true,
  };
}

function num(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

function roundRub(n) {
  if (!Number.isFinite(n)) return null;
  return Math.max(1, Math.ceil(n));
}

function mergeConfig(mode, raw) {
  const base = defaultStrategyConfig(mode);
  const cfg = raw && typeof raw === 'object' ? raw : {};
  return {
    ...base,
    ...cfg,
    competitor: { ...base.competitor, ...(cfg.competitor || {}) },
    sales: { ...base.sales, ...(cfg.sales || {}) },
  };
}

function aggregateCompetitorPrices(prices, agg) {
  const vals = prices.map((p) => Number(p)).filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  if (!vals.length) return null;
  if (agg === 'avg') return vals.reduce((s, x) => s + x, 0) / vals.length;
  if (agg === 'median') {
    const mid = Math.floor(vals.length / 2);
    return vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
  }
  return vals[0]; // min
}

async function loadCompetitorPrices(productId, marketplace) {
  const mp = String(marketplace || '').toLowerCase();
  // Ozon: парсера нет — конкурентный шаг не применяем
  if (mp === 'ozon') return { prices: [], skipped: true, reason: 'ozon_no_competitors' };
  const r = await query(
    `SELECT price FROM product_competitors
     WHERE product_id = $1 AND marketplace = $2 AND price IS NOT NULL AND price > 0`,
    [productId, mp]
  );
  return {
    prices: (r.rows || []).map((row) => Number(row.price)).filter((n) => Number.isFinite(n) && n > 0),
    skipped: false,
  };
}

async function loadSalesVelocity(productId, marketplace, windowDays) {
  const days = Math.max(1, Math.min(90, Number(windowDays) || 14));
  const mp = String(marketplace || '').toLowerCase();
  const mpFilter =
    mp === 'wb' || mp === 'wildberries'
      ? `AND LOWER(TRIM(o.marketplace)) IN ('wb','wildberries')`
      : mp === 'ym' || mp === 'yandex'
        ? `AND LOWER(TRIM(o.marketplace)) IN ('ym','yandex','yandexmarket')`
        : mp === 'ozon'
          ? `AND LOWER(TRIM(o.marketplace)) = 'ozon'`
          : '';

  const r = await query(
    `SELECT COALESCE(SUM(GREATEST(COALESCE(o.quantity, 1), 1)), 0)::float AS sold_qty
     FROM orders o
     WHERE o.product_id = $1
       AND LOWER(TRIM(o.status)) = 'delivered'
       AND COALESCE(o.terminal_status_at, o.created_at) >= NOW() - ($2::text || ' days')::interval
       ${mpFilter}`,
    [productId, String(days)]
  );
  const soldQty = Number(r.rows?.[0]?.sold_qty) || 0;
  return { soldQty, windowDays: days, perDay: soldQty / days };
}

function applyCompetitorStep(base, competitorCfg, competitorPrices, marketplace) {
  if (!competitorCfg?.enabled) {
    return { price: base, meta: { applied: false, reason: 'disabled' } };
  }
  if (String(marketplace).toLowerCase() === 'ozon') {
    return { price: base, meta: { applied: false, reason: 'ozon_no_competitors' } };
  }
  const agg = aggregateCompetitorPrices(competitorPrices, competitorCfg.agg || 'min');
  if (agg == null) {
    return {
      price: base,
      meta: { applied: false, reason: competitorCfg.if_missing || 'keep_base', competitorAgg: null },
    };
  }
  const offsetRub = num(competitorCfg.offset_rub, 0) || 0;
  const offsetPct = num(competitorCfg.offset_percent, 0) || 0;
  let price = agg * (1 + offsetPct / 100) + offsetRub;
  return {
    price,
    meta: {
      applied: true,
      competitorAgg: roundRub(agg),
      offset_rub: offsetRub,
      offset_percent: offsetPct,
      raw: price,
    },
  };
}

function applySalesStep(price, salesCfg, velocity, previousSelling) {
  if (!salesCfg?.enabled) {
    return { price, meta: { applied: false, reason: 'disabled' } };
  }
  const perDay = velocity?.perDay ?? 0;
  const high = num(salesCfg.high_per_day, 1) ?? 1;
  const low = num(salesCfg.low_per_day, 0.1) ?? 0.1;
  let band = 'mid';
  let next = price;
  if (perDay >= high) {
    band = 'high';
    const step = num(salesCfg.high_step_percent, 3) ?? 3;
    next = price * (1 + step / 100);
  } else if (perDay <= low) {
    band = 'low';
    const step = num(salesCfg.low_step_percent, 5) ?? 5;
    next = price * (1 - step / 100);
  } else if (salesCfg.mid_action === 'hold' && previousSelling != null && Number.isFinite(previousSelling)) {
    // в середине коридора можно держаться ближе к текущей цене продажи
    next = previousSelling;
  }
  return {
    price: next,
    meta: {
      applied: true,
      band,
      perDay: Math.round(perDay * 1000) / 1000,
      soldQty: velocity?.soldQty ?? 0,
      windowDays: velocity?.windowDays ?? null,
    },
  };
}

function limitChange(newPrice, previousSelling, maxChangePercent) {
  const maxPct = num(maxChangePercent, null);
  if (maxPct == null || previousSelling == null || !Number.isFinite(previousSelling) || previousSelling <= 0) {
    return { price: newPrice, limited: false };
  }
  const lo = previousSelling * (1 - maxPct / 100);
  const hi = previousSelling * (1 + maxPct / 100);
  const clamped = clamp(newPrice, lo, hi);
  return { price: clamped, limited: clamped !== newPrice, lo, hi };
}

function withinBand(candidate, previousSelling, bandPercent) {
  const band = num(bandPercent, 0) || 0;
  if (band <= 0 || previousSelling == null || !Number.isFinite(previousSelling) || previousSelling <= 0) {
    return false;
  }
  const diff = Math.abs(candidate - previousSelling) / previousSelling;
  return diff * 100 <= band;
}

/**
 * Чистый расчёт цены продажи по стратегии.
 */
export function computeSellingPriceFromInputs({
  mode,
  config,
  floor,
  cost,
  competitorPrices = [],
  velocity = null,
  previousSelling = null,
  marketplace = null,
  ceiling = null,
  maxPrice = null,
}) {
  const m = PRICING_STRATEGY_MODES.includes(mode) ? mode : 'floor';
  const cfg = mergeConfig(m, config);
  const floorN = floorRub(floor);
  const ceilingN = ceilingRub(ceiling ?? maxPrice);
  const costN = num(cost, 0) || 0;
  const details = { mode: m, steps: [], ceiling: ceilingN };

  let base;
  if (m === 'floor') {
    base = floorN;
    details.steps.push({ step: 'floor', price: base });
  } else if (m === 'target_margin' || m === 'hybrid' || m === 'sales' || m === 'competitor') {
    const marginPct = num(cfg.target_margin_percent, 25) ?? 25;
    if (m === 'competitor' || m === 'sales') {
      // база = пол; дальше шаги конкурента/продаж
      base = floorN;
      details.steps.push({ step: 'base_floor', price: base });
    } else {
      base = costN > 0 ? costN * (1 + marginPct / 100) : floorN;
      details.steps.push({ step: 'target_margin', margin_percent: marginPct, cost: costN, price: base });
    }
  } else {
    base = floorN;
  }

  let price = base;

  if (m === 'competitor' || m === 'hybrid') {
    const c = applyCompetitorStep(price, cfg.competitor, competitorPrices, marketplace);
    price = c.price;
    details.steps.push({ step: 'competitor', ...c.meta, price });
  }

  if (m === 'sales' || m === 'hybrid') {
    const s = applySalesStep(price, cfg.sales, velocity, previousSelling);
    price = s.price;
    details.steps.push({ step: 'sales', ...s.meta, price });
  }

  const lim = limitChange(price, previousSelling, cfg.max_change_percent);
  price = lim.price;
  if (lim.limited) details.steps.push({ step: 'max_change', ...lim, price });

  if (cfg.always_above_floor !== false && floorN != null) {
    if (price < floorN) {
      details.steps.push({ step: 'clamp_floor', from: price, to: floorN });
      price = floorN;
    }
  }

  if (ceilingN != null && price > ceilingN) {
    const capped = capToCeiling(price, ceilingN);
    details.steps.push({
      step: 'clamp_ceiling',
      from: price,
      to: capped,
      ceiling: ceilingN,
      floorBelowCeiling: floorN == null || floorN <= ceilingN,
    });
    price = capped;
  }

  let rounded = roundRub(price);
  if (ceilingN != null && rounded > ceilingN) {
    const capped = capToCeiling(rounded, ceilingN);
    details.steps.push({ step: 'clamp_ceiling_round', from: rounded, to: capped, ceiling: ceilingN });
    rounded = capped;
  }

  const previousCapped = capToCeiling(previousSelling, ceilingN);
  const previousWouldExceedCeiling =
    ceilingN != null && previousSelling != null && Number(previousSelling) > ceilingN;
  if (
    !previousWouldExceedCeiling &&
    withinBand(rounded, previousCapped, cfg.band_percent) &&
    previousSelling != null
  ) {
    details.steps.push({
      step: 'band_hold',
      previous: previousSelling,
      candidate: rounded,
      band_percent: cfg.band_percent,
    });
    return {
      sellingPrice: roundRub(previousCapped ?? previousSelling),
      floor: floorN,
      ceiling: ceilingN,
      details,
      heldByBand: true,
      cappedByCeiling: false,
    };
  }

  return {
    sellingPrice: rounded,
    floor: floorN,
    ceiling: ceilingN,
    details,
    heldByBand: false,
    cappedByCeiling: details.steps.some((s) => String(s.step || '').startsWith('clamp_ceiling')),
  };
}

async function isProfilePricingStrategiesEnabled(profileId) {
  const pid = profileId != null ? Number(profileId) : NaN;
  if (!Number.isFinite(pid) || pid < 1) return true;
  try {
    const r = await query(
      `SELECT COALESCE(pricing_strategies_enabled, true) AS enabled FROM profiles WHERE id = $1`,
      [pid]
    );
    return r.rows?.[0]?.enabled !== false;
  } catch (e) {
    // колонка ещё не мигрирована
    if (e?.message && String(e.message).includes('pricing_strategies_enabled')) return true;
    throw e;
  }
}

async function resolveStrategyRow({ productId, organizationId, profileId, strategyId }) {
  const enabled = await isProfilePricingStrategiesEnabled(profileId);
  if (!enabled) return null;

  if (strategyId) {
    const r = await query(`SELECT * FROM pricing_strategies WHERE id = $1 LIMIT 1`, [strategyId]);
    if (r.rows?.[0]) return r.rows[0];
  }
  if (productId) {
    const p = await query(`SELECT pricing_strategy_id FROM products WHERE id = $1`, [productId]);
    const sid = p.rows?.[0]?.pricing_strategy_id;
    if (sid) {
      const r = await query(`SELECT * FROM pricing_strategies WHERE id = $1 AND is_active = true`, [sid]);
      if (r.rows?.[0]) return r.rows[0];
    }
  }
  if (organizationId) {
    const o = await query(`SELECT pricing_strategy_id FROM organizations WHERE id = $1`, [organizationId]);
    const sid = o.rows?.[0]?.pricing_strategy_id;
    if (sid) {
      const r = await query(`SELECT * FROM pricing_strategies WHERE id = $1 AND is_active = true`, [sid]);
      if (r.rows?.[0]) return r.rows[0];
    }
  }
  if (profileId != null) {
    const r = await query(
      `SELECT * FROM pricing_strategies
       WHERE profile_id = $1 AND is_default = true AND is_active = true
       LIMIT 1`,
      [profileId]
    );
    if (r.rows?.[0]) return r.rows[0];
  }
  return null;
}

export async function getProfilePricingSettings(profileId) {
  const pid = Number(profileId);
  if (!Number.isFinite(pid) || pid < 1) {
    return { enabled: true, defaultStrategy: null };
  }
  const enabled = await isProfilePricingStrategiesEnabled(pid);
  const def = await query(
    `SELECT id, name, mode, is_active, is_default
     FROM pricing_strategies
     WHERE profile_id = $1 AND is_default = true
     LIMIT 1`,
    [pid]
  );
  return {
    enabled,
    defaultStrategy: def.rows?.[0] || null,
  };
}

export async function setProfilePricingStrategiesEnabled(profileId, enabled) {
  const pid = Number(profileId);
  if (!Number.isFinite(pid) || pid < 1) {
    throw new Error('Некорректный профиль');
  }
  const on = enabled === true || enabled === 'true' || enabled === 1 || enabled === '1';
  await query(
    `UPDATE profiles
     SET pricing_strategies_enabled = $1, updated_at = CURRENT_TIMESTAMP
     WHERE id = $2`,
    [on, pid]
  );
  return getProfilePricingSettings(pid);
}

/**
 * Пересчитать и сохранить selling_price для одного товара по всем МП (или одному).
 */
export async function recalculateSellingPricesForProduct(productId, { marketplace = null } = {}) {
  const pid = Number(productId);
  if (!Number.isFinite(pid) || pid < 1) return { ok: false, error: 'invalid_product' };

  const prodRes = await query(
    `SELECT id, cost, organization_id, profile_id, pricing_strategy_id
     FROM products WHERE id = $1`,
    [pid]
  );
  const product = prodRes.rows?.[0];
  if (!product) return { ok: false, error: 'product_not_found' };

  const strategy = await resolveStrategyRow({
    productId: pid,
    organizationId: product.organization_id,
    profileId: product.profile_id,
    strategyId: null,
  });

  let floorsRes;
  try {
    floorsRes = await query(
      `SELECT marketplace, min_price, selling_price, max_price, price_before_discount
       FROM product_marketplace_prices
       WHERE product_id = $1
         AND min_price IS NOT NULL AND min_price > 0
         ${marketplace ? 'AND marketplace = $2' : ''}`,
      marketplace ? [pid, String(marketplace).toLowerCase()] : [pid]
    );
  } catch (colErr) {
    if (!String(colErr.message || '').includes('max_price') && !String(colErr.message || '').includes('price_before_discount')) throw colErr;
    floorsRes = await query(
      `SELECT marketplace, min_price, selling_price
       FROM product_marketplace_prices
       WHERE product_id = $1
         AND min_price IS NOT NULL AND min_price > 0
         ${marketplace ? 'AND marketplace = $2' : ''}`,
      marketplace ? [pid, String(marketplace).toLowerCase()] : [pid]
    );
  }

  const results = [];
  for (const row of floorsRes.rows || []) {
    const mp = String(row.marketplace).toLowerCase();
    const floor = Number(row.min_price);
    const previousSelling = row.selling_price != null ? Number(row.selling_price) : null;
    const previousBefore =
      row.price_before_discount != null && Number.isFinite(Number(row.price_before_discount))
        ? Number(row.price_before_discount)
        : null;
    const floorRounded = floorRub(floor);

    if (!strategy) {
      // Нет стратегии: не затираем ручную цену; иначе подставляем пол.
      const sellingPrice =
        previousSelling != null && Number.isFinite(previousSelling) && previousSelling > 0
          ? floorRub(previousSelling)
          : floorRounded;
      await query(
        `UPDATE product_marketplace_prices
         SET selling_price = $1,
             pricing_strategy_id = NULL,
             strategy_details = $2::jsonb,
             updated_at = CURRENT_TIMESTAMP
         WHERE product_id = $3 AND marketplace = $4
           AND COALESCE(selling_price_manual, false) = false`,
        [
          sellingPrice,
          JSON.stringify({ mode: 'floor', reason: 'no_strategy', sellingPrice, floor: floorRounded }),
          pid,
          mp,
        ]
      );
      // Если цена ручная — оставляем как есть, только обновим details при отсутствии manual-флага уже обработано.
      const check = await query(
        `SELECT selling_price, COALESCE(selling_price_manual, false) AS is_manual
         FROM product_marketplace_prices
         WHERE product_id = $1 AND marketplace = $2`,
        [pid, mp]
      );
      const cur = check.rows?.[0];
      const finalSelling =
        cur?.is_manual === true && cur.selling_price != null
          ? floorRub(cur.selling_price)
          : sellingPrice;
      const details =
        cur?.is_manual === true
          ? {
              mode: 'manual',
              reason: 'manual_selling_price',
              sellingPrice: finalSelling,
              floor: floorRounded,
            }
          : { mode: 'floor', reason: 'no_strategy', sellingPrice: finalSelling, floor: floorRounded };
      if (cur?.is_manual === true) {
        await query(
          `UPDATE product_marketplace_prices
           SET pricing_strategy_id = NULL,
               strategy_details = $1::jsonb,
               updated_at = CURRENT_TIMESTAMP
           WHERE product_id = $2 AND marketplace = $3`,
          [JSON.stringify(details), pid, mp]
        );
      }
      const reason = formatPriceChangeReason({
        source: cur?.is_manual === true ? 'manual' : 'strategy',
        meta: details,
      });
      await logMarketplacePriceChange({
        productId: pid,
        marketplace: mp,
        source: cur?.is_manual === true ? 'manual' : 'strategy',
        reason,
        minPriceBefore: floorRounded,
        minPriceAfter: floorRounded,
        sellingPriceBefore: previousSelling,
        sellingPriceAfter: finalSelling,
        profileId: product.profile_id,
        meta: details,
      });
      results.push({
        marketplace: mp,
        sellingPrice: finalSelling,
        sellingPriceBefore: previousSelling,
        priceBeforeDiscount: previousBefore,
        floor: floorRounded,
        mode: cur?.is_manual === true ? 'manual' : 'floor',
        reason,
        changed: !sameMoneyLocal(previousSelling, finalSelling),
      });
      continue;
    }

    const mode = strategy.mode;
    const config = strategy.config || {};
    const needComp = mode === 'competitor' || mode === 'hybrid';
    const needSales = mode === 'sales' || mode === 'hybrid';
    const cfg = mergeConfig(mode, config);

    const comp = needComp ? await loadCompetitorPrices(pid, mp) : { prices: [] };
    const velocity = needSales
      ? await loadSalesVelocity(pid, mp, cfg.sales?.window_days)
      : null;

    const computed = computeSellingPriceFromInputs({
      mode,
      config,
      floor,
      cost: product.cost,
      competitorPrices: comp.prices || [],
      velocity,
      previousSelling,
      marketplace: mp,
      ceiling: row.max_price,
    });

    const details = {
      ...computed.details,
      strategyId: Number(strategy.id),
      strategyName: strategy.name,
      sellingPrice: computed.sellingPrice,
      floor: computed.floor,
      ceiling: computed.ceiling,
      competitorsCount: (comp.prices || []).length,
      competitorSkip: comp.skipped ? comp.reason : null,
      heldByBand: computed.heldByBand === true,
      cappedByCeiling: computed.cappedByCeiling === true,
    };

    await query(
      `UPDATE product_marketplace_prices
       SET selling_price = $1, pricing_strategy_id = $2,
           strategy_details = $3::jsonb,
           selling_price_manual = false,
           updated_at = CURRENT_TIMESTAMP
       WHERE product_id = $4 AND marketplace = $5`,
      [computed.sellingPrice, strategy.id, JSON.stringify(details), pid, mp]
    );

    const reason = formatPriceChangeReason({
      source: 'strategy',
      meta: details,
      strategyName: strategy.name,
      mode,
    });
    await logMarketplacePriceChange({
      productId: pid,
      marketplace: mp,
      source: 'strategy',
      reason,
      minPriceBefore: floorRounded,
      minPriceAfter: computed.floor,
      sellingPriceBefore: previousSelling,
      sellingPriceAfter: computed.sellingPrice,
      pricingStrategyId: strategy.id,
      profileId: product.profile_id,
      meta: details,
    });

    results.push({
      marketplace: mp,
      sellingPrice: computed.sellingPrice,
      sellingPriceBefore: previousSelling,
      priceBeforeDiscount: previousBefore,
      floor: computed.floor,
      ceiling: computed.ceiling,
      mode,
      strategyId: Number(strategy.id),
      strategyName: strategy.name,
      heldByBand: computed.heldByBand,
      cappedByCeiling: computed.cappedByCeiling,
      reason,
      changed: !sameMoneyLocal(previousSelling, computed.sellingPrice),
    });
  }

  try {
    const sync = pickToolSyncPrices(results);
    if (sync) {
      await applyToolPriceAttributeValues(query, pid, sync);
    }
  } catch (err) {
    console.warn('[pricingStrategy] sync system price attributes:', err?.message || err);
  }

  return { ok: true, productId: pid, strategyId: strategy ? Number(strategy.id) : null, results };
}

function sameMoneyLocal(a, b) {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return Math.abs(Number(a) - Number(b)) < 0.005;
}

function pickToolSyncPrices(results) {
  const eligible = (results || []).filter((r) => r.changed && r.mode !== 'manual');
  if (!eligible.length) return null;
  const order = ['ozon', 'wb', 'ym'];
  const pick = order.map((mp) => eligible.find((r) => r.marketplace === mp)).find(Boolean) || eligible[0];
  return {
    sellingPrice: pick.sellingPrice,
  };
}

export async function listStrategies({ profileId = null } = {}) {
  if (profileId != null) {
    const r = await query(
      `SELECT * FROM pricing_strategies
       WHERE profile_id = $1 OR profile_id IS NULL
       ORDER BY is_default DESC, name ASC`,
      [profileId]
    );
    return r.rows || [];
  }
  const r = await query(`SELECT * FROM pricing_strategies ORDER BY profile_id NULLS FIRST, name ASC`);
  return r.rows || [];
}

export async function getStrategy(id) {
  const r = await query(`SELECT * FROM pricing_strategies WHERE id = $1`, [id]);
  return r.rows?.[0] || null;
}

export async function createStrategy(data, { profileId = null } = {}) {
  const name = String(data.name || '').trim();
  if (!name) throw new Error('Укажите название стратегии');
  const mode = PRICING_STRATEGY_MODES.includes(data.mode) ? data.mode : 'hybrid';
  const config = mergeConfig(mode, data.config);
  const isDefault = data.is_default === true || data.isDefault === true;
  const pid = data.profile_id ?? data.profileId ?? profileId;

  if (isDefault && pid != null) {
    await query(`UPDATE pricing_strategies SET is_default = false WHERE profile_id = $1`, [pid]);
  }

  const r = await query(
    `INSERT INTO pricing_strategies (profile_id, name, description, is_active, is_default, mode, config)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     RETURNING *`,
    [
      pid,
      name,
      data.description || null,
      data.is_active !== false && data.isActive !== false,
      isDefault,
      mode,
      JSON.stringify(config),
    ]
  );
  return r.rows[0];
}

export async function updateStrategy(id, data) {
  const existing = await getStrategy(id);
  if (!existing) return null;

  const mode = data.mode != null && PRICING_STRATEGY_MODES.includes(data.mode) ? data.mode : existing.mode;
  const config =
    data.config !== undefined ? mergeConfig(mode, data.config) : mergeConfig(mode, existing.config);
  const isDefault =
    data.is_default !== undefined || data.isDefault !== undefined
      ? data.is_default === true || data.isDefault === true
      : existing.is_default;

  if (isDefault && existing.profile_id != null) {
    await query(
      `UPDATE pricing_strategies SET is_default = false WHERE profile_id = $1 AND id <> $2`,
      [existing.profile_id, id]
    );
  }

  const r = await query(
    `UPDATE pricing_strategies SET
       name = COALESCE($2, name),
       description = COALESCE($3, description),
       is_active = COALESCE($4, is_active),
       is_default = $5,
       mode = $6,
       config = $7::jsonb,
       updated_at = CURRENT_TIMESTAMP
     WHERE id = $1
     RETURNING *`,
    [
      id,
      data.name != null ? String(data.name).trim() : null,
      data.description !== undefined ? data.description : null,
      data.is_active !== undefined || data.isActive !== undefined
        ? data.is_active === true || data.isActive === true
        : null,
      isDefault,
      mode,
      JSON.stringify(config),
    ]
  );
  return r.rows[0] || null;
}

export async function deleteStrategy(id) {
  const r = await query(`DELETE FROM pricing_strategies WHERE id = $1 RETURNING id`, [id]);
  return r.rows.length > 0;
}

export async function ensureDefaultStrategies(profileId) {
  if (profileId == null) return [];
  const existing = await query(
    `SELECT id FROM pricing_strategies WHERE profile_id = $1 LIMIT 1`,
    [profileId]
  );
  if (existing.rows?.length) return listStrategies({ profileId });

  const presets = [
    {
      name: 'Минимум (пол)',
      mode: 'floor',
      description: 'Цена продажи = рассчитанный минимум. Безопасный режим.',
      is_default: true,
    },
    {
      name: 'Целевая маржа',
      mode: 'target_margin',
      description: 'Себестоимость + % маржи, не ниже пола.',
      config: { target_margin_percent: 25 },
    },
    {
      name: 'От конкурентов (WB/YM)',
      mode: 'competitor',
      description: 'Ориентир на min цену конкурентов −1%. На Ozon конкуренты недоступны — останется пол.',
      config: defaultStrategyConfig('competitor'),
    },
    {
      name: 'От продаж',
      mode: 'sales',
      description: 'При хороших продажах поднимаем цену, при слабых — снижаем (не ниже пола).',
      config: defaultStrategyConfig('sales'),
    },
    {
      name: 'Гибрид: конкуренты + продажи',
      mode: 'hybrid',
      description: 'Цель/пол → конкуренты (WB/YM) → корректировка по продажам. Всегда ≥ пола.',
      config: defaultStrategyConfig('hybrid'),
    },
  ];

  for (const p of presets) {
    await createStrategy(p, { profileId });
  }
  return listStrategies({ profileId });
}

export default {
  PRICING_STRATEGY_MODES,
  defaultStrategyConfig,
  computeSellingPriceFromInputs,
  recalculateSellingPricesForProduct,
  listStrategies,
  getStrategy,
  createStrategy,
  updateStrategy,
  deleteStrategy,
  ensureDefaultStrategies,
  getProfilePricingSettings,
  setProfilePricingStrategiesEnabled,
};
