/**
 * Процент выкупа для расчёта мин. цены: сначала по МП, иначе общий.
 * @returns {number|null} 0–100 или null, если не задан
 */
export function resolveMarketplaceBuyoutRate(product, marketplace) {
  if (!product) return null;
  const mp = String(marketplace || '').toLowerCase();
  let perMp = null;
  if (mp === 'ozon') {
    perMp = product.buyout_rate_ozon ?? product.buyoutRateOzon;
  } else if (mp === 'wb' || mp === 'wildberries') {
    perMp = product.buyout_rate_wb ?? product.buyoutRateWb;
  } else if (mp === 'ym' || mp === 'yandex' || mp === 'yandexmarket') {
    perMp = product.buyout_rate_ym ?? product.buyoutRateYm;
  }
  const raw = perMp != null && perMp !== '' ? perMp : product.buyout_rate;
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, n));
}
