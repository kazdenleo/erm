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
 * Резерв этого заказа и доступность на складе.
 * scanned — сколько уже отсканировали в текущей сессии: резерв не меньше скана,
 * доступно уменьшается на скан.
 */
export function orderReserveAvailableLabel({
  reservedForOrder = 0,
  available = 0,
  scanned = 0,
} = {}) {
  const reserved = Math.max(n(reservedForOrder), n(scanned));
  const avail = Math.max(0, n(available) - n(scanned));
  return `резерв ${reserved} · доступно ${avail}`;
}

export function scannedQtyByProductId(orderItems, scannedQuantities, scannedQtyForLine) {
  const map = new Map();
  const items = Array.isArray(orderItems) ? orderItems : [];
  items.forEach((item, idx) => {
    const pid = Number(item?.productId ?? item?.product_id);
    if (!Number.isFinite(pid) || pid < 1) return;
    const q =
      typeof scannedQtyForLine === 'function'
        ? Math.max(0, Number(scannedQtyForLine(item, idx, scannedQuantities, items)) || 0)
        : 0;
    map.set(pid, (map.get(pid) || 0) + q);
  });
  return map;
}

export function kitScannedUnitsFromComponents(components, scannedByPid) {
  const list = Array.isArray(components) ? components : [];
  if (!list.length) return 0;
  const map = scannedByPid instanceof Map ? scannedByPid : new Map();
  let minK = Infinity;
  for (const c of list) {
    const need = Math.max(1, Number(c.quantity) || 1);
    const pid = Number(c.productId ?? c.product_id);
    const got = Number.isFinite(pid) ? map.get(pid) || 0 : 0;
    minK = Math.min(minK, Math.floor(got / need));
  }
  return Number.isFinite(minK) ? minK : 0;
}

/** Доступно для подписи у SKU: у комплекта — цел. + из комплектующих. */
export function orderHintAvailable(stock, { isKit = false } = {}) {
  if (!stock) return 0;
  const kit = isKit || stock.isKit === true;
  return n(kit ? (stock.availableTotal ?? stock.available) : stock.available);
}

/**
 * Сканы текущей сессии, если она совпадает с карточкой «следующий к сборке».
 * kitScanned — сколько комплектов уже «закрыто» сканами SKU или комплектующих.
 */
export function nextRecommendationScanOverlay({
  recommendation,
  currentOrderKey,
  orderItems,
  scannedQuantities,
  scannedQtyForLine,
} = {}) {
  const empty = { kitScanned: 0, byPid: new Map() };
  if (!recommendation?.groupKey || !currentOrderKey) return empty;
  if (String(recommendation.groupKey) !== String(currentOrderKey)) return empty;
  const byPid = scannedQtyByProductId(orderItems, scannedQuantities, scannedQtyForLine);
  const recPid = Number(recommendation.productId);
  const fromSku = Number.isFinite(recPid) && recPid > 0 ? byPid.get(recPid) || 0 : 0;
  const fromComps = recommendation.isKit
    ? kitScannedUnitsFromComponents(recommendation.components, byPid)
    : 0;
  return { kitScanned: Math.max(fromSku, fromComps), byPid };
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
