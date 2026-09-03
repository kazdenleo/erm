/**
 * Процент выкупа для расчёта мин. цены: сначала по МП, иначе общий.
 * 0% считается «нет данных» (у новых SKU без продаж), не реальным выкупом.
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

  const pick = (v) => {
    if (v == null || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.max(0, Math.min(100, n));
  };

  const fromMp = pick(perMp);
  if (fromMp != null) return fromMp;
  const fromGeneral = pick(product.buyout_rate);
  if (fromGeneral != null) return fromGeneral;
  return 95;
}

/** Выкуп = delivered / (delivered + returned) * 100. */
export function computeBuyoutPercent(deliveredQty, returnedQty, minUnits = 3) {
  const d = Math.max(0, Number(deliveredQty) || 0);
  const r = Math.max(0, Number(returnedQty) || 0);
  const total = d + r;
  if (total < minUnits) return null;
  const pct = Math.max(0, Math.min(100, Math.round((d / total) * 100)));
  return pct > 0 ? pct : null;
}

/**
 * % выкупа по метрикам маркетплейса (как в ЛК: delivered / ordered).
 * @param {{ ordered?: number, delivered?: number, returns?: number, buyoutPercent?: number }} metrics
 * @param {number} [minUnits=3]
 * @returns {number|null}
 */
export function computeBuyoutFromMpAnalytics(metrics = {}, minUnits = 3) {
  const direct = Number(metrics.buyoutPercent);
  if (Number.isFinite(direct) && direct > 0 && direct <= 100) {
    return Math.round(direct);
  }

  const ordered = Math.max(0, Number(metrics.ordered) || 0);
  const delivered = Math.max(0, Number(metrics.delivered) || 0);
  const returns = Math.max(0, Number(metrics.returns) || 0);

  if (ordered >= minUnits && delivered > 0) {
    const pct = Math.max(0, Math.min(100, Math.round((delivered / ordered) * 100)));
    return pct > 0 ? pct : null;
  }
  if (delivered + returns >= minUnits && delivered > 0) {
    const pct = Math.max(0, Math.min(100, Math.round((delivered / (delivered + returns)) * 100)));
    return pct > 0 ? pct : null;
  }
  if (delivered >= minUnits && ordered === 0 && returns === 0) {
    return 100;
  }
  return null;
}
