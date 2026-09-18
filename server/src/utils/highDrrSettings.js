/**
 * Порог «высокого ДРР» и связанные флаги (profile.price_push_settings).
 */

export const HIGH_DRR_DEFAULT_PERCENT = 20;
export const HIGH_DRR_MIN = 0;
export const HIGH_DRR_MAX = 100;

export function clampHighDrrPercent(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(String(value).replace(',', '.'));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(HIGH_DRR_MAX, Math.max(HIGH_DRR_MIN, Math.round(n * 100) / 100));
}

export function isHighDrr(drrPercent, threshold) {
  const d = Number(drrPercent);
  const t = Number(threshold);
  if (!Number.isFinite(d) || !Number.isFinite(t) || t <= 0) return false;
  return d > t;
}
