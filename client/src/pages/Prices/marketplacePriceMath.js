/** Связь: цена_МП = цена_до_скидки × (1 − скидка%/100) */

export function roundMoney(n) {
  return Math.round(Number(n) * 100) / 100;
}

export function formatMoneyInput(n) {
  if (n == null || n === '' || !Number.isFinite(Number(n))) return '';
  const r = roundMoney(n);
  return Number.isInteger(r) ? String(r) : String(r);
}

export function parseMoneyInput(raw) {
  if (raw == null || String(raw).trim() === '') return null;
  const n = parseFloat(String(raw).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

export function priceBeforeFromActualAndPercent(actual, percent) {
  const a = Number(actual);
  const p = Number(percent);
  if (!Number.isFinite(a) || a <= 0 || !Number.isFinite(p) || p >= 100) return null;
  return roundMoney(a / (1 - p / 100));
}

export function percentFromActualAndBefore(actual, before) {
  const a = Number(actual);
  const b = Number(before);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= 0) return null;
  return roundMoney((1 - a / b) * 100);
}

export function actualFromBeforeAndPercent(before, percent) {
  const b = Number(before);
  const p = Number(percent);
  if (!Number.isFinite(b) || b <= 0 || !Number.isFinite(p) || p >= 100) return null;
  return roundMoney(b * (1 - p / 100));
}

export function getMarketplacePricePack(product, marketplace) {
  const mp = product?.marketplacePrices?.[marketplace] || {};
  return {
    sellingPrice: mp.sellingPrice ?? mp.selling_price ?? null,
    priceBeforeDiscount: mp.priceBeforeDiscount ?? mp.price_before_discount ?? null,
    discountPercent: mp.discountPercent ?? mp.discount_percent ?? null,
    sellingPriceManual: mp.sellingPriceManual === true || mp.selling_price_manual === true,
    maxPrice: mp.maxPrice ?? mp.max_price ?? null,
  };
}

/** База для маржи: себестоимость + доп. расходы (как в расчёте мин. цены). */
export function productCostBase(product) {
  const cost = Number(product?.cost ?? product?.price ?? product?.base_price ?? 0);
  const add = Number(product?.additionalExpenses ?? product?.additional_expenses ?? 0) || 0;
  if (!Number.isFinite(cost) || cost <= 0) return null;
  return cost + (Number.isFinite(add) ? add : 0);
}

/**
 * Маржинальность, % от цены: (цена − себестоимость) / цена × 100.
 * @returns {number|null}
 */
export function marginPercentFromPrice(price, costBase) {
  const p = Number(price);
  const c = Number(costBase);
  if (!Number.isFinite(p) || p <= 0 || !Number.isFinite(c) || c < 0) return null;
  return roundMoney(((p - c) / p) * 100);
}

export function formatMarginPercent(marginPct) {
  if (marginPct == null || !Number.isFinite(Number(marginPct))) return null;
  const n = Number(marginPct);
  const abs = Math.abs(n);
  const body = abs >= 10 ? abs.toFixed(0) : abs.toFixed(1);
  return `${n < 0 ? '−' : ''}${body}%`;
}
