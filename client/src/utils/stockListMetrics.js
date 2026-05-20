/**
 * Метрики для фильтра «Только в наличии» на странице остатков.
 * Должны совпадать с server stockListOnHandQuantity (products.repository.pg.js).
 */

import { parseKitDisplayMetrics, isKitProduct } from './kitStockMetrics';

/**
 * Есть ли у товара складское наличие / в пути / собираемый комплект для фильтра «только в наличии».
 * @param {object} product — карточка из API
 */
export function stockListHasStock(product) {
  if (!product) return false;

  const kit = parseKitDisplayMetrics(product);
  if (kit) {
    const whole = Math.max(0, Number(kit.whole_on_hand) || 0);
    const assemblable = Math.max(0, Number(kit.assemblable_from_components) || 0);
    return whole > 0 || assemblable > 0;
  }

  if (isKitProduct(product)) {
    return false;
  }

  const onHand = Math.max(0, Number(product.quantity) || 0);
  const incoming = Math.max(
    0,
    Number(product.incoming_quantity ?? product.incomingQuantity) || 0
  );
  return onHand > 0 || incoming > 0;
}

/** @param {{ onHand?: number, incoming?: number, product?: object }} row */
export function stockListRowHasStock(row) {
  if (!row) return false;
  const onHand = Number(row.onHand) || 0;
  const incoming = Number(row.incoming) || 0;
  if (onHand > 0 || incoming > 0) return true;
  if (row.product) return stockListHasStock(row.product);
  return false;
}
