/**
 * Ценовые пороги комиссии Ozon (FBO/FBS с 28.08.2026).
 * Синхронно с server/src/utils/ozonCommissionTiers.js (без process.env на клиенте).
 */

export const OZON_COMMISSION_TIER_100 = 100;
export const OZON_COMMISSION_TIER_300 = 300;
export const OZON_COMMISSION_PERCENT_LE100 = 17;
export const OZON_COMMISSION_PERCENT_LE300 = 23;

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

/**
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
  const tierRates =
    calculator?.tier_rates && typeof calculator.tier_rates === 'object'
      ? {
          le100: finiteOrNull(calculator.tier_rates.le100),
          le300: finiteOrNull(calculator.tier_rates.le300),
        }
      : null;
  return { apiPercent, apiPrice, percentAbove300, scheme: want, tierRates };
}

/**
 * @returns {number|null}
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

  if (percentAbove300 != null && percentAbove300 > 0) return percentAbove300;
  if (apiTier === 'gt300' && apiPercent != null && apiPercent > 0) return apiPercent;
  if (apiTier === 'le100' || apiTier === 'le300') return null;
  if (apiPercent != null && apiPercent > 0) return apiPercent;
  return null;
}
