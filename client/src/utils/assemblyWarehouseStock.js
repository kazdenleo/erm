/**
 * Форматирование остатка склада для блока «Следующий к сборке».
 */

function n(v) {
  return Math.max(0, Math.floor(Number(v) || 0));
}

/** На полке = наличие − собрано в заказах (сборка не списывает наличие до отгрузки). */
export function stockOnShelf(stock) {
  if (!stock) return 0;
  if (stock.onShelf != null) return n(stock.onShelf);
  return Math.max(0, n(stock.onHand) - n(stock.assembledInOrders));
}

export function stockCountsLabel(stock = {}) {
  return `наличие ${n(stock?.onHand)} · в собранных заказах ${n(
    stock?.assembledInOrders
  )} · на полке ${stockOnShelf(stock)}`;
}

/** scanned — сколько уже отсканировали в текущей сессии: эти штуки уже сняты с полки. */
export function onShelfLabel({ onShelf = 0, scanned = 0 } = {}) {
  return `на полке ${Math.max(0, n(onShelf) - n(scanned))}`;
}

/**
 * Остаток после «Собран»: снятое с полки (productId → шт) уходит в «собрано в заказах».
 * Нужен, чтобы карточка не ждала повторный запрос остатков.
 */
export function applyPickedToStock(stock, productId, picked) {
  if (!stock || !picked || typeof picked !== 'object') return stock;
  const adjust = (s, pid) => {
    const q = n(picked[pid]);
    if (!s || !q) return s;
    return {
      ...s,
      assembledInOrders: n(s.assembledInOrders) + q,
      onShelf: Math.max(0, stockOnShelf(s) - q),
    };
  };
  const out = adjust(stock, Number(productId));
  if (!Array.isArray(stock.components)) return out;
  return {
    ...out,
    components: stock.components.map((c) => adjust(c, Number(c?.productId))),
  };
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
  pickedQuantities = null,
} = {}) {
  const empty = { kitScanned: 0, byPid: new Map() };
  if (!recommendation?.groupKey || !currentOrderKey) return empty;
  if (String(recommendation.groupKey) !== String(currentOrderKey)) return empty;
  const recPid = Number(recommendation.productId);
  if (pickedQuantities && typeof pickedQuantities === 'object') {
    const byPid = new Map();
    for (const [k, v] of Object.entries(pickedQuantities)) {
      const pid = Number(k);
      if (Number.isFinite(pid) && pid > 0) byPid.set(pid, n(v));
    }
    return { kitScanned: byPid.get(recPid) || 0, byPid };
  }
  const byPid = scannedQtyByProductId(orderItems, scannedQuantities, scannedQtyForLine);
  const fromSku = Number.isFinite(recPid) && recPid > 0 ? byPid.get(recPid) || 0 : 0;
  const fromComps = recommendation.isKit
    ? kitScannedUnitsFromComponents(recommendation.components, byPid)
    : 0;
  return { kitScanned: Math.max(fromSku, fromComps), byPid };
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
