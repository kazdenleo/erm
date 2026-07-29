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
  };
}
