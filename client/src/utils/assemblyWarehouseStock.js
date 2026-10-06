/**
 * Форматирование остатка склада для блока «Следующий к сборке».
 */

function n(v) {
  return Math.max(0, Math.floor(Number(v) || 0));
}

export function stockCountsLabel({ onHand, reserved, available } = {}) {
  return `наличие ${n(onHand)} · резерв ${n(reserved)} · доступно ${n(available)}`;
}

/**
 * @param {object|null} stock  ответ GET /products/:id/warehouse-stock
 * @param {{ warehouseName?: string, isKit?: boolean }} [opts]
 */
export function formatAssemblyWarehouseStock(stock, { warehouseName = '', isKit = false } = {}) {
  if (!stock) return warehouseName ? `На складе ${warehouseName}: —` : '—';
  const wh = warehouseName || (stock.warehouseId != null ? `#${stock.warehouseId}` : '');
  const prefix = wh ? `На складе ${wh}: ` : '';
  const kit = isKit || stock.isKit === true;

  if (!kit) {
    return `${prefix}${stockCountsLabel(stock)}`;
  }

  const whole = n(stock.wholeOnHand ?? stock.onHand ?? stock.quantity);
  const fromParts = n(stock.assemblableFromComponents);
  const total = n(stock.availableTotal);
  return `${prefix}${whole} цел. + ${fromParts} из комплектующих (доступно ${total})`;
}

export function mergeComponentStock(componentsHint, stockComponents) {
  const bySku = new Map();
  const byId = new Map();
  for (const row of stockComponents || []) {
    if (row?.sku) bySku.set(String(row.sku).trim().toLowerCase(), row);
    if (row?.productId != null) byId.set(Number(row.productId), row);
  }
  return (componentsHint || []).map((c) => {
    const skuKey = String(c.article ?? c.sku ?? '').trim().toLowerCase();
    const pid = Number(c.productId ?? c.product_id);
    const match =
      (Number.isFinite(pid) && pid > 0 ? byId.get(pid) : null) ||
      (skuKey ? bySku.get(skuKey) : null) ||
      null;
    return { ...c, stock: match };
  });
}
