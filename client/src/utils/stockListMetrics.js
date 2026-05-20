/**
 * Метрики для фильтра «Только в наличии» на странице остатков.
 * Должны совпадать с server stockListOnHandQuantity (products.repository.pg.js).
 */

import { parseKitDisplayMetrics, isKitProduct } from './kitStockMetrics';

/**
 * Есть ли у товара наличие для фильтра «только в наличии» (склад / в пути / поставщики / комплект).
 * @param {object} product — карточка из API
 */
export function stockListHasStock(product) {
  if (!product) return false;

  const onHand = Math.max(0, Number(product.quantity) || 0);
  const incoming = Math.max(
    0,
    Number(product.incoming_quantity ?? product.incomingQuantity) || 0
  );
  const suppliers = Math.max(
    0,
    Number(product.supplierStockTotal ?? product.supplier_stock_total) || 0
  );

  const kit = parseKitDisplayMetrics(product);
  if (kit) {
    const whole = Math.max(0, Number(kit.whole_on_hand) || 0);
    const assemblable = Math.max(0, Number(kit.assemblable_from_components) || 0);
    const supplierKit = Math.max(0, Number(kit.supplier_kit_units) || 0);
    return (
      whole > 0 ||
      assemblable > 0 ||
      supplierKit > 0 ||
      suppliers > 0 ||
      onHand > 0 ||
      incoming > 0
    );
  }

  if (isKitProduct(product)) {
    return onHand > 0 || incoming > 0 || suppliers > 0;
  }

  return onHand > 0 || incoming > 0 || suppliers > 0;
}

/** @param {{ onHand?: number, incoming?: number, suppliers?: number, product?: object }} row */
export function stockListRowHasStock(row) {
  if (!row) return false;
  if (row.product) return stockListHasStock(row.product);
  const onHand = Number(row.onHand) || 0;
  const incoming = Number(row.incoming) || 0;
  const suppliers = Number(row.suppliers) || 0;
  return onHand > 0 || incoming > 0 || suppliers > 0;
}
