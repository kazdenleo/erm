/**
 * Клиент: подстановка «Продвижение бренда» Ozon из настроек бренда в данные калькулятора.
 */

function normalizeOzonBrandPromotionPercent(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n > 0 && n < 1) return Math.round(n * 10000) / 100;
  return Math.round(n * 100) / 100;
}

function applyOzonBrandPromotionFallback(calculator, brandPercent) {
  if (!calculator || typeof calculator !== 'object') return calculator;

  const fromBrand = normalizeOzonBrandPromotionPercent(brandPercent);
  if (fromBrand == null) return calculator;

  const existingRaw = calculator.brand_promotion_percent;
  const existingNum =
    existingRaw != null && existingRaw !== '' && !Number.isNaN(Number(existingRaw))
      ? Number(existingRaw)
      : null;

  if (existingNum != null && existingNum > 0 && existingNum !== fromBrand) {
    return calculator;
  }

  return {
    ...calculator,
    brand_promotion_percent: fromBrand,
    brand_promotion_source: 'brand',
  };
}

export function resolveProductBrandOzonPromotion(product) {
  if (!product || typeof product !== 'object') return { enabled: false, percent: null };

  const enabled =
    product.brandOzonPromotionEnabled === true ||
    product.ozon_brand_promotion_enabled === true;

  const raw =
    product.brandOzonPromotionPercent ??
    product.ozon_brand_promotion_percent;

  const percent =
    raw != null && raw !== '' && !Number.isNaN(Number(raw)) ? Number(raw) : null;

  return { enabled, percent };
}

export function enrichOzonCalculatorFromProduct(calculator, product) {
  const { enabled, percent } = resolveProductBrandOzonPromotion(product);
  if (!enabled) return calculator;
  return applyOzonBrandPromotionFallback(calculator, percent);
}
