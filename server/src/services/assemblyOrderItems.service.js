/**
 * Позиции заказа для UI сборки: для комплектов — строки по комплектующим (рекурсивно).
 */

import { query } from '../config/database.js';
import {
  getKitComponents,
  isKitProductId,
  findKitProductIdForMarketplaceOrder,
  getNetReservedForOrderProduct,
  getReservedKitUnitsFromComponentsForOrder,
  readKitPhysicalOnHandFromDb,
  aggregateKitComponents,
  flattenKitBomToLeaves,
} from './kitStock.service.js';

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
 * Можно ли собрать этот уровень комплекта одним сканом SKU (целый комплект на полке).
 *
 * Важно: при скане штрихкода комплектующей (scannedProductId ≠ kitId) всегда разворачиваем
 * состав на всех уровнях. Иначе скан A даёт листья [A,B], а скан B может свернуть соседний
 * подкомплект в «целый SKU» → другой shape orderItems → на клиенте сбрасывается прогресс
 * и сборка зацикливается («отсканируйте первую снова»).
 */
async function canUseWholeKitAssemblyLine(kitId, kitsNeeded, order, opts = {}) {
  const scannedId = opts.scannedProductId != null ? Number(opts.scannedProductId) : NaN;
  const kitNum = Number(kitId);
  // Физический скан штрихкода этого SKU — одна строка сборки, даже если резерв на комплектующих.
  if (Number.isFinite(scannedId) && scannedId > 0 && Number.isFinite(kitNum) && scannedId === kitNum) {
    return true;
  }
  // Любой другой штрихкод в сессии скана — только разворот (стабильный состав между сканами).
  if (Number.isFinite(scannedId) && scannedId > 0) {
    return false;
  }

  const oid = Number(order?.id ?? order?.db_id);
  const mpLabel = order?.orderId ?? order?.order_id;
  let onKit = 0;
  let fromComp = 0;
  if (Number.isFinite(oid) && oid > 0) {
    onKit = await getNetReservedForOrderProduct(oid, kitId, mpLabel);
    fromComp = await getReservedKitUnitsFromComponentsForOrder(kitId, oid);
  }
  // Резерв на комплектующих — собираем по составу, не целым SKU.
  if (fromComp > 0) return false;

  const physical = await readKitPhysicalOnHandFromDb(kitId, null, {});
  const need = Math.max(1, parseInt(kitsNeeded, 10) || 1);
  if (physical < need) return false;

  // Целые комплекты на полке: один скан SKU комплекта (в т.ч. «x2» с qty>1 в BOM).
  if (onKit >= need) return true;
  return fromComp <= 0;
}

/**
 * Строки для скан-сборки: рекурсия по вложенным комплектам.
 * На каждом уровне — либо целый SKU (если на складе), либо разворот в состав.
 */
async function resolveKitAssemblyScanLines(kitId, kitsNeeded, order, opts = {}, rootKitId = null) {
  const root = rootKitId ?? kitId;
  const qty = Math.max(1, parseInt(kitsNeeded, 10) || 1);

  if (await canUseWholeKitAssemblyLine(kitId, qty, order, opts)) {
    const brief = await loadProductBriefMap([kitId]);
    const b = brief.get(kitId);
    const isRoot = kitId === root;
    return [
      orderRowToAssemblyItem(order, kitId, b?.name ?? '—', qty, {
        offerId: b?.sku ?? null,
        kitProductId: root,
        isKitWhole: isRoot,
        isSubKitWhole: !isRoot,
        subKitProductId: isRoot ? null : kitId,
      }),
    ];
  }

  const aggregated = aggregateKitComponents(await getKitComponents(kitId));
  if (!aggregated.length) return [];

  const nameMap = await loadProductBriefMap(aggregated.map((c) => c.component_product_id));
  const lines = [];

  for (const { component_product_id, quantity: perKit } of aggregated) {
    const lineQty = qty * Math.max(1, parseInt(perKit, 10) || 1);
    const compPid = Number(component_product_id);
    if (!Number.isFinite(compPid) || compPid < 1) continue;

    if (await isKitProductId(compPid)) {
      const subWhole = await canUseWholeKitAssemblyLine(compPid, lineQty, order, opts);

      if (subWhole) {
        const brief = nameMap.get(compPid) ?? (await loadProductBriefMap([compPid])).get(compPid);
        lines.push(
          orderRowToAssemblyItem(order, compPid, brief?.name ?? '—', lineQty, {
            offerId: brief?.sku ?? null,
            kitProductId: root,
            isSubKitWhole: true,
            subKitProductId: compPid,
          })
        );
      } else {
        const subLines = await resolveKitAssemblyScanLines(compPid, lineQty, order, opts, root);
        for (const sl of subLines) {
          lines.push({
            ...sl,
            subKitProductId: sl.subKitProductId ?? compPid,
          });
        }
      }
    } else {
      const brief = nameMap.get(compPid);
      lines.push(
        orderRowToAssemblyItem(order, compPid, brief?.name ?? '—', lineQty, {
          offerId: brief?.sku ?? null,
          kitProductId: root,
          isKitComponent: true,
          subKitProductId: null,
        })
      );
    }
  }

  return lines;
}

/**
 * Развернуть заказ на комплект в строки для сканирования (рекурсивно).
 */
export async function expandKitOrderToAssemblyItems(order, kitProductId, opts = {}) {
  const kitId = Number(kitProductId);
  if (!Number.isFinite(kitId) || kitId < 1) return [];
  const orderQty = Math.max(1, parseInt(order.quantity, 10) || 1);
  return resolveKitAssemblyScanLines(kitId, orderQty, order, opts);
}

/**
 * Строки сборки для заказа на комплект: целый SKU или разворот в комплектующие (рекурсивно).
 */
async function resolveKitAssemblyItems(order, kitProductId, opts = {}) {
  const kitId = Number(kitProductId);
  if (!Number.isFinite(kitId) || kitId < 1) return [];

  const orderQty = Math.max(1, parseInt(order.quantity, 10) || 1);
  const lines = await resolveKitAssemblyScanLines(kitId, orderQty, order, opts);
  if (lines.length) return lines;

  const brief = await loadProductBriefMap([kitId]);
  const b = brief.get(kitId);
  return [
    orderRowToAssemblyItem(order, kitId, b?.name ?? order.productName ?? order.product_name, orderQty, {
      offerId: b?.sku ?? order.offerId ?? order.offer_id ?? null,
      kitProductId: kitId,
      isKitWhole: true,
    }),
  ];
}

/** Найти product_id комплекта для строки заказа (каталог или сопоставление МП). */
export async function resolveKitProductIdForOrder(order, ordersService, opts = {}) {
  if (!order) return null;

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
  const scannedId = opts.scannedProductId != null ? Number(opts.scannedProductId) : NaN;
  if (kitId == null && Number.isFinite(scannedId) && scannedId > 0) {
    const byScan = await findKitProductIdForMarketplaceOrder(scannedId, order);
    if (byScan != null && (await isKitProductId(byScan))) {
      kitId = byScan;
    }
  }
  return kitId;
}

function articleFromOrderOrProduct(order, productBrief) {
  const sku = String(productBrief?.sku ?? '').trim();
  if (sku) return sku;
  const offer = String(order?.offerId ?? order?.offer_id ?? '').trim();
  if (offer) return offer;
  const ps = String(order?.productSku ?? order?.product_sku ?? '').trim();
  if (ps) return ps;
  const name = String(productBrief?.name ?? order?.productName ?? order?.product_name ?? '').trim();
  return name || '—';
}

/**
 * Состав для колонки «Состав»: листовой BOM (вложенные комплекты разворачиваются).
 */
export async function buildAssemblyCompositionLinesForOrder(order, ordersService) {
  if (!order) return [];

  const kitId = await resolveKitProductIdForOrder(order, ordersService);
  if (kitId != null) {
    const orderQty = Math.max(1, parseInt(order.quantity, 10) || 1);
    const leaves = await flattenKitBomToLeaves(kitId, orderQty);
    if (leaves.length) {
      const nameMap = await loadProductBriefMap(leaves.map((l) => l.component_product_id));
      return leaves.map((item) => {
        const brief = nameMap.get(Number(item.component_product_id));
        return {
          article: articleFromOrderOrProduct(
            { offerId: brief?.sku ?? null },
            { sku: brief?.sku, name: brief?.name }
          ),
          quantity: Math.max(1, Number(item.quantity) || 1),
        };
      });
    }
  }

  let linePid = order.productId ?? order.product_id;
  if (linePid == null && ordersService) {
    linePid = await ordersService.resolveProductIdForAssemblyLine(order);
  }
  const pid = linePid != null ? Number(linePid) : NaN;
  const briefMap =
    Number.isFinite(pid) && pid > 0 ? await loadProductBriefMap([pid]) : new Map();
  const brief = Number.isFinite(pid) && pid > 0 ? briefMap.get(pid) : null;
  return [
    {
      article: articleFromOrderOrProduct(order, brief),
      quantity: Math.max(1, parseInt(order.quantity, 10) || 1),
    },
  ];
}

/**
 * Собрать orderItems для ответа /assembly/find-by-barcode.
 */
export async function buildAssemblyOrderItems(order, ordersService, opts = {}) {
  if (!order) return [];

  const kitId = await resolveKitProductIdForOrder(order, ordersService, opts);

  if (kitId != null) {
    const kitItems = await resolveKitAssemblyItems(order, kitId, opts);
    if (kitItems.length) return kitItems;
  }

  let linePid = order.productId ?? order.product_id;
  if (linePid == null && ordersService) {
    linePid = await ordersService.resolveProductIdForAssemblyLine(order);
  }
  const resolvedPid = linePid != null ? linePid : null;
  const n = resolvedPid != null ? Number(resolvedPid) : NaN;
  return [
    orderRowToAssemblyItem(
      order,
      Number.isNaN(n) ? resolvedPid : n,
      order.productName || order.product_name,
      order.quantity ?? 1
    ),
  ];
}

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
  const kitItems = await resolveKitAssemblyItems(primary, sharedKitId, opts);
  return kitItems.length ? kitItems : null;
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

/** Колонка «Состав» в списке сборки (для light-обогащения без полного reserveLines). */
export async function enrichOrdersAssemblyCompositionLines(orders, ordersService) {
  if (!Array.isArray(orders) || !orders.length || !ordersService) return;
  const targets = orders.filter((o) => String(o?.status || '').trim().toLowerCase() === 'in_assembly');
  if (!targets.length) return;
  await Promise.all(
    targets.map(async (o) => {
      try {
        o.assemblyCompositionLines = await buildAssemblyCompositionLinesForOrder(o, ordersService);
        o.assembly_composition_lines = o.assemblyCompositionLines;
      } catch {
        /* ignore */
      }
    })
  );
}
