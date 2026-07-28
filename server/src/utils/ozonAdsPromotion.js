/**
 * Рекламный % (ДРР) Ozon для калькулятора мин. цены.
 */

/** Нормализация: 0.05 → 5%, 5 → 5%, «2,5» → 2.5. */
export function normalizeOzonAdsPercent(raw) {
  if (raw == null || raw === '') return null;
  const n =
    typeof raw === 'number'
      ? raw
      : Number(String(raw).trim().replace(/\s/g, '').replace(',', '.'));
  if (!Number.isFinite(n) || n < 0) return null;
  if (n > 0 && n < 1) return Math.round(n * 10000) / 100;
  return Math.round(n * 100) / 100;
}

/**
 * ДРР из расхода и выручки. При выручке ниже порога — null (ненадёжно).
 */
export function computeDrrPercent(spend, revenue, { minRevenue = 500 } = {}) {
  const s = Number(spend) || 0;
  const r = Number(revenue) || 0;
  if (s <= 0) return 0;
  if (r < minRevenue) return null;
  return normalizeOzonAdsPercent((s / r) * 100);
}

export function applyOzonAdsPromotion(calculator, adsPercent, source = 'ads') {
  if (!calculator || typeof calculator !== 'object') return calculator;
  const pct = normalizeOzonAdsPercent(adsPercent);
  if (pct == null) return calculator;
  return {
    ...calculator,
    ads_promotion_percent: pct,
    ads_promotion_source: source,
  };
}
