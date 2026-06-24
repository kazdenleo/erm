/**
 * «Продвижение бренда» Ozon: извлечение из ответа API и fallback из настроек бренда.
 */

const DIRECT_API_KEYS = [
  'brand_promotion_percent',
  'brand_promotion',
  'fbs_brand_promotion_percent',
  'fbs_brand_promotion',
  'sales_percent_fbs_brand_promotion',
];

/** Нормализация: 0.01 → 1%, 1 → 1%, 32 → 32%. */
export function normalizeOzonBrandPromotionPercent(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n > 0 && n < 1) return Math.round(n * 10000) / 100;
  return Math.round(n * 100) / 100;
}

/**
 * Ищет процент в ответе POST /v5/product/info/prices (item).
 * @returns {number|null} проценты (например 1 для 1%)
 */
export function extractOzonBrandPromotionPercent(item) {
  if (!item || typeof item !== 'object') return null;

  const pools = [item.commissions, item.price, item];
  for (const pool of pools) {
    if (!pool || typeof pool !== 'object') continue;
    for (const key of DIRECT_API_KEYS) {
      if (pool[key] == null || pool[key] === '') continue;
      const normalized = normalizeOzonBrandPromotionPercent(pool[key]);
      if (normalized != null) return normalized;
    }
  }

  if (item.commissions && typeof item.commissions === 'object') {
    for (const [key, value] of Object.entries(item.commissions)) {
      if (!/brand.*promot/i.test(key)) continue;
      if (value == null || value === '') continue;
      const normalized = normalizeOzonBrandPromotionPercent(value);
      if (normalized != null) return normalized;
    }
  }

  return null;
}

/**
 * Подставляет % продвижения бренда из настроек бренда (когда включено на бренде).
 * Имеет приоритет над отсутствующим или нулевым значением из API Ozon.
 *
 * @param {{ brand_promotion_percent?: number|null, brand_promotion_source?: string }} calculator
 * @param {number|null|undefined} brandPercent — из brands.ozon_brand_promotion_percent (только если enabled)
 */
export function applyOzonBrandPromotionFallback(calculator, brandPercent) {
  if (!calculator || typeof calculator !== 'object') return calculator;

  const fromBrand = normalizeOzonBrandPromotionPercent(brandPercent);
  if (fromBrand == null) return calculator;

  const existingRaw = calculator.brand_promotion_percent;
  const existingNum =
    existingRaw != null && existingRaw !== '' && !Number.isNaN(Number(existingRaw))
      ? Number(existingRaw)
      : null;

  // Явная настройка бренда перекрывает API, если там нет положительного процента
  if (existingNum != null && existingNum > 0 && existingNum !== fromBrand) {
    return calculator;
  }

  return {
    ...calculator,
    brand_promotion_percent: fromBrand,
    brand_promotion_source: 'brand',
  };
}

/**
 * Подставляет % из настроек бренда в сохранённые детали расчёта (для отображения в UI).
 */
export function enrichOzonCalculatorFromBrandSettings(calculator, { enabled, percent } = {}) {
  if (enabled !== true) return calculator;
  return applyOzonBrandPromotionFallback(calculator, percent);
}
