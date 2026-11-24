/**
 * Стратегии ценообразования: пресеты конфига и расчёт цены продажи.
 *
 * Режимы:
 * - floor — цена продажи = расчётный минимум (FBS/FBO по price_push_settings профиля)
 * - target_margin — целевая чистая маржа % от цены (калькулятор МП); не ниже пола
 * - competitor — от цен конкурентов (WB/YM; на Ozon шаг пропускается)
 * - sales — корректировка от скорости продаж (FBS orders)
 * - hybrid — цель/пол → конкурент → продажи, всегда ≥ пол
 * Если задана max_price товара по МП — стратегия не ставит цену выше этого потолка.
 */

import { query } from '../config/database.js';
import {
  parsePricePushSettings,
  resolvePushFloorForMarketplace,
} from '../utils/pricePushSettings.js';
import {
  formatPriceChangeReason,
  logMarketplacePriceChange,
} from './marketplacePriceChanges.service.js';
import { applyToolPriceAttributeValues } from './computedAttributes.service.js';
import { calculateMinPrice } from './min-price-calculator.service.js';
import { resolveOrganizationTaxProfile } from '../utils/organizationTaxRates.js';

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
  // Number(null) === 0 — не считаем null/'' числом
  if (v == null || v === '') return fallback;
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
/**
 * Цена под целевую чистую маржу % от цены продажи (как «чист.%» на Ценах).
 * Итерация через calculateMinPrice(profitRub = price * margin/100).
 * Без калькулятора: факт = мин × (1 + %/100).
 */
export function resolveTargetMarginPrice({
  marginPercent,
  floor,
  cost = 0,
  additionalExpenses = 0,
  calculator = null,
  marketplace = null,
  product = null,
  wbAcquiringPercent = null,
  wbGemServicesPercent = null,
  taxProfile = null,
  scheme = null,
  sppPercent = null,
}) {
  const marginPct = num(marginPercent, 25) ?? 25;
  const floorN = floorRub(floor);
  const basePrice = (num(cost, 0) || 0) + (num(additionalExpenses, 0) || 0);

  if (calculator && marketplace) {
    let price = floorN != null ? floorN : Math.max(basePrice * 2, 100);
    for (let i = 0; i < 28; i++) {
      const targetNet = Math.max(0, price * (marginPct / 100));
      const next = calculateMinPrice(
        basePrice,
        calculator,
        String(marketplace).toLowerCase(),
        targetNet,
        product,
        wbAcquiringPercent,
        wbGemServicesPercent,
        taxProfile,
        scheme,
        sppPercent
      );
      if (next == null || !Number.isFinite(Number(next)) || Number(next) <= 0) break;
      const n = Number(next);
      if (Math.abs(n - price) < 1) {
        price = n;
        break;
      }
      price = n;
    }
    const rounded = floorRub(price);
    if (rounded != null && floorN != null) return Math.max(rounded, floorN);
    return rounded ?? floorN;
  }

  // Fallback без калькулятора МП: надбавка к полу (иначе cost+% почти всегда < пола).
  if (floorN != null && marginPct > 0) {
    return floorRub(floorN * (1 + marginPct / 100));
  }
  if (basePrice > 0) {
    const fromCost = floorRub(basePrice * (1 + marginPct / 100));
    if (fromCost != null && floorN != null) return Math.max(fromCost, floorN);
    return fromCost ?? floorN;
  }
  return floorN;
}

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
  /** Готовая база для target_margin/hybrid (из калькулятора МП) */
  targetMarginPrice = null,
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
    } else if (targetMarginPrice != null && Number.isFinite(Number(targetMarginPrice))) {
      base = floorRub(targetMarginPrice);
      if (floorN != null && (base == null || base < floorN)) base = floorN;
      details.steps.push({
        step: 'target_margin',
        margin_percent: marginPct,
        cost: costN,
        price: base,
        source: 'marketplace_net_margin',
      });
    } else {
      // Без заранее посчитанной МП-цены: надбавка к полу, иначе cost+% тонет под минимумом.
      base = resolveTargetMarginPrice({
        marginPercent: marginPct,
        floor: floorN,
        cost: costN,
      });
      details.steps.push({
        step: 'target_margin',
        margin_percent: marginPct,
        cost: costN,
        price: base,
        source: 'floor_premium_fallback',
      });
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

  if (floorN != null && (price == null || price < floorN)) {
    details.steps.push({ step: 'clamp_floor', from: price, to: floorN });
    price = floorN;
  }

  const ceilingBelowFloor = ceilingN != null && floorN != null && ceilingN < floorN;
  if (ceilingBelowFloor) {
    details.steps.push({
      step: 'ceiling_below_floor',
      ceiling: ceilingN,
      floor: floorN,
    });
    details.ceilingBelowFloor = true;
  }

  if (!ceilingBelowFloor && ceilingN != null && price > ceilingN) {
    const capped = capToCeiling(price, ceilingN);
    details.steps.push({
      step: 'clamp_ceiling',
      from: price,
      to: capped,
      ceiling: ceilingN,
      floorBelowCeiling: false,
    });
    price = capped;
  }

  let rounded = roundRub(price);
  if (!ceilingBelowFloor && ceilingN != null && rounded > ceilingN) {
    const capped = capToCeiling(rounded, ceilingN);
    details.steps.push({ step: 'clamp_ceiling_round', from: rounded, to: capped, ceiling: ceilingN });
    rounded = capped;
  }
  if (floorN != null && (rounded == null || rounded < floorN)) {
    details.steps.push({ step: 'clamp_floor_final', from: rounded, to: floorN });
    rounded = floorN;
  }

  const previousCapped = ceilingBelowFloor
    ? roundRub(previousSelling)
    : capToCeiling(previousSelling, ceilingN);
  const previousWouldExceedCeiling =
    !ceilingBelowFloor &&
    ceilingN != null &&
    previousSelling != null &&
    Number(previousSelling) > ceilingN;
  const heldPrevious = roundRub(previousCapped ?? previousSelling);
  const heldRespectsFloor = floorN == null || (heldPrevious != null && heldPrevious >= floorN);
  // Не блокируем подъём к целевой марже: «полоса» только гасит мелкие колебания у цели.
  const climbingToTarget =
    (m === 'target_margin' || m === 'hybrid') &&
    targetMarginPrice != null &&
    Number.isFinite(Number(targetMarginPrice)) &&
    heldPrevious != null &&
    rounded != null &&
    rounded > heldPrevious &&
    heldPrevious + 0.5 < Number(targetMarginPrice);
  if (
    !climbingToTarget &&
    !previousWouldExceedCeiling &&
    heldRespectsFloor &&
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
      sellingPrice: heldPrevious,
      floor: floorN,
      ceiling: ceilingN,
      details,
      heldByBand: true,
      cappedByCeiling: false,
      ceilingBelowFloor,
    };
  }

  return {
    sellingPrice: rounded,
    floor: floorN,
    ceiling: ceilingN,
    details,
    heldByBand: false,
    cappedByCeiling:
      !ceilingBelowFloor && details.steps.some((s) => String(s.step || '').startsWith('clamp_ceiling')),
    ceilingBelowFloor,
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

/** Нормализация кода МП для правил и пересчёта. */
export function normalizeStrategyMarketplace(raw) {
  if (raw == null || raw === '' || raw === 'all') return null;
  const s = String(raw).trim().toLowerCase();
  if (s === 'wildberries' || s === 'wb') return 'wb';
  if (s === 'yandex' || s === 'ym' || s === 'yandex_market') return 'ym';
  if (s === 'ozon') return 'ozon';
  return null;
}

/**
 * Приоритет правила: выше = сильнее.
 * product+МП > product > brand+МП > brand > category+МП > category > profile.
 */
export function rulePriority(scopeType, marketplace) {
  const base =
    scopeType === 'product'
      ? 100
      : scopeType === 'brand'
        ? 60
        : scopeType === 'category'
          ? 40
          : scopeType === 'profile'
            ? 10
            : 0;
  return base + (marketplace ? 1 : 0);
}

/**
 * Эффективная стратегия для товара на МП.
 * Приоритет: правило product+МП → product (колонка/правило) → brand → category → default кабинета.
 */
export async function resolveStrategyRow({ productId, profileId, strategyId, marketplace = null }) {
  const enabled = await isProfilePricingStrategiesEnabled(profileId);
  if (!enabled) return null;

  if (strategyId) {
    const r = await query(
      `SELECT * FROM pricing_strategies WHERE id = $1 AND is_active = true LIMIT 1`,
      [strategyId]
    );
    if (r.rows?.[0]) return { ...r.rows[0], _source: 'explicit' };
  }

  const mp = normalizeStrategyMarketplace(marketplace);
  const pid = productId != null ? Number(productId) : null;
  if (!Number.isFinite(pid) || pid < 1) return null;

  const prodRes = await query(
    `SELECT id, profile_id, brand_id, user_category_id, pricing_strategy_id
     FROM products WHERE id = $1`,
    [pid]
  );
  const product = prodRes.rows?.[0];
  if (!product) return null;
  const effectiveProfileId =
    profileId != null && Number.isFinite(Number(profileId))
      ? Number(profileId)
      : product.profile_id != null
        ? Number(product.profile_id)
        : null;

  const candidates = [];

  // Правила назначения
  if (effectiveProfileId != null) {
    try {
      const rulesRes = await query(
        `SELECT r.id AS rule_id, r.scope_type, r.scope_id, r.marketplace, r.strategy_id,
                ps.id, ps.name, ps.mode, ps.config, ps.is_active, ps.profile_id, ps.is_default
         FROM pricing_strategy_rules r
         JOIN pricing_strategies ps ON ps.id = r.strategy_id AND ps.is_active = true
         WHERE r.profile_id = $1
           AND r.is_active = true
           AND (
             (r.scope_type = 'product' AND r.scope_id = $2)
             OR (r.scope_type = 'brand' AND $3::bigint IS NOT NULL AND r.scope_id = $3)
             OR (r.scope_type = 'category' AND $4::bigint IS NOT NULL AND r.scope_id = $4)
             OR (r.scope_type = 'profile' AND r.scope_id IS NULL)
           )
           AND (r.marketplace IS NULL OR r.marketplace = $5 OR ($5 IS NULL AND r.marketplace IS NULL))`,
        [
          effectiveProfileId,
          pid,
          product.brand_id != null ? Number(product.brand_id) : null,
          product.user_category_id != null ? Number(product.user_category_id) : null,
          mp,
        ]
      );
      for (const row of rulesRes.rows || []) {
        const ruleMp = normalizeStrategyMarketplace(row.marketplace);
        // Правило на конкретный МП не подходит, если считаем «все» без МП; при конкретном МП
        // берём и NULL, и совпадение.
        if (mp != null && ruleMp != null && ruleMp !== mp) continue;
        if (mp == null && ruleMp != null) continue;
        candidates.push({
          row,
          priority: rulePriority(row.scope_type, ruleMp),
          source: `rule:${row.scope_type}${ruleMp ? `:${ruleMp}` : ''}`,
        });
      }
    } catch (err) {
      // Таблица правил может ещё не быть на старых инстансах
      if (String(err?.code) !== '42P01') throw err;
    }
  }

  // Явная привязка на товаре (все МП) — как product без МП
  if (product.pricing_strategy_id) {
    const r = await query(
      `SELECT * FROM pricing_strategies WHERE id = $1 AND is_active = true`,
      [product.pricing_strategy_id]
    );
    if (r.rows?.[0]) {
      candidates.push({
        row: r.rows[0],
        priority: rulePriority('product', null),
        source: 'product',
      });
    }
  }

  // Дефолт кабинета (is_default)
  if (effectiveProfileId != null) {
    const def = await query(
      `SELECT * FROM pricing_strategies
       WHERE profile_id = $1 AND is_default = true AND is_active = true
       LIMIT 1`,
      [effectiveProfileId]
    );
    if (def.rows?.[0]) {
      candidates.push({
        row: def.rows[0],
        priority: rulePriority('profile', null),
        source: 'profile_default',
      });
    }
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => b.priority - a.priority || String(a.source).localeCompare(String(b.source)));
  const best = candidates[0];
  return { ...best.row, _source: best.source, _priority: best.priority };
}

/** Снять стратегию с товара (и опционально правило на конкретный МП). */
export async function clearProductPricingStrategy(productId, { marketplace = null } = {}) {
  const pid = Number(productId);
  if (!Number.isFinite(pid) || pid < 1) throw new Error('Некорректный productId');
  const mp = normalizeStrategyMarketplace(marketplace);

  const prod = await query(`SELECT profile_id FROM products WHERE id = $1`, [pid]);
  const profileId = prod.rows?.[0]?.profile_id != null ? Number(prod.rows[0].profile_id) : null;

  if (mp) {
    if (profileId != null) {
      try {
        await query(
          `DELETE FROM pricing_strategy_rules
           WHERE profile_id = $1 AND scope_type = 'product' AND scope_id = $2 AND marketplace = $3`,
          [profileId, pid, mp]
        );
      } catch (err) {
        if (String(err?.code) !== '42P01') throw err;
      }
    }
    return { productId: pid, strategyId: null, marketplace: mp };
  }

  await query(
    `UPDATE products
     SET pricing_strategy_id = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND pricing_strategy_id IS NOT NULL`,
    [pid]
  );
  if (profileId != null) {
    try {
      await query(
        `DELETE FROM pricing_strategy_rules
         WHERE profile_id = $1 AND scope_type = 'product' AND scope_id = $2`,
        [profileId, pid]
      );
    } catch (err) {
      if (String(err?.code) !== '42P01') throw err;
    }
  }
  return { productId: pid, strategyId: null };
}

/**
 * Привязать стратегию к товару или снять (strategyId = null).
 * marketplace — только для этого МП (правило); без marketplace — для всех МП (колонка товара).
 */
export async function assignProductPricingStrategy(
  productId,
  strategyId,
  { profileId = null, marketplace = null } = {}
) {
  const pid = Number(productId);
  if (!Number.isFinite(pid) || pid < 1) throw new Error('Некорректный productId');
  const mp = normalizeStrategyMarketplace(marketplace);

  const prod = await query(`SELECT id, profile_id FROM products WHERE id = $1`, [pid]);
  if (!prod.rows?.[0]) throw new Error('Товар не найден');
  const productProfileId = prod.rows[0].profile_id != null ? Number(prod.rows[0].profile_id) : null;
  if (
    profileId != null &&
    productProfileId != null &&
    Number(profileId) !== productProfileId
  ) {
    throw new Error('Товар принадлежит другому кабинету');
  }
  if (productProfileId == null) throw new Error('У товара нет профиля');

  let sid = null;
  if (strategyId != null && strategyId !== '' && strategyId !== 'null') {
    sid = Number(strategyId);
    if (!Number.isFinite(sid) || sid < 1) throw new Error('Некорректный strategyId');
    const st = await query(
      `SELECT id, profile_id, is_active FROM pricing_strategies WHERE id = $1`,
      [sid]
    );
    const row = st.rows?.[0];
    if (!row) throw new Error('Стратегия не найдена');
    if (row.is_active === false) throw new Error('Стратегия неактивна');
    if (
      row.profile_id != null &&
      productProfileId != null &&
      Number(row.profile_id) !== productProfileId
    ) {
      throw new Error('Стратегия другого кабинета');
    }
  }

  if (mp) {
    if (sid == null) {
      await clearProductPricingStrategy(pid, { marketplace: mp });
      return { productId: pid, strategyId: null, marketplace: mp, recalculated: null };
    }
    await upsertStrategyRule({
      profileId: productProfileId,
      strategyId: sid,
      scopeType: 'product',
      scopeId: pid,
      marketplace: mp,
    });
    await query(
      `UPDATE product_marketplace_prices
       SET selling_price_manual = false, updated_at = CURRENT_TIMESTAMP
       WHERE product_id = $1 AND marketplace = $2`,
      [pid, mp]
    );
    const recalc = await recalculateSellingPricesForProduct(pid, { marketplace: mp });
    return { productId: pid, strategyId: sid, marketplace: mp, recalculated: recalc };
  }

  await query(
    `UPDATE products
     SET pricing_strategy_id = $2, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [pid, sid]
  );

  if (sid != null) {
    await query(
      `UPDATE product_marketplace_prices
       SET selling_price_manual = false, updated_at = CURRENT_TIMESTAMP
       WHERE product_id = $1`,
      [pid]
    );
    const recalc = await recalculateSellingPricesForProduct(pid);
    return { productId: pid, strategyId: sid, recalculated: recalc };
  }

  return { productId: pid, strategyId: null, recalculated: null };
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

  // buyout_rate* обязательны: без них calculateMinPrice берёт дефолт 95% выкупа
  // и завышает чист.% — стратегия ошибочно оставляет цену на полу (как KN1037K).
  // Габариты ERP сюда НЕ берём: без mp-упаковки L×W×H занижают литры WB и логистику
  // относительно calculation_details (volume_weight), снова «залипая» на минимуме.
  const prodRes = await query(
    `SELECT id, cost, additional_expenses, organization_id, profile_id, pricing_strategy_id,
            min_profit_ozon, min_profit_wb, min_profit_ym, min_price AS product_min_price,
            buyout_rate, buyout_rate_ozon, buyout_rate_wb, buyout_rate_ym
     FROM products WHERE id = $1`,
    [pid]
  );
  const product = prodRes.rows?.[0];
  if (!product) return { ok: false, error: 'product_not_found' };

  // Пол стратегии = тот же выбор FBS/FBO, что и при пуше мин. цен на МП.
  let pushSchemes = parsePricePushSettings(null);
  let taxProfile = null;
  let wbAcquiringPercent = null;
  let wbGemServicesPercent = null;
  let wbSppPercent = null;
  let ozonSppPercent = null;
  let ymSppPercent = null;
  try {
    const pref = await query(
      `SELECT price_push_settings FROM profiles WHERE id = $1 LIMIT 1`,
      [product.profile_id]
    );
    pushSchemes = parsePricePushSettings(pref.rows?.[0]?.price_push_settings);
  } catch {
    /* колонка/профиль могут отсутствовать — дефолт обеих схем */
  }
  try {
    if (product.organization_id != null) {
      const org = await query(
        `SELECT tax_system, vat FROM organizations WHERE id = $1 LIMIT 1`,
        [product.organization_id]
      );
      if (org.rows?.[0]) taxProfile = resolveOrganizationTaxProfile(org.rows[0]);
    }
  } catch {
    /* ignore */
  }
  try {
    // integrations.code = ozon|wildberries|yandex (колонки marketplace нет)
    const integ = await query(
      `SELECT code, config
       FROM integrations
       WHERE type = 'marketplace'
         AND is_active = true
         AND (profile_id = $1 OR organization_id = $2)
         AND LOWER(TRIM(code)) IN ('wb','wildberries','ozon','ym','yandex')`,
      [product.profile_id, product.organization_id]
    );
    for (const row of integ.rows || []) {
      const mp = String(row.code || '').toLowerCase();
      const cfg =
        row.config && typeof row.config === 'object'
          ? row.config
          : typeof row.config === 'string'
            ? JSON.parse(row.config || '{}')
            : {};
      if (mp === 'wb' || mp === 'wildberries') {
        wbAcquiringPercent =
          cfg.acquiring_percent != null ? Number(cfg.acquiring_percent) : null;
        wbGemServicesPercent =
          cfg.gem_services_percent != null ? Number(cfg.gem_services_percent) : null;
        wbSppPercent =
          cfg.spp_percent != null
            ? Number(cfg.spp_percent)
            : cfg.sppPercent != null
              ? Number(cfg.sppPercent)
              : null;
      } else if (mp === 'ozon') {
        ozonSppPercent =
          cfg.spp_percent != null
            ? Number(cfg.spp_percent)
            : cfg.sppPercent != null
              ? Number(cfg.sppPercent)
              : null;
      } else if (mp === 'ym' || mp === 'yandex') {
        ymSppPercent =
          cfg.spp_percent != null
            ? Number(cfg.spp_percent)
            : cfg.sppPercent != null
              ? Number(cfg.sppPercent)
              : null;
      }
    }
  } catch {
    /* integrations optional — калькулятор/fallback и так справятся */
  }

  let floorsRes;
  try {
    floorsRes = await query(
      `SELECT marketplace, min_price, min_price_fbs, min_price_fbo, selling_price, max_price,
              price_before_discount, COALESCE(selling_price_manual, false) AS selling_price_manual,
              calculation_details, calculation_details_fbs, calculation_details_fbo
       FROM product_marketplace_prices
       WHERE product_id = $1
         AND (
           (min_price IS NOT NULL AND min_price > 0)
           OR (min_price_fbs IS NOT NULL AND min_price_fbs > 0)
           OR (min_price_fbo IS NOT NULL AND min_price_fbo > 0)
         )
         ${marketplace ? 'AND marketplace = $2' : ''}`,
      marketplace ? [pid, String(marketplace).toLowerCase()] : [pid]
    );
  } catch (colErr) {
    const msg = String(colErr.message || '');
    if (
      !msg.includes('max_price') &&
      !msg.includes('price_before_discount') &&
      !msg.includes('min_price_fbs') &&
      !msg.includes('min_price_fbo') &&
      !msg.includes('selling_price_manual') &&
      !msg.includes('calculation_details')
    ) {
      throw colErr;
    }
    floorsRes = await query(
      `SELECT marketplace, min_price, selling_price,
              COALESCE(selling_price_manual, false) AS selling_price_manual,
              calculation_details
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
    const floorResolved = resolvePushFloorForMarketplace(row, mp, pushSchemes);
    const floor =
      floorResolved != null
        ? floorResolved
        : floorRub(row.min_price) ?? floorRub(row.min_price_fbs) ?? floorRub(row.min_price_fbo);
    if (floor == null) continue;
    const previousSelling = row.selling_price != null ? Number(row.selling_price) : null;
    const previousBefore =
      row.price_before_discount != null && Number.isFinite(Number(row.price_before_discount))
        ? Number(row.price_before_discount)
        : null;
    const floorRounded = floorRub(floor);
    const isManual = row.selling_price_manual === true;

    // Ручная цена на МП важнее любой стратегии (в т.ч. бренда/категории/дефолта).
    if (isManual) {
      const finalSelling =
        previousSelling != null && Number.isFinite(previousSelling)
          ? floorRub(previousSelling)
          : null;
      const manualBelowFloor =
        finalSelling != null && floorRounded != null && finalSelling < floorRounded;
      const details = {
        mode: 'manual',
        reason: 'manual_selling_price',
        sellingPrice: finalSelling,
        floor: floorRounded,
        manualBelowFloor,
      };
      await query(
        `UPDATE product_marketplace_prices
         SET pricing_strategy_id = NULL,
             strategy_details = $1::jsonb,
             updated_at = CURRENT_TIMESTAMP
         WHERE product_id = $2 AND marketplace = $3`,
        [JSON.stringify(details), pid, mp]
      );
      const reason = formatPriceChangeReason({ source: 'manual', meta: details });
      await logMarketplacePriceChange({
        productId: pid,
        marketplace: mp,
        source: 'manual',
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
        mode: 'manual',
        reason,
        changed: false,
      });
      continue;
    }

    const strategy = await resolveStrategyRow({
      productId: pid,
      profileId: product.profile_id,
      strategyId: null,
      marketplace: mp,
    });

    if (!strategy) {
      // Нет стратегии: не затираем ручную цену; иначе подставляем пол.
      let sellingPrice =
        previousSelling != null && Number.isFinite(previousSelling) && previousSelling > 0
          ? floorRub(previousSelling)
          : floorRounded;
      if (sellingPrice != null && floorRounded != null && sellingPrice < floorRounded) {
        sellingPrice = floorRounded;
      }
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
      const manualBelowFloor =
        cur?.is_manual === true &&
        finalSelling != null &&
        floorRounded != null &&
        finalSelling < floorRounded;
      const details =
        cur?.is_manual === true
          ? {
              mode: 'manual',
              reason: 'manual_selling_price',
              sellingPrice: finalSelling,
              floor: floorRounded,
              manualBelowFloor,
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

    let targetMarginPrice = null;
    if (mode === 'target_margin' || mode === 'hybrid') {
      const pushFbs = pushSchemes?.pushFbs !== false;
      const pushFbo = pushSchemes?.pushFbo !== false;
      let scheme = mp === 'wb' ? 'FBO' : 'FBS';
      let calculator =
        row.calculation_details ||
        row.calculation_details_fbs ||
        row.calculation_details_fbo ||
        null;
      if (mp === 'wb') {
        if (pushFbo && row.calculation_details_fbo) {
          scheme = 'FBO';
          calculator = row.calculation_details_fbo;
        } else if (pushFbs && row.calculation_details_fbs) {
          scheme = 'FBS';
          calculator = row.calculation_details_fbs;
        }
      } else if (pushFbs && row.calculation_details_fbs) {
        scheme = 'FBS';
        calculator = row.calculation_details_fbs;
      } else if (pushFbo && row.calculation_details_fbo) {
        scheme = 'FBO';
        calculator = row.calculation_details_fbo;
      }
      const spp =
        mp === 'wb' ? wbSppPercent : mp === 'ozon' ? ozonSppPercent : mp === 'ym' ? ymSppPercent : null;
      targetMarginPrice = resolveTargetMarginPrice({
        marginPercent: cfg.target_margin_percent,
        floor: floorRounded,
        cost: product.cost,
        additionalExpenses: product.additional_expenses,
        calculator,
        marketplace: mp,
        product,
        wbAcquiringPercent,
        wbGemServicesPercent,
        taxProfile,
        scheme,
        sppPercent: spp,
      });
    }

    // Несколько проходов: «макс. изменение за раз» иначе оставляет WB/др. МП
    // на полпути к целевой марже после одного сохранения стратегии.
    let computed = null;
    let walkFrom = previousSelling;
    const walkSteps = [];
    const maxWalk = 12;
    for (let walk = 0; walk < maxWalk; walk++) {
      computed = computeSellingPriceFromInputs({
        mode,
        config,
        floor,
        cost: product.cost,
        competitorPrices: comp.prices || [],
        velocity,
        previousSelling: walkFrom,
        marketplace: mp,
        ceiling: row.max_price,
        targetMarginPrice,
      });
      if (Array.isArray(computed?.details?.steps)) {
        walkSteps.push(...computed.details.steps);
      }
      const nextPrice = computed?.sellingPrice;
      if (
        nextPrice == null ||
        sameMoneyLocal(walkFrom, nextPrice) ||
        computed.heldByBand === true ||
        computed.cappedByCeiling === true
      ) {
        break;
      }
      walkFrom = nextPrice;
    }

    const details = {
      ...(computed?.details || {}),
      steps: walkSteps.length ? walkSteps : computed?.details?.steps,
      walkPasses: Math.min(maxWalk, walkSteps.filter((s) => s?.step === 'target_margin' || s?.step === 'max_change').length || 1),
      strategyId: Number(strategy.id),
      strategyName: strategy.name,
      strategySource: strategy._source || null,
      sellingPrice: computed.sellingPrice,
      floor: computed.floor,
      ceiling: computed.ceiling,
      competitorsCount: (comp.prices || []).length,
      competitorSkip: comp.skipped ? comp.reason : null,
      heldByBand: computed.heldByBand === true,
      cappedByCeiling: computed.cappedByCeiling === true,
      ceilingBelowFloor: computed.ceilingBelowFloor === true,
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
      ceilingBelowFloor: computed.ceilingBelowFloor === true,
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

  return { ok: true, productId: pid, results };
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
    try {
      const r = await query(
        `SELECT ps.*,
                (
                  SELECT count(*)::int FROM products p
                  WHERE p.pricing_strategy_id = ps.id
                    AND (p.profile_id = $1 OR p.profile_id IS NULL)
                ) AS products_count,
                (
                  SELECT count(*)::int FROM pricing_strategy_rules r
                  WHERE r.strategy_id = ps.id AND r.is_active = true
                ) AS rules_count
         FROM pricing_strategies ps
         WHERE ps.profile_id = $1 OR ps.profile_id IS NULL
         ORDER BY ps.name ASC`,
        [profileId]
      );
      return r.rows || [];
    } catch (err) {
      if (String(err?.code) !== '42P01') throw err;
      const r = await query(
        `SELECT ps.*,
                (
                  SELECT count(*)::int FROM products p
                  WHERE p.pricing_strategy_id = ps.id
                    AND (p.profile_id = $1 OR p.profile_id IS NULL)
                ) AS products_count,
                0 AS rules_count
         FROM pricing_strategies ps
         WHERE ps.profile_id = $1 OR ps.profile_id IS NULL
         ORDER BY ps.name ASC`,
        [profileId]
      );
      return r.rows || [];
    }
  }
  const r = await query(
    `SELECT ps.*,
            (SELECT count(*)::int FROM products p WHERE p.pricing_strategy_id = ps.id) AS products_count
     FROM pricing_strategies ps
     ORDER BY ps.profile_id NULLS FIRST, ps.name ASC`
  );
  return r.rows || [];
}

export async function getStrategy(id) {
  const r = await query(`SELECT * FROM pricing_strategies WHERE id = $1`, [id]);
  return r.rows?.[0] || null;
}

/**
 * Назначения стратегии: дефолт кабинета + список областей (товар/бренд/категория ± МП).
 * Товар без МП также отражается из products.pricing_strategy_id.
 */
export async function getStrategyAssignments(strategyId, { profileId = null } = {}) {
  const sid = Number(strategyId);
  if (!Number.isFinite(sid) || sid < 1) throw new Error('Некорректный id стратегии');
  const st = await getStrategy(sid);
  if (!st) return null;
  if (
    profileId != null &&
    st.profile_id != null &&
    Number(st.profile_id) !== Number(profileId)
  ) {
    throw new Error('Стратегия другого кабинета');
  }
  const pid = st.profile_id != null ? Number(st.profile_id) : Number(profileId);

  const items = [];
  const seen = new Set();

  try {
    const rulesRes = await query(
      `SELECT r.*,
              CASE r.scope_type
                WHEN 'product' THEN (SELECT p.name FROM products p WHERE p.id = r.scope_id)
                WHEN 'brand' THEN (SELECT b.name FROM brands b WHERE b.id = r.scope_id)
                WHEN 'category' THEN (SELECT uc.name FROM user_categories uc WHERE uc.id = r.scope_id)
                ELSE NULL
              END AS scope_name
       FROM pricing_strategy_rules r
       WHERE r.strategy_id = $1 AND r.is_active = true
       ORDER BY r.id ASC`,
      [sid]
    );
    for (const row of rulesRes.rows || []) {
      const mp = normalizeStrategyMarketplace(row.marketplace);
      const key = `${row.scope_type}:${row.scope_id ?? ''}:${mp || ''}`;
      seen.add(key);
      items.push({
        id: row.id,
        scopeType: row.scope_type,
        scopeId: row.scope_id != null ? Number(row.scope_id) : null,
        scopeName: row.scope_name || null,
        marketplace: mp,
        source: 'rule',
      });
    }
  } catch (err) {
    if (String(err?.code) !== '42P01') throw err;
  }

  if (Number.isFinite(pid) && pid > 0) {
    const prodRes = await query(
      `SELECT id, name FROM products
       WHERE pricing_strategy_id = $1 AND profile_id = $2
       ORDER BY name ASC NULLS LAST, id ASC
       LIMIT 500`,
      [sid, pid]
    );
    for (const row of prodRes.rows || []) {
      const key = `product:${row.id}:`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({
        id: null,
        scopeType: 'product',
        scopeId: Number(row.id),
        scopeName: row.name || null,
        marketplace: null,
        source: 'product_column',
      });
    }
  }

  return {
    strategyId: sid,
    isDefault: st.is_default === true,
    items,
  };
}

/**
 * Полная замена назначений стратегии (из модалки «Где применяется»).
 * items: [{ scopeType, scopeId?, marketplace? }]
 */
export async function replaceStrategyAssignments(
  strategyId,
  { isDefault = false, items = [] } = {},
  { profileId = null } = {}
) {
  const sid = Number(strategyId);
  if (!Number.isFinite(sid) || sid < 1) throw new Error('Некорректный id стратегии');
  const st = await getStrategy(sid);
  if (!st) throw new Error('Стратегия не найдена');
  const pid =
    st.profile_id != null
      ? Number(st.profile_id)
      : profileId != null
        ? Number(profileId)
        : null;
  if (!Number.isFinite(pid) || pid < 1) throw new Error('Нет профиля стратегии');
  if (profileId != null && Number(profileId) !== pid) {
    throw new Error('Стратегия другого кабинета');
  }

  const wantDefault = isDefault === true || isDefault === 'true' || isDefault === 1;
  if (wantDefault) {
    await setProfileDefaultStrategy(pid, sid);
  } else if (st.is_default === true) {
    await query(
      `UPDATE pricing_strategies SET is_default = false, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [sid]
    );
  }

  const normalized = [];
  const productAllMpIds = new Set();
  for (const raw of Array.isArray(items) ? items : []) {
    const scopeType = String(raw.scopeType || raw.scope_type || '')
      .trim()
      .toLowerCase();
    if (!['product', 'brand', 'category', 'profile'].includes(scopeType)) {
      throw new Error('scopeType: product | brand | category | profile');
    }
    let scopeId = null;
    if (scopeType === 'profile') {
      scopeId = null;
    } else {
      scopeId = Number(raw.scopeId ?? raw.scope_id);
      if (!Number.isFinite(scopeId) || scopeId < 1) {
        throw new Error(`Укажите ${scopeType}`);
      }
    }
    const mp = normalizeStrategyMarketplace(raw.marketplace);
    normalized.push({ scopeType, scopeId, marketplace: mp });
    if (scopeType === 'product' && mp == null) {
      productAllMpIds.add(scopeId);
    }
  }

  // Снимаем старые правила этой стратегии; чужие scope-конфликты разрулим через upsert
  try {
    await query(`DELETE FROM pricing_strategy_rules WHERE strategy_id = $1`, [sid]);
  } catch (err) {
    if (String(err?.code) !== '42P01') throw err;
  }

  for (const item of normalized) {
    await upsertStrategyRule({
      profileId: pid,
      strategyId: sid,
      scopeType: item.scopeType,
      scopeId: item.scopeId,
      marketplace: item.marketplace,
      isActive: true,
    });
  }

  // Колонка товара: только «товар / все МП»
  await query(
    `UPDATE products
     SET pricing_strategy_id = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE pricing_strategy_id = $1 AND profile_id = $2
       AND NOT (id = ANY($3::bigint[]))`,
    [sid, pid, [...productAllMpIds]]
  );
  if (productAllMpIds.size) {
    await query(
      `UPDATE products
       SET pricing_strategy_id = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = ANY($2::bigint[]) AND profile_id = $3`,
      [sid, [...productAllMpIds], pid]
    );
  }

  const assignmentsOut = await getStrategyAssignments(sid, { profileId: pid });
  const recalc = await recalculateSellingPricesForAssignmentScope({
    profileId: pid,
    strategyId: sid,
    items: normalized,
    isDefault: wantDefault,
  });
  return { ...assignmentsOut, recalculated: recalc };
}

/**
 * Товары, попадающие под назначения стратегии, + снять ручной флаг и пересчитать факт
 * (мин. цены не трогаем).
 */
async function listProductIdsForAssignmentScope(profileId, items, { isDefault = false } = {}) {
  const pid = Number(profileId);
  if (!Number.isFinite(pid) || pid < 1) return [];

  const productIds = new Set();
  const brandIds = new Set();
  const categoryIds = new Set();
  let wholeProfile = isDefault === true;

  for (const item of Array.isArray(items) ? items : []) {
    const scopeType = String(item.scopeType || item.scope_type || '')
      .trim()
      .toLowerCase();
    const scopeId = item.scopeId != null ? Number(item.scopeId) : Number(item.scope_id);
    if (scopeType === 'profile') {
      wholeProfile = true;
      continue;
    }
    if (!Number.isFinite(scopeId) || scopeId < 1) continue;
    if (scopeType === 'product') productIds.add(scopeId);
    else if (scopeType === 'brand') brandIds.add(scopeId);
    else if (scopeType === 'category') categoryIds.add(scopeId);
  }

  if (wholeProfile) {
    const r = await query(
      `SELECT id FROM products
       WHERE profile_id = $1
         AND COALESCE(is_archived, false) = false
       LIMIT 5000`,
      [pid]
    );
    for (const row of r.rows || []) productIds.add(Number(row.id));
    return [...productIds].filter((n) => Number.isFinite(n) && n > 0);
  }

  if (brandIds.size) {
    const r = await query(
      `SELECT id FROM products
       WHERE profile_id = $1
         AND brand_id = ANY($2::bigint[])
         AND COALESCE(is_archived, false) = false
       LIMIT 5000`,
      [pid, [...brandIds]]
    );
    for (const row of r.rows || []) productIds.add(Number(row.id));
  }
  if (categoryIds.size) {
    const r = await query(
      `SELECT id FROM products
       WHERE profile_id = $1
         AND user_category_id = ANY($2::bigint[])
         AND COALESCE(is_archived, false) = false
       LIMIT 5000`,
      [pid, [...categoryIds]]
    );
    for (const row of r.rows || []) productIds.add(Number(row.id));
  }

  return [...productIds].filter((n) => Number.isFinite(n) && n > 0);
}

/** Снять «ручной факт» и пересчитать продажные цены по области назначения. */
export async function recalculateSellingPricesForAssignmentScope({
  profileId,
  strategyId = null,
  items = [],
  isDefault = false,
  clearManual = true,
} = {}) {
  const productIds = await listProductIdsForAssignmentScope(profileId, items, { isDefault });
  if (!productIds.length) {
    return { ok: true, products: 0, changed: 0, errors: 0 };
  }

  // МП из правил: если все назначения «все МП» — пересчёт по всем; иначе только указанные.
  const mps = new Set();
  let anyAllMp = isDefault === true;
  for (const item of items || []) {
    const mp = normalizeStrategyMarketplace(item.marketplace);
    if (mp) mps.add(mp);
    else anyAllMp = true;
    if (String(item.scopeType || item.scope_type || '').toLowerCase() === 'profile' && !mp) {
      anyAllMp = true;
    }
  }
  const marketplaces = anyAllMp || mps.size === 0 ? [null] : [...mps];

  if (clearManual) {
    try {
      if (anyAllMp || mps.size === 0) {
        await query(
          `UPDATE product_marketplace_prices
           SET selling_price_manual = false, updated_at = CURRENT_TIMESTAMP
           WHERE product_id = ANY($1::bigint[])
             AND COALESCE(selling_price_manual, false) = true`,
          [productIds]
        );
      } else {
        await query(
          `UPDATE product_marketplace_prices
           SET selling_price_manual = false, updated_at = CURRENT_TIMESTAMP
           WHERE product_id = ANY($1::bigint[])
             AND marketplace = ANY($2::text[])
             AND COALESCE(selling_price_manual, false) = true`,
          [productIds, [...mps]]
        );
      }
    } catch (err) {
      if (!String(err?.message || '').includes('selling_price_manual')) throw err;
    }
  }

  let changed = 0;
  let errors = 0;
  const concurrency = 4;
  for (let i = 0; i < productIds.length; i += concurrency) {
    const chunk = productIds.slice(i, i + concurrency);
    const results = await Promise.all(
      chunk.map(async (productId) => {
        try {
          let anyChanged = false;
          for (const mp of marketplaces) {
            const r = await recalculateSellingPricesForProduct(productId, {
              marketplace: mp,
            });
            if (r?.ok && (r.results || []).some((x) => x.changed)) anyChanged = true;
          }
          return { ok: true, changed: anyChanged };
        } catch (e) {
          console.warn('[pricingStrategy] recalc after assign failed', {
            productId,
            strategyId,
            message: e?.message || e,
          });
          return { ok: false };
        }
      })
    );
    for (const r of results) {
      if (!r.ok) errors += 1;
      else if (r.changed) changed += 1;
    }
  }

  return {
    ok: true,
    products: productIds.length,
    changed,
    errors,
    strategyId: strategyId != null ? Number(strategyId) : null,
  };
}

export async function createStrategy(data, { profileId = null } = {}) {
  const name = String(data.name || '').trim();
  if (!name) throw new Error('Укажите название стратегии');
  const mode = PRICING_STRATEGY_MODES.includes(data.mode) ? data.mode : 'hybrid';
  const config = mergeConfig(mode, data.config);
  const pid = data.profile_id ?? data.profileId ?? profileId;

  const r = await query(
    `INSERT INTO pricing_strategies (profile_id, name, description, is_active, is_default, mode, config)
     VALUES ($1, $2, $3, $4, false, $5, $6::jsonb)
     RETURNING *`,
    [
      pid,
      name,
      data.description || null,
      data.is_active !== false && data.isActive !== false,
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
  const r = await query(
    `UPDATE pricing_strategies SET
       name = COALESCE($2, name),
       description = COALESCE($3, description),
       is_active = COALESCE($4, is_active),
       mode = $5,
       config = $6::jsonb,
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

export async function upsertStrategyRule({
  profileId,
  strategyId,
  scopeType,
  scopeId = null,
  marketplace = null,
  isActive = true,
}) {
  const pid = Number(profileId);
  const sid = Number(strategyId);
  const scope = String(scopeType || '').trim().toLowerCase();
  if (!Number.isFinite(pid) || pid < 1) throw new Error('Некорректный профиль');
  if (!Number.isFinite(sid) || sid < 1) throw new Error('Некорректная стратегия');
  if (!['product', 'brand', 'category', 'profile'].includes(scope)) {
    throw new Error('scopeType: product | brand | category | profile');
  }
  let scopeIdNum = null;
  if (scope === 'profile') {
    scopeIdNum = null;
  } else {
    scopeIdNum = Number(scopeId);
    if (!Number.isFinite(scopeIdNum) || scopeIdNum < 1) {
      throw new Error('Укажите scopeId');
    }
  }
  const mp = normalizeStrategyMarketplace(marketplace);

  const st = await query(
    `SELECT id, profile_id, is_active FROM pricing_strategies WHERE id = $1`,
    [sid]
  );
  const strategy = st.rows?.[0];
  if (!strategy) throw new Error('Стратегия не найдена');
  if (strategy.is_active === false) throw new Error('Стратегия неактивна');
  if (strategy.profile_id != null && Number(strategy.profile_id) !== pid) {
    throw new Error('Стратегия другого кабинета');
  }

  const r = await query(
    `INSERT INTO pricing_strategy_rules
       (profile_id, strategy_id, scope_type, scope_id, marketplace, is_active, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
     ON CONFLICT (profile_id, scope_type, scope_id, marketplace)
     DO UPDATE SET
       strategy_id = EXCLUDED.strategy_id,
       is_active = EXCLUDED.is_active,
       updated_at = CURRENT_TIMESTAMP
     RETURNING *`,
    [pid, sid, scope, scopeIdNum, mp, isActive !== false]
  );
  return r.rows?.[0] || null;
}

export async function listStrategyRules({ profileId } = {}) {
  const pid = Number(profileId);
  if (!Number.isFinite(pid) || pid < 1) return [];
  try {
    const r = await query(
      `SELECT r.*,
              ps.name AS strategy_name,
              ps.mode AS strategy_mode,
              CASE r.scope_type
                WHEN 'product' THEN (SELECT p.name FROM products p WHERE p.id = r.scope_id)
                WHEN 'brand' THEN (SELECT b.name FROM brands b WHERE b.id = r.scope_id)
                WHEN 'category' THEN (SELECT uc.name FROM user_categories uc WHERE uc.id = r.scope_id)
                ELSE NULL
              END AS scope_name
       FROM pricing_strategy_rules r
       JOIN pricing_strategies ps ON ps.id = r.strategy_id
       WHERE r.profile_id = $1
       ORDER BY
         CASE r.scope_type
           WHEN 'product' THEN 1
           WHEN 'brand' THEN 2
           WHEN 'category' THEN 3
           ELSE 4
         END,
         r.marketplace NULLS FIRST,
         r.id DESC`,
      [pid]
    );
    return r.rows || [];
  } catch (err) {
    if (String(err?.code) === '42P01') return [];
    throw err;
  }
}

export async function deleteStrategyRule(ruleId, { profileId = null } = {}) {
  const id = Number(ruleId);
  if (!Number.isFinite(id) || id < 1) throw new Error('Некорректный id правила');
  const params = [id];
  let sql = `DELETE FROM pricing_strategy_rules WHERE id = $1`;
  if (profileId != null && Number.isFinite(Number(profileId))) {
    params.push(Number(profileId));
    sql += ` AND profile_id = $2`;
  }
  sql += ` RETURNING id`;
  const r = await query(sql, params);
  return (r.rowCount || 0) > 0;
}

export async function setProfileDefaultStrategy(profileId, strategyId) {
  const pid = Number(profileId);
  if (!Number.isFinite(pid) || pid < 1) throw new Error('Некорректный профиль');
  await query(
    `UPDATE pricing_strategies SET is_default = false, updated_at = CURRENT_TIMESTAMP
     WHERE profile_id = $1 AND is_default = true`,
    [pid]
  );
  if (strategyId == null || strategyId === '' || strategyId === 'null') {
    return getProfilePricingSettings(pid);
  }
  const sid = Number(strategyId);
  if (!Number.isFinite(sid) || sid < 1) throw new Error('Некорректная стратегия');
  const r = await query(
    `UPDATE pricing_strategies
     SET is_default = true, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND profile_id = $2 AND is_active = true
     RETURNING id`,
    [sid, pid]
  );
  if (!r.rows?.[0]) throw new Error('Стратегия не найдена или неактивна');
  return getProfilePricingSettings(pid);
}

export async function ensureDefaultStrategies(profileId) {
  if (profileId == null) return [];
  try {
    await query(
      `UPDATE organizations SET pricing_strategy_id = NULL
       WHERE profile_id = $1 AND pricing_strategy_id IS NOT NULL`,
      [profileId]
    );
  } catch {
    /* колонки могут отсутствовать на старых схемах */
  }
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
      is_default: false,
    },
    {
      name: 'Целевая маржа',
      mode: 'target_margin',
      description: 'Чистая маржа % от цены через калькулятор МП, не ниже минимума.',
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
  resolveTargetMarginPrice,
  recalculateSellingPricesForProduct,
  resolveStrategyRow,
  normalizeStrategyMarketplace,
  rulePriority,
  listStrategies,
  getStrategy,
  getStrategyAssignments,
  replaceStrategyAssignments,
  createStrategy,
  updateStrategy,
  deleteStrategy,
  ensureDefaultStrategies,
  getProfilePricingSettings,
  setProfilePricingStrategiesEnabled,
  setProfileDefaultStrategy,
  upsertStrategyRule,
  listStrategyRules,
  deleteStrategyRule,
  assignProductPricingStrategy,
  clearProductPricingStrategy,
  recalculateSellingPricesForAssignmentScope,
};
