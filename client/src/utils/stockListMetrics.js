/**
 * Метрики для фильтра «Только в наличии» на странице остатков.
 * Должны совпадать с server stockListOnHandQuantity (products.repository.pg.js).
 */

import { parseKitDisplayMetrics } from './kitStockMetrics';

/**
 * Есть ли у товара складское наличие (колонка «Наличие»), без «в пути» и поставщиков.
 * @param {object} product — карточка из API
 */
export function stockListHasStock(product) {
  if (!product) return false;

  const kit = parseKitDisplayMetrics(product);
  if (kit) {
    return Math.max(0, Number(kit.whole_on_hand) || 0) > 0;
  }

  return Math.max(0, Number(product.quantity) || 0) > 0;
}

/** @param {{ onHand?: number, incoming?: number, suppliers?: number, product?: object }} row */
export function stockListRowHasStock(row) {
  if (!row) return false;
  if (row.product) return stockListHasStock(row.product);
  return Math.max(0, Number(row.onHand) || 0) > 0;
}
