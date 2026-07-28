/**
 * Целевая чистая прибыль (₽) для расчёта мин. цены МП (синхронно с server).
 */

function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function resolveMarketplaceMinProfit(product, marketplace, fallback = 50) {
  if (!product) return fallback;
  const mp = String(marketplace || '').toLowerCase();
  let specific = null;
  if (mp === 'ozon') {
    specific = numOrNull(product.min_profit_ozon ?? product.minProfitOzon);
  } else if (mp === 'wb' || mp === 'wildberries') {
    specific = numOrNull(product.min_profit_wb ?? product.minProfitWb);
  } else if (mp === 'ym' || mp === 'yandex') {
    specific = numOrNull(product.min_profit_ym ?? product.minProfitYm);
  }
  if (specific != null && specific >= 0) return specific;
  const general = numOrNull(product.min_price ?? product.minPrice);
  if (general != null && general >= 0) return general;
  return fallback;
}

/** Мин. цена для частного клиента: себестоимость + доп. расходы + общая мин. наценка. */
export function privateClientMinPrice(product) {
  if (!product) return null;
  const cost = numOrNull(product.cost ?? product.price ?? product.base_price) ?? 0;
  const add = numOrNull(product.additional_expenses ?? product.additionalExpenses) ?? 0;
  const profit = numOrNull(product.min_price ?? product.minPrice);
  if (profit == null || profit < 0) return null;
  const total = cost + add + profit;
  return total > 0 ? Math.round(total) : null;
}
