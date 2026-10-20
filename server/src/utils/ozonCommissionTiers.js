/**
 * Ценовые пороги комиссии Ozon (FBO/FBS с 28.08.2026):
 * ≤100 ₽ → 17%, 101–300 ₽ → 23%, свыше 300 ₽ → ставка категории (из API при price>300).
 */

export const OZON_COMMISSION_TIER_100 = Number(process.env.OZON_COMMISSION_TIER_100 || 100);
export const OZON_COMMISSION_TIER_300 = Number(process.env.OZON_COMMISSION_TIER_300 || 300);
export const OZON_COMMISSION_PERCENT_LE100 = Number(process.env.OZON_COMMISSION_PERCENT_LE100 || 17);
export const OZON_COMMISSION_PERCENT_LE300 = Number(process.env.OZON_COMMISSION_PERCENT_LE300 || 23);

/**
 * @param {number|string|null|undefined} price
 * @returns {'le100'|'le300'|'gt300'|null}
 */
export function ozonCommissionPriceTier(price) {
  const n = Number(price);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n <= OZON_COMMISSION_TIER_100) return 'le100';
  if (n <= OZON_COMMISSION_TIER_300) return 'le300';
  return 'gt300';
}

/**
 * @param {'le100'|'le300'|'gt300'|null} tier
 * @returns {string}
 */
export function ozonCommissionTierLabel(tier) {
  if (tier === 'le100') return `до ${OZON_COMMISSION_TIER_100} ₽`;
  if (tier === 'le300') {
    return `${OZON_COMMISSION_TIER_100 + 0.01}–${OZON_COMMISSION_TIER_300} ₽`;
  }
  if (tier === 'gt300') return `свыше ${OZON_COMMISSION_TIER_300} ₽`;
  return '';
}

function finiteOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Округление % комиссии для группировки моды (1 знак). */
export function roundOzonCommissionPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 10) / 10;
}

/**
 * Мода массива процентов.
 * @param {number[]} values
 * @returns {number|null}
 */
export function modeOfOzonCommissionPercents(values) {
  const counts = new Map();
  for (const raw of values || []) {
    const k = roundOzonCommissionPercent(raw);
    if (k == null) continue;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  let best = null;
  let bestCount = 0;
  for (const [k, c] of counts) {
    if (c > bestCount || (c === bestCount && (best == null || k > best))) {
      best = k;
      bestCount = c;
    }
  }
  return best;
}

/**
 * Выучить ставки ≤100 / 101–300 из сэмплов API.
 * @param {Array<{ price: number, percentFbs?: number|null, percentFbo?: number|null }>} samples
 * @param {{ minSamples?: number }} [opts]
 * @returns {{ le100: number|null, le300: number|null, samplesLe100: number, samplesLe300: number }}
 */
export function computeLearnedOzonLowTierRates(samples, opts = {}) {
  const minSamples = Math.max(1, Number(opts.minSamples) || 3);
  const le100 = [];
  const le300 = [];
  for (const s of samples || []) {
    const price = Number(s?.price);
    const tier = ozonCommissionPriceTier(price);
    const pct =
      finiteOrNull(s?.percentFbs) ??
      finiteOrNull(s?.percentFbo) ??
      finiteOrNull(s?.percent);
    if (pct == null || pct <= 0) continue;
    if (tier === 'le100') le100.push(pct);
    else if (tier === 'le300') le300.push(pct);
  }
  return {
    le100: le100.length >= minSamples ? modeOfOzonCommissionPercents(le100) : null,
    le300: le300.length >= minSamples ? modeOfOzonCommissionPercents(le300) : null,
    samplesLe100: le100.length,
    samplesLe300: le300.length,
  };
}

/**
 * Слить новые выученные ставки с предыдущими (не затирать null-ом).
 * @param {{ le100?: number, le300?: number }|null|undefined} prev
 * @param {{ le100?: number|null, le300?: number|null }|null|undefined} learned
 */
export function mergeLearnedOzonLowTierRates(prev, learned) {
  return {
    le100: finiteOrNull(learned?.le100) ?? finiteOrNull(prev?.le100) ?? OZON_COMMISSION_PERCENT_LE100,
    le300: finiteOrNull(learned?.le300) ?? finiteOrNull(prev?.le300) ?? OZON_COMMISSION_PERCENT_LE300,
  };
}

/**
 * @param {object} calculator
 * @param {{ le100?: number, le300?: number }|null|undefined} rates
 */
export function attachOzonTierRatesToCalculator(calculator, rates) {
  if (!calculator || typeof calculator !== 'object' || !rates) return calculator;
  const le100 = finiteOrNull(rates.le100);
  const le300 = finiteOrNull(rates.le300);
  if (le100 == null && le300 == null) return calculator;
  return {
    ...calculator,
    tier_rates: {
      ...(calculator.tier_rates && typeof calculator.tier_rates === 'object' ? calculator.tier_rates : {}),
      ...(le100 != null ? { le100 } : {}),
      ...(le300 != null ? { le300 } : {}),
      source: rates.source || calculator.tier_rates?.source || 'learned',
    },
  };
}

/**
 * Контекст ставок из калькулятора / API Ozon.
 * @param {object|null|undefined} calculator
 * @param {'FBS'|'FBO'|null|undefined} [scheme]
 */
export function extractOzonCommissionTierContext(calculator, scheme = 'FBS') {
  const want = String(scheme || 'FBS').toUpperCase() === 'FBO' ? 'FBO' : 'FBS';
  const pack =
    want === 'FBO'
      ? calculator?.commissions?.FBO || calculator?.commissions?.FBS
      : calculator?.commissions?.FBS || calculator?.commissions?.FBO;
  const apiPercent = finiteOrNull(pack?.percent);
  const percentAbove300 =
    finiteOrNull(pack?.percent_above_300) ??
    finiteOrNull(calculator?.percent_above_300) ??
    finiteOrNull(
      want === 'FBO'
        ? calculator?.commissions?.FBO?.percent_above_300
        : calculator?.commissions?.FBS?.percent_above_300
    );
  const apiPrice =
    finiteOrNull(calculator?.commission_price_basis) ??
    finiteOrNull(calculator?.price) ??
    finiteOrNull(calculator?.marketing_seller_price);
  const tierRates = calculator?.tier_rates && typeof calculator.tier_rates === 'object'
    ? {
        le100: finiteOrNull(calculator.tier_rates.le100),
        le300: finiteOrNull(calculator.tier_rates.le300),
      }
    : null;
  return { apiPercent, apiPrice, percentAbove300, scheme: want, tierRates };
}

/**
 * Процент комиссии продажи Ozon для заданной цены.
 * @returns {number|null} проценты (например 23), null если для >300 нет категориальной ставки
 */
export function resolveOzonSalesCommissionPercent(price, ctx = {}) {
  const tier = ozonCommissionPriceTier(price);
  if (!tier) return null;

  const apiPercent = finiteOrNull(ctx.apiPercent);
  const apiPrice = finiteOrNull(ctx.apiPrice);
  const percentAbove300 = finiteOrNull(ctx.percentAbove300);
  const apiTier = apiPrice != null ? ozonCommissionPriceTier(apiPrice) : null;
  const fallbackLe100 =
    finiteOrNull(ctx.tierRates?.le100) ?? OZON_COMMISSION_PERCENT_LE100;
  const fallbackLe300 =
    finiteOrNull(ctx.tierRates?.le300) ?? OZON_COMMISSION_PERCENT_LE300;

  if (tier === 'le100') {
    if (apiTier === 'le100' && apiPercent != null && apiPercent > 0) return apiPercent;
    return fallbackLe100;
  }
  if (tier === 'le300') {
    if (apiTier === 'le300' && apiPercent != null && apiPercent > 0) return apiPercent;
    return fallbackLe300;
  }

  // gt300: ставка категории из API (сам SKU или сосед с price>300)
  if (percentAbove300 != null && percentAbove300 > 0) return percentAbove300;
  if (apiTier === 'gt300' && apiPercent != null && apiPercent > 0) return apiPercent;
  // Дешёвый SKU: API отдал только mid/low тир — категориальную ставку не выдумываем
  if (apiTier === 'le100' || apiTier === 'le300') return null;
  // Legacy-кэш без commission_price_basis: percent считаем категориальным,
  // но не если это явная ставка дешёвого тира (17/23) — иначе «свыше 300» залипает на 23%.
  if (apiPercent != null && apiPercent > 0) {
    const rounded = roundOzonCommissionPercent(apiPercent);
    if (rounded === roundOzonCommissionPercent(fallbackLe100)) return null;
    if (rounded === roundOzonCommissionPercent(fallbackLe300)) return null;
    return apiPercent;
  }
  return null;
}

/**
 * Похожа ли ставка на фиксированный дешёвый тир (≤100 / 101–300), а не на категорию.
 * @param {number|null|undefined} percent
 * @param {{ le100?: number|null, le300?: number|null }|null|undefined} [tierRates]
 */
export function isOzonLowTierCommissionPercent(percent, tierRates = null) {
  const pct = roundOzonCommissionPercent(percent);
  if (pct == null) return false;
  const le100 =
    roundOzonCommissionPercent(tierRates?.le100) ??
    roundOzonCommissionPercent(OZON_COMMISSION_PERCENT_LE100);
  const le300 =
    roundOzonCommissionPercent(tierRates?.le300) ??
    roundOzonCommissionPercent(OZON_COMMISSION_PERCENT_LE300);
  return pct === le100 || pct === le300;
}

/**
 * Записать percent_above_300 в pack комиссии, если цена API >300.
 * @param {object} calculator
 */
export function applyOzonPercentAbove300FromOwnPrice(calculator) {
  if (!calculator?.commissions || typeof calculator.commissions !== 'object') return calculator;
  const apiPrice =
    finiteOrNull(calculator.commission_price_basis) ?? finiteOrNull(calculator.price);
  if (apiPrice == null || ozonCommissionPriceTier(apiPrice) !== 'gt300') return calculator;

  for (const key of ['FBS', 'FBO']) {
    const pack = calculator.commissions[key];
    if (!pack || typeof pack !== 'object') continue;
    const pct = finiteOrNull(pack.percent);
    if (pct == null || pct <= 0) continue;
    if (finiteOrNull(pack.percent_above_300) == null) {
      calculator.commissions[key] = { ...pack, percent_above_300: pct };
    }
  }
  return calculator;
}

/**
 * Подставить percent_above_300 из map по схеме, не затирая уже заданное.
 * @param {object} calculator
 * @param {{ FBS?: number|null, FBO?: number|null }|null|undefined} above300ByScheme
 */
export function mergeOzonPercentAbove300(calculator, above300ByScheme) {
  if (!calculator?.commissions || !above300ByScheme) return calculator;
  const next = { ...calculator, commissions: { ...calculator.commissions } };
  for (const key of ['FBS', 'FBO']) {
    const incoming = finiteOrNull(above300ByScheme[key]);
    if (incoming == null || incoming <= 0) continue;
    const pack = next.commissions[key];
    if (!pack || typeof pack !== 'object') {
      next.commissions[key] = { percent: incoming, percent_above_300: incoming, value: 0 };
      continue;
    }
    if (finiteOrNull(pack.percent_above_300) != null) continue;
    next.commissions[key] = { ...pack, percent_above_300: incoming };
  }
  return next;
}
