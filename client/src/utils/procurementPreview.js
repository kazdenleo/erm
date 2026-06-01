/**
 * Позиции модалки «В закупку»: остаток на складе и рекомендуемое количество к закупке.
 */

export function procurementEditableLineKey(line) {
  const pid = line?.productId != null ? Number(line.productId) : NaN;
  if (Number.isInteger(pid) && pid >= 1) return `p:${pid}`;
  const art = String(line?.article || '').trim().toUpperCase();
  return `a:${art || '_'}`;
}

function orderLineNeed(o) {
  return Math.max(1, Number(o.needQty ?? o.need_qty ?? o.quantity) || 1);
}

function orderLineReserved(o) {
  return Math.max(0, Number(o.reservedQty ?? o.reserved_qty) || 0);
}

function productOnHand(product) {
  if (!product) return 0;
  const q = Number(product.quantity ?? product.onHand ?? product.on_hand);
  return Number.isFinite(q) && q > 0 ? q : 0;
}

/**
 * Сколько единиц по заказам уже покрыто складом (резерв «со склада» или физический остаток).
 */
export function computeProcurementStockCover(mergedLine, sourceOrders, product) {
  const pid = mergedLine?.productId != null ? Number(mergedLine.productId) : NaN;
  const hasPid = Number.isInteger(pid) && pid >= 1;

  let orderNeed = 0;
  let reservedOnHand = 0;

  const related = hasPid
    ? (sourceOrders || []).filter((o) => Number(o.productId ?? o.product_id) === pid)
    : [];

  if (related.length > 0) {
    for (const o of related) {
      const need = orderLineNeed(o);
      const res = Math.min(orderLineReserved(o), need);
      orderNeed += need;
      const cov = String(o.reserveCoverage ?? o.reserve_coverage ?? '').toLowerCase();
      if (cov === 'on_hand') reservedOnHand += res;
    }
  } else {
    orderNeed = Math.max(0, Number(mergedLine?.quantity) || 0) || 1;
  }

  const onHand = productOnHand(product);
  const physicalCover = Math.min(orderNeed, onHand);
  const reserveCover = Math.min(orderNeed, reservedOnHand);
  const covered = Math.min(orderNeed, Math.max(physicalCover, reserveCover));
  const suggestedQty = Math.max(0, orderNeed - covered);

  let stockStatus = null;
  if (orderNeed > 0 && covered >= orderNeed) {
    stockStatus = 'on_hand';
  } else if (covered > 0 && suggestedQty > 0) {
    stockStatus = 'partial';
  }

  return {
    orderNeed,
    onHand,
    reservedOnHand,
    covered,
    suggestedQty,
    stockStatus,
  };
}

/**
 * @param {object[]} mergedLines — после mergePurchaseLinesByArticle
 * @param {object[]} sourceOrders — все строки заказов в выборке
 * @param {Map<number, object>} productsById
 */
export function buildProcurementEditableLines(mergedLines, sourceOrders, productsById) {
  return (mergedLines || []).map((line) => {
    const pid = line.productId != null ? Number(line.productId) : null;
    const product =
      pid != null && Number.isInteger(pid) && productsById?.get
        ? productsById.get(pid)
        : null;
    const stock = computeProcurementStockCover(line, sourceOrders, product);
    const orderNeed = stock.orderNeed > 0 ? stock.orderNeed : Math.max(1, Number(line.quantity) || 1);
    const quantity = stock.suggestedQty;

    return {
      lineKey: procurementEditableLineKey(line),
      productId: line.productId,
      name: line.name,
      article: line.article,
      sourceOrders: line.sourceOrders ?? [],
      orderNeed,
      quantity,
      onHand: stock.onHand,
      reservedOnHand: stock.reservedOnHand,
      covered: stock.covered,
      stockStatus: stock.stockStatus,
      excluded: stock.stockStatus === 'on_hand' && quantity === 0,
    };
  });
}

export function productsMapFromStockList(products) {
  const map = new Map();
  for (const p of products || []) {
    const id = Number(p?.id);
    if (Number.isInteger(id) && id >= 1) map.set(id, p);
  }
  return map;
}
