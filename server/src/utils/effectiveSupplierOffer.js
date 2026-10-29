/**
 * Фактический поставщик для цены и витрины: самый дешёвый со свободным остатком.
 * Дорогие склады не раздувают «доступно» по цене дешёвого.
 */

const PRICE_EPS = 0.02;

/**
 * @param {Array<{ price?: number|string|null, stock?: number|string|null, supplier_id?: number, supplierId?: number }>} rows
 * @returns {{ price: number, freeStockAtPrice: number, supplierIds: number[] } | null}
 */
export function pickEffectiveSupplierOffer(rows) {
  const list = Array.isArray(rows) ? rows : [];
  let bestPrice = null;
  for (const row of list) {
    const free = Math.max(0, Math.floor(Number(row?.stock) || 0));
    if (free <= 0) continue;
    const price = Number(row?.price);
    if (!Number.isFinite(price) || price <= 0) continue;
    if (bestPrice == null || price < bestPrice) bestPrice = price;
  }
  if (bestPrice == null) return null;

  let freeStockAtPrice = 0;
  const supplierIds = [];
  const seen = new Set();
  for (const row of list) {
    const free = Math.max(0, Math.floor(Number(row?.stock) || 0));
    if (free <= 0) continue;
    const price = Number(row?.price);
    if (!Number.isFinite(price) || price <= 0) continue;
    if (Math.abs(price - bestPrice) > PRICE_EPS) continue;
    freeStockAtPrice += free;
    const sid = Number(row?.supplier_id ?? row?.supplierId);
    if (Number.isFinite(sid) && sid > 0 && !seen.has(sid)) {
      seen.add(sid);
      supplierIds.push(sid);
    }
  }
  if (freeStockAtPrice <= 0) return null;
  return {
    price: Math.round(bestPrice * 100) / 100,
    freeStockAtPrice,
    supplierIds,
  };
}

export function pricesNearlyEqual(a, b, eps = PRICE_EPS) {
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  return Math.abs(x - y) <= eps;
}
