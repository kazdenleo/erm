/**
 * Позиции заказа для UI сборки: для комплектов — строки по комплектующим.
 */

import { query } from '../config/database.js';
import { getKitComponents, isKitProductId, findKitProductIdForMarketplaceOrder } from './kitStock.service.js';

async function loadProductBriefMap(productIds) {
  const ids = [...new Set(productIds.filter((n) => Number.isFinite(n) && n > 0))];
  const map = new Map();
  if (!ids.length) return map;
  const r = await query(
    `SELECT id, sku, name FROM products WHERE id = ANY($1::bigint[])`,
    [ids]
  );
  for (const row of r.rows || []) {
    map.set(Number(row.id), row);
  }
  return map;
}

function orderRowToAssemblyItem(order, productId, productName, quantity, extra = {}) {
  const oid = order.orderId ?? order.order_id;
  return {
    productId,
    productName: productName || order.productName || order.product_name || '—',
    quantity: Math.max(1, parseInt(quantity, 10) || 1),
    offerId: order.offerId ?? order.offer_id ?? extra.offerId ?? null,
    orderLineId: oid != null ? String(oid) : null,
    ...extra
  };
}

/**
 * Развернуть заказ на комплект в строки по kit_components (для сканирования штрихкодов деталей).
 */
export async function expandKitOrderToAssemblyItems(order, kitProductId) {
  const kitId = Number(kitProductId);
  if (!Number.isFinite(kitId) || kitId < 1) return [];
  const components = await getKitComponents(kitId);
  if (!components.length) return [];

  const orderQty = Math.max(1, parseInt(order.quantity, 10) || 1);
  const nameMap = await loadProductBriefMap(components.map((c) => c.component_product_id));

  return components.map((c) => {
    const compPid = Number(c.component_product_id);
    const perKit = Math.max(1, parseInt(c.quantity, 10) || 1);
    const brief = nameMap.get(compPid);
    return orderRowToAssemblyItem(order, compPid, brief?.name, orderQty * perKit, {
      offerId: brief?.sku ?? null,
      kitProductId: kitId,
      isKitComponent: true
    });
  });
}

/**
 * Собрать orderItems для ответа /assembly/find-by-barcode.
 */
export async function buildAssemblyOrderItems(order, ordersService, opts = {}) {
  if (!order) return [];

  let linePid = order.productId ?? order.product_id;
  if (linePid == null && ordersService) {
    linePid = await ordersService.resolveProductIdForAssemblyLine(order);
  }

  let kitId = null;
  const lineNum = linePid != null ? Number(linePid) : NaN;
  if (Number.isFinite(lineNum) && lineNum > 0) {
    if (await isKitProductId(lineNum)) {
      kitId = lineNum;
    } else {
      kitId = await findKitProductIdForMarketplaceOrder(lineNum, order);
    }
  }
  if (kitId == null || !(await isKitProductId(kitId))) {
    const byOrderSku = await findKitProductIdForMarketplaceOrder(0, order);
    if (byOrderSku != null && (await isKitProductId(byOrderSku))) {
      kitId = byOrderSku;
    } else {
      kitId = null;
    }
  }
  if (kitId == null && Number.isFinite(lineNum) && lineNum > 0) {
    const compKits = await query(
      `SELECT kit_product_id FROM kit_components WHERE component_product_id = $1`,
      [lineNum]
    );
    for (const row of compKits.rows || []) {
      const kid = Number(row.kit_product_id);
      if (kid > 0 && (await isKitProductId(kid))) {
        kitId = kid;
        break;
      }
    }
  }
  const scannedId = opts.scannedProductId != null ? Number(opts.scannedProductId) : NaN;
  if (kitId == null && Number.isFinite(scannedId) && scannedId > 0) {
    const compKits = await query(
      `SELECT kit_product_id FROM kit_components WHERE component_product_id = $1`,
      [scannedId]
    );
    for (const row of compKits.rows || []) {
      const kid = Number(row.kit_product_id);
      if (kid > 0 && (await isKitProductId(kid))) {
        kitId = kid;
        break;
      }
    }
  }

  if (kitId != null) {
    const expanded = await expandKitOrderToAssemblyItems(order, kitId);
    if (expanded.length) return expanded;
  }

  const resolvedPid = linePid != null ? linePid : null;
  const n = resolvedPid != null ? Number(resolvedPid) : NaN;
  return [
    orderRowToAssemblyItem(
      order,
      Number.isNaN(n) ? resolvedPid : n,
      order.productName || order.product_name,
      order.quantity ?? 1
    )
  ];
}

/**
 * Несколько строк одной группы заказа (WB/Ozon) → плоский список для сборки.
 */
/**
 * Если все строки группы — один комплект (несколько артикулов WB в одной поставке), развернуть в комплектующие.
 */
async function tryExpandGroupAsSingleKit(groupOrders, ordersService, opts = {}) {
  const rows = Array.isArray(groupOrders) ? groupOrders : [];
  if (rows.length < 2) return null;

  let sharedKitId = null;
  for (const o of rows) {
    let linePid = o.productId ?? o.product_id;
    if (linePid == null && ordersService) {
      linePid = await ordersService.resolveProductIdForAssemblyLine(o);
    }
    const lineNum = linePid != null ? Number(linePid) : NaN;
    if (!Number.isFinite(lineNum) || lineNum < 1) return null;

    let kitId = null;
    if (await isKitProductId(lineNum)) {
      kitId = lineNum;
    } else {
      kitId = await findKitProductIdForMarketplaceOrder(lineNum, o);
    }
    if (kitId == null || !(await isKitProductId(kitId))) {
      const compKits = await query(
        `SELECT kit_product_id FROM kit_components WHERE component_product_id = $1`,
        [lineNum]
      );
      for (const row of compKits.rows || []) {
        const kid = Number(row.kit_product_id);
        if (kid > 0 && (await isKitProductId(kid))) {
          kitId = kid;
          break;
        }
      }
    }
    if (kitId == null) return null;
    if (sharedKitId == null) sharedKitId = kitId;
    else if (sharedKitId !== kitId) return null;
  }

  if (sharedKitId == null) return null;
  const primary = rows.reduce((best, o) => {
    const q = Math.max(1, parseInt(o.quantity, 10) || 1);
    const bq = Math.max(1, parseInt(best?.quantity, 10) || 1);
    return q >= bq ? o : best;
  }, rows[0]);
  const expanded = await expandKitOrderToAssemblyItems(primary, sharedKitId);
  return expanded.length ? expanded : null;
}

export async function buildAssemblyOrderItemsFromGroup(groupOrders, ordersService, opts = {}) {
  const rows = Array.isArray(groupOrders) ? groupOrders : [];
  if (!rows.length) return [];

  const asKit = await tryExpandGroupAsSingleKit(rows, ordersService, opts);
  if (asKit?.length) return asKit;

  const items = [];
  for (const o of rows) {
    const part = await buildAssemblyOrderItems(o, ordersService, opts);
    items.push(...part);
  }
  return items;
}
