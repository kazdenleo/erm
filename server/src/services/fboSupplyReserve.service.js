/**
 * Резерв остатков под поставки FBO: только если включено «Списать остатки при отгрузке»
 * и задан склад списания; очередь по ready_at.
 */

import { query } from '../config/database.js';
import repositoryFactory from '../config/repository-factory.js';
import stockMovementsService from './stockMovements.service.js';
import { getProductSupplySnapshotWithClient } from './sellableQuantity.service.js';
import { NET_RESERVED_MOVEMENT_ROW_CASE_SQL } from '../constants/netReservedStockSql.js';
import {
  allocateKitReservePriority,
  buildKitComponentQtyMap,
  computeAssemblableFromComponentPoolMap,
  computeAssemblableFromComponents,
  computeKitReservableBreakdown,
  getKitComponents,
  getReservedKitUnitsForFboItem,
  batchGetReservedKitUnitsForFboItems,
  batchIsKitProductIds,
  isKitProductId,
  recalculateKitsForComponent,
} from './kitStock.service.js';

const FBO_RESERVE_ACTIVE_STATUSES = ['new', 'packed', 'ready_for_supply'];

/** Приоритет в очереди резерва: упакованные и готовые раньше черновиков. */
export function fboReserveStatusRank(status) {
  const s = String(status || '').trim();
  if (s === 'packed') return 0;
  if (s === 'ready_for_supply') return 1;
  if (s === 'new') return 2;
  return 3;
}

const FBO_RESERVE_QUEUE_ORDER_SQL = `
  CASE s.status
    WHEN 'packed' THEN 0
    WHEN 'ready_for_supply' THEN 1
    WHEN 'new' THEN 2
    ELSE 3
  END,
  s.ready_at ASC NULLS LAST,
  s.id ASC,
  si.id ASC`;

const fboSourceWarehousesCache = new Map();

function normalizeWarehouseId(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Склады-источники для FBO: только склад списания FBO из настроек аккаунта. */
async function getFboSourceWarehouseIds(profileId) {
  const pid = normalizeProfileId(profileId);
  if (pid == null) return [];
  const cacheKey = String(pid);
  if (fboSourceWarehousesCache.has(cacheKey)) {
    return fboSourceWarehousesCache.get(cacheKey);
  }
  const r = await query(
    `SELECT fbo_deduction_warehouse_id FROM profiles WHERE id = $1`,
    [pid]
  );
  const row = r.rows?.[0];
  const n = normalizeWarehouseId(row?.fbo_deduction_warehouse_id);
  const ids = n != null ? [n] : [];
  fboSourceWarehousesCache.set(cacheKey, ids);
  return ids;
}

function normalizeWarehouseIdList(warehouseId) {
  if (Array.isArray(warehouseId)) {
    const ids = [];
    for (const raw of warehouseId) {
      const n = normalizeWarehouseId(raw);
      if (n != null && !ids.includes(n)) ids.push(n);
    }
    return ids;
  }
  const single = normalizeWarehouseId(warehouseId);
  return single != null ? [single] : [];
}

function normalizeProfileId(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'string' ? parseInt(v, 10) : Number(v);
  return Number.isNaN(n) ? null : n;
}

async function getNetReservedForFboItem(fboSupplyItemId, productId, client = null) {
  const run = client?.query ? client.query.bind(client) : query;
  const r = await run(
    `SELECT GREATEST(0, COALESCE(SUM(${NET_RESERVED_MOVEMENT_ROW_CASE_SQL}), 0))::int AS net
     FROM stock_movements
     WHERE product_id = $1
       AND meta->>'fbo_supply_item_id' = $2`,
    [productId, String(fboSupplyItemId)]
  );
  return parseInt(r.rows?.[0]?.net ?? 0, 10) || 0;
}

/** Нетто-резерв FBO по строке в разрезе складов (для корректного снятия). */
async function getNetReservedForFboItemByWarehouse(fboSupplyItemId, productId, client = null) {
  const run = client?.query ? client.query.bind(client) : query;
  const r = await run(
    `SELECT warehouse_id,
            GREATEST(0, COALESCE(SUM(${NET_RESERVED_MOVEMENT_ROW_CASE_SQL}), 0))::int AS net
     FROM stock_movements
     WHERE product_id = $1
       AND meta->>'fbo_supply_item_id' = $2
       AND type IN ('reserve', 'unreserve')
     GROUP BY warehouse_id`,
    [productId, String(fboSupplyItemId)]
  );
  return (r.rows || [])
    .map((row) => ({
      warehouseId: normalizeWarehouseId(row.warehouse_id),
      net: parseInt(row.net ?? 0, 10) || 0,
    }))
    .filter((row) => row.warehouseId != null && row.net > 0);
}

async function getNetReservedOnWarehouse(productId, warehouseId, client = null) {
  const run = client?.query ? client.query.bind(client) : query;
  const r = await run(
    `SELECT GREATEST(0, COALESCE(SUM(${NET_RESERVED_MOVEMENT_ROW_CASE_SQL}), 0))::int AS net
     FROM stock_movements
     WHERE product_id = $1
       AND warehouse_id = $2
       AND type IN ('reserve', 'unreserve')`,
    [productId, warehouseId]
  );
  return parseInt(r.rows?.[0]?.net ?? 0, 10) || 0;
}

async function getWarehouseReservableUnits(productId, warehouseId) {
  const repo = repositoryFactory.getProductsRepository();
  const wid = await repo.resolveStrictOwnWarehouseId(warehouseId);
  if (!wid) return 0;
  const onHand = await repo.getWarehouseFreeStock(productId, wid);
  const reservedOnWh = await getNetReservedOnWarehouse(productId, wid);
  return Math.max(0, onHand - reservedOnWh);
}

async function findFboReserveQueueByProduct(productId, profileId = null) {
  const byProduct = await findFboReserveQueuesByProducts([productId], profileId);
  return byProduct.get(Number(productId)) || [];
}

/** Очереди резерва FBO по нескольким товарам — один запрос. */
async function findFboReserveQueuesByProducts(productIds, profileId = null) {
  const uniquePids = [...new Set((productIds || []).map((id) => Number(id)).filter((id) => id > 0))];
  const result = new Map();
  if (!uniquePids.length) return result;

  const profId = normalizeProfileId(profileId);
  const r = await query(
    `SELECT si.id AS supply_item_id,
            si.fbo_supply_id,
            si.product_id,
            si.quantity::int AS quantity,
            s.ready_at,
            s.deduction_warehouse_id,
            s.status,
            s.external_shipment_number
     FROM fbo_supply_items si
     INNER JOIN fbo_supplies s ON s.id = si.fbo_supply_id
     WHERE si.product_id = ANY($1::bigint[])
       AND ($2::bigint IS NULL OR s.profile_id = $2)
       AND s.deduction_warehouse_id IS NOT NULL
       AND COALESCE(s.deduct_stock, false) = true
       AND s.status = ANY($3::text[])
     ORDER BY si.product_id, ${FBO_RESERVE_QUEUE_ORDER_SQL}`,
    [uniquePids, profId, FBO_RESERVE_ACTIVE_STATUSES]
  );
  for (const row of r.rows || []) {
    const pid = Number(row.product_id);
    if (!result.has(pid)) result.set(pid, []);
    result.get(pid).push(row);
  }
  return result;
}

/** Нетто-резерв по строкам FBO — один запрос на набор товаров. */
async function getNetReservedForFboItemsBatch(productIds, client = null) {
  const uniquePids = [...new Set((productIds || []).map((id) => Number(id)).filter((id) => id > 0))];
  const result = new Map();
  if (!uniquePids.length) return result;

  const run = client?.query ? client.query.bind(client) : query;
  const r = await run(
    `SELECT meta->>'fbo_supply_item_id' AS supply_item_id,
            product_id,
            GREATEST(0, COALESCE(SUM(${NET_RESERVED_MOVEMENT_ROW_CASE_SQL}), 0))::int AS net
     FROM stock_movements
     WHERE product_id = ANY($1::bigint[])
       AND meta->>'fbo_supply_item_id' IS NOT NULL
     GROUP BY meta->>'fbo_supply_item_id', product_id`,
    [uniquePids]
  );
  for (const row of r.rows || []) {
    const itemId = String(row.supply_item_id);
    result.set(itemId, parseInt(row.net ?? 0, 10) || 0);
  }
  return result;
}

/** Остатки на складах для набора товаров — один запрос. */
async function batchGetWarehouseOnHand(productIds, warehouseIds) {
  const pids = [...new Set((productIds || []).map((id) => Number(id)).filter((id) => id > 0))];
  const whs = normalizeWarehouseIdList(warehouseIds);
  const result = new Map();
  if (!pids.length || !whs.length) return result;

  const r = await query(
    `SELECT product_id, warehouse_id, COALESCE(quantity, 0)::int AS on_hand
     FROM product_warehouse_stock
     WHERE product_id = ANY($1::bigint[]) AND warehouse_id = ANY($2::bigint[])`,
    [pids, whs]
  );
  for (const row of r.rows || []) {
    const pid = Number(row.product_id);
    const wid = normalizeWarehouseId(row.warehouse_id);
    if (!result.has(pid)) result.set(pid, new Map());
    result.get(pid).set(wid, Number(row.on_hand) || 0);
  }
  return result;
}

/** Нетто-резерв на складах для набора товаров — один запрос. */
async function batchGetNetReservedOnWarehouses(productIds, warehouseIds) {
  const pids = [...new Set((productIds || []).map((id) => Number(id)).filter((id) => id > 0))];
  const whs = normalizeWarehouseIdList(warehouseIds);
  const result = new Map();
  if (!pids.length || !whs.length) return result;

  const r = await query(
    `SELECT product_id, warehouse_id,
            GREATEST(0, COALESCE(SUM(${NET_RESERVED_MOVEMENT_ROW_CASE_SQL}), 0))::int AS net
     FROM stock_movements
     WHERE product_id = ANY($1::bigint[])
       AND warehouse_id = ANY($2::bigint[])
       AND type IN ('reserve', 'unreserve')
     GROUP BY product_id, warehouse_id`,
    [pids, whs]
  );
  for (const row of r.rows || []) {
    const pid = Number(row.product_id);
    const wid = normalizeWarehouseId(row.warehouse_id);
    if (!result.has(pid)) result.set(pid, new Map());
    result.get(pid).set(wid, parseInt(row.net ?? 0, 10) || 0);
  }
  return result;
}

/** Пул «в пути» для набора товаров (incoming_quantity + журнал incoming). */
async function batchGetIncomingPoolForFboProducts(productIds) {
  const pids = [...new Set((productIds || []).map((id) => Number(id)).filter((id) => id > 0))];
  const result = new Map();
  if (!pids.length) return result;

  const [prodR, movR] = await Promise.all([
    query(
      `SELECT id AS product_id, COALESCE(incoming_quantity, 0)::int AS inc
       FROM products WHERE id = ANY($1::bigint[])`,
      [pids]
    ),
    query(
      `SELECT product_id,
              GREATEST(0, COALESCE(SUM(quantity_change), 0))::int AS net
       FROM stock_movements
       WHERE product_id = ANY($1::bigint[])
         AND LOWER(TRIM(type::text)) = 'incoming'
       GROUP BY product_id`,
      [pids]
    ),
  ]);

  for (const pid of pids) {
    result.set(pid, 0);
  }
  for (const row of prodR.rows || []) {
    const pid = Number(row.product_id);
    result.set(pid, Math.max(result.get(pid) || 0, Number(row.inc) || 0));
  }
  for (const row of movR.rows || []) {
    const pid = Number(row.product_id);
    const net = Number(row.net) || 0;
    if (net > 0) {
      result.set(pid, Math.max(result.get(pid) || 0, net));
    }
  }
  return result;
}

function takeFromStockPoolsMaps(stockPools, onHandByWh, reservedByWh, warehouseIds, need) {
  let reserved = 0;
  let remaining = Math.max(0, Math.floor(Number(need) || 0));
  for (const sourceWh of warehouseIds) {
    if (remaining <= 0) break;
    if (!stockPools.has(sourceWh)) {
      const onHand = onHandByWh?.get(sourceWh) || 0;
      const reservedOnWh = reservedByWh?.get(sourceWh) || 0;
      stockPools.set(sourceWh, Math.max(0, onHand - reservedOnWh));
    }
    const pool = stockPools.get(sourceWh) || 0;
    const take = Math.min(remaining, pool);
    if (take > 0) {
      reserved += take;
      stockPools.set(sourceWh, Math.max(0, pool - take));
      remaining -= take;
    }
  }
  return reserved;
}

function readyAtTs(v) {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

/** Снимать резерв — с самых поздних / низкоприоритетных поставок (обратный порядок очереди). */
function compareSupplyRowsForUnreserve(a, b) {
  const sa = fboReserveStatusRank(a?.status);
  const sb = fboReserveStatusRank(b?.status);
  if (sa !== sb) return sb - sa;

  const ta = readyAtTs(a?.ready_at);
  const tb = readyAtTs(b?.ready_at);
  // null → в конец (как "самая поздняя / неизвестная")
  const na = ta == null;
  const nb = tb == null;
  if (na && nb) {
    // fallback по id, чтобы было детерминированно
    const supplyA = Number(a?.fbo_supply_id) || 0;
    const supplyB = Number(b?.fbo_supply_id) || 0;
    if (supplyA !== supplyB) return supplyB - supplyA;
    const ia = Number(a?.supply_item_id) || 0;
    const ib = Number(b?.supply_item_id) || 0;
    return ib - ia;
  }
  if (na) return -1; // a(null) раньше в сортировке DESC (т.е. "снимать первым")
  if (nb) return 1;
  if (ta !== tb) return tb - ta; // поздние раньше
  const supplyA = Number(a?.fbo_supply_id) || 0;
  const supplyB = Number(b?.fbo_supply_id) || 0;
  if (supplyA !== supplyB) return supplyB - supplyA;
  const ia = Number(a?.supply_item_id) || 0;
  const ib = Number(b?.supply_item_id) || 0;
  return ib - ia;
}

async function applyFboReserveDelta({
  productId,
  warehouseId,
  supplyId,
  supplyItemId,
  delta,
  reason,
  extraMeta = {},
}) {
  const d = Math.floor(Number(delta) || 0);
  if (d === 0) return;
  const wid = normalizeWarehouseId(warehouseId);
  const meta = {
    warehouse_id: wid ?? warehouseId,
    fbo_supply_id: String(supplyId),
    fbo_supply_item_id: String(supplyItemId),
    ...(wid != null ? { strict_warehouse: true } : {}),
    ...extraMeta,
  };
  if (d > 0) {
    await stockMovementsService.applyChange(productId, {
      delta: -d,
      type: 'reserve',
      reason,
      meta,
    });
    return;
  }
  await stockMovementsService.applyChange(productId, {
    delta: Math.abs(d),
    type: 'unreserve',
    reason,
    meta,
  });
}

/** Нетто-резерв по строке FBO в разрезе товара и склада (включая комплектующие). */
async function getFboItemReserveNetByProductWarehouse(fboSupplyItemId, client = null) {
  const itemId = String(fboSupplyItemId ?? '').trim();
  if (!itemId) return [];
  const run = client?.query ? client.query.bind(client) : query;
  const r = await run(
    `SELECT product_id, warehouse_id,
            GREATEST(0, COALESCE(SUM(${NET_RESERVED_MOVEMENT_ROW_CASE_SQL}), 0))::int AS net
     FROM stock_movements
     WHERE meta->>'fbo_supply_item_id' = $1
       AND type IN ('reserve', 'unreserve')
     GROUP BY product_id, warehouse_id`,
    [itemId]
  );
  return (r.rows || [])
    .map((row) => ({
      productId: Number(row.product_id),
      warehouseId: normalizeWarehouseId(row.warehouse_id),
      net: parseInt(row.net ?? 0, 10) || 0,
    }))
    .filter((row) => Number.isFinite(row.productId) && row.productId > 0 && row.warehouseId != null && row.net > 0);
}

function buildWarehouseCandidates(deductionWarehouseId, stockWarehouseIds) {
  const out = [];
  const primary = normalizeWarehouseId(deductionWarehouseId);
  if (primary != null) out.push(primary);
  for (const wh of stockWarehouseIds || []) {
    const n = normalizeWarehouseId(wh);
    if (n != null && !out.includes(n)) out.push(n);
  }
  return out;
}

async function createKitFboReserveSimulator(kitId, stockWarehouseIds) {
  return buildKitStockPoolsForWarehouses(kitId, stockWarehouseIds);
}

/** Пул целых комплектов и комплектующих по нескольким складам-источникам FBO. */
async function buildKitStockPoolsForWarehouses(kitId, stockWarehouseIds) {
  const whs = normalizeWarehouseIdList(stockWarehouseIds);
  const components = await getKitComponents(kitId);
  let wholeRemaining = 0;
  const componentPools = new Map();
  for (const wh of whs) {
    wholeRemaining += await getWarehouseAvailablePoolForFbo(kitId, wh);
    for (const c of components) {
      const pid = Number(c.component_product_id);
      if (!Number.isFinite(pid) || pid < 1) continue;
      const pool = await getWarehouseAvailablePoolForFbo(pid, wh);
      componentPools.set(pid, (componentPools.get(pid) || 0) + pool);
    }
  }
  return { components, wholeRemaining, componentPools };
}

async function computeKitReservableBreakdownForWarehouseIds(kitId, warehouseIds) {
  const whs = normalizeWarehouseIdList(warehouseIds);
  if (!whs.length) {
    return { wholeAvail: 0, wholeReserveAvail: 0, fromComponents: 0, total: 0, physicalOnHand: 0 };
  }
  const { components, wholeRemaining, componentPools } = await buildKitStockPoolsForWarehouses(kitId, whs);
  const fromComponents = computeAssemblableFromComponentPoolMap(components, componentPools);
  const allocCap = allocateKitReservePriority(9999, {
    wholeAvail: wholeRemaining,
    wholeReserveAvail: wholeRemaining,
    fromComponents,
    physicalOnHand: wholeRemaining,
  });
  return {
    wholeAvail: wholeRemaining,
    wholeReserveAvail: wholeRemaining,
    fromComponents,
    total: allocCap.kitsToReserve,
    physicalOnHand: wholeRemaining,
  };
}

function simulateKitReserveFromPools(sim, wanted) {
  const qty = Math.max(0, parseInt(wanted, 10) || 0);
  if (qty <= 0 || !sim) return 0;
  const fromComponentsAvail = computeAssemblableFromComponentPoolMap(sim.components, sim.componentPools);
  const alloc = allocateKitReservePriority(qty, {
    wholeReserveAvail: sim.wholeRemaining,
    fromComponents: fromComponentsAvail,
    physicalOnHand: sim.wholeRemaining,
  });
  if (alloc.fromWhole > 0) {
    sim.wholeRemaining = Math.max(0, sim.wholeRemaining - alloc.fromWhole);
  }
  if (alloc.fromComponents > 0) {
    const compMap = buildKitComponentQtyMap(sim.components, alloc.fromComponents);
    for (const [compId, compQty] of compMap) {
      componentPoolsDecrement(sim.componentPools, compId, compQty);
    }
  }
  return alloc.kitsToReserve;
}

function componentPoolsDecrement(componentPools, compId, qty) {
  const pid = Number(compId);
  const dec = Math.max(0, Number(qty) || 0);
  if (!Number.isFinite(pid) || pid < 1 || dec <= 0) return;
  componentPools.set(pid, Math.max(0, (componentPools.get(pid) || 0) - dec));
}

function logFboReserveFailure(context, err) {
  const msg = err?.message || String(err);
  console.warn(`[FBO reserve] ${context}: ${msg}`);
}

async function applyKitFboReserve(
  kitProductId,
  kitsWanted,
  { supplyId, supplyItemId, stockWarehouseIds, deductionWarehouseId, label, applyMeta = {} }
) {
  const kitId = Number(kitProductId);
  const wanted = Math.max(0, parseInt(kitsWanted, 10) || 0);
  if (!Number.isFinite(kitId) || kitId < 1 || wanted <= 0) return 0;

  const whCandidates = buildWarehouseCandidates(deductionWarehouseId, stockWarehouseIds);
  const stockWhs = normalizeWarehouseIdList(stockWarehouseIds);
  const poolWhs = stockWhs.length > 0 ? stockWhs : whCandidates;

  const breakdown =
    poolWhs.length > 0
      ? await computeKitReservableBreakdownForWarehouseIds(kitId, poolWhs)
      : { wholeReserveAvail: 0, fromComponents: 0, physicalOnHand: 0 };
  const alloc = allocateKitReservePriority(wanted, breakdown);
  if (alloc.kitsToReserve <= 0) return 0;

  const reason = `Резерв FBO (${label})`;

  if (alloc.fromWhole > 0) {
    let needWhole = alloc.fromWhole;
    for (const wh of whCandidates) {
      if (needWhole <= 0) break;
      const pool = await getWarehouseReservableUnits(kitId, wh);
      const add = Math.min(needWhole, pool);
      if (add <= 0) continue;
      await applyFboReserveDelta({
        productId: kitId,
        warehouseId: wh,
        supplyId,
        supplyItemId,
        delta: add,
        reason,
        extraMeta: {
          kit_product_id: kitId,
          kit_reserve_scope: 'whole',
          kit_reserve_from_whole: add,
          kit_reserve_from_components: 0,
          ...applyMeta,
        },
      });
      needWhole -= add;
    }
  }

  if (alloc.fromComponents > 0) {
    const { components, componentPools } = await buildKitStockPoolsForWarehouses(kitId, poolWhs);
    const assemblable = computeAssemblableFromComponentPoolMap(components, componentPools);
    const fromComp = Math.min(alloc.fromComponents, assemblable);
    if (fromComp > 0) {
      const compQtyMap = buildKitComponentQtyMap(components, fromComp);
      for (const [compId, compQty] of compQtyMap) {
        let needQty = compQty;
        for (const wh of whCandidates) {
          if (needQty <= 0) break;
          const pool = await getWarehouseReservableUnits(compId, wh);
          const add = Math.min(needQty, pool);
          if (add <= 0) continue;
          await applyFboReserveDelta({
            productId: compId,
            warehouseId: wh,
            supplyId,
            supplyItemId,
            delta: add,
            reason,
            extraMeta: {
              kit_product_id: kitId,
              kit_reserve_scope: 'component',
              kit_reserve_from_whole: 0,
              kit_reserve_from_components: fromComp,
              kit_units: fromComp,
              ...applyMeta,
            },
          });
          needQty -= add;
        }
      }
    }
  }

  return getReservedKitUnitsForFboItem(kitId, supplyItemId, wanted);
}

async function getWarehouseAvailablePoolForFbo(productId, warehouseId) {
  const pid = Number(productId);
  const wid = Number(warehouseId);
  if (!Number.isFinite(pid) || pid < 1 || !Number.isFinite(wid) || wid < 1) return 0;

  const pwsR = await query(
    `SELECT COALESCE(quantity, 0)::int AS on_hand
     FROM product_warehouse_stock
     WHERE product_id = $1 AND warehouse_id = $2`,
    [pid, wid]
  );
  const onHand = Number(pwsR.rows?.[0]?.on_hand) || 0;
  const reservedOnWh = await getNetReservedOnWarehouse(pid, wid);
  return Math.max(0, onHand - reservedOnWh);
}

/** Пул «в пути» для покрытия строк FBO (глобально + по складам-источникам). */
async function getIncomingPoolForFboProduct(productId, warehouseId = null) {
  const pid = Number(productId);
  if (!Number.isFinite(pid) || pid < 1) return 0;

  const globalR = await query(
    `SELECT COALESCE(incoming_quantity, 0)::int AS inc FROM products WHERE id = $1`,
    [pid]
  );
  let pool = Number(globalR.rows[0]?.inc) || 0;

  const warehouseIds = normalizeWarehouseIdList(warehouseId);
  for (const wh of warehouseIds) {
    const snap = await getProductSupplySnapshotWithClient(null, pid, { warehouseId: wh });
    pool = Math.max(pool, Number(snap.incoming) || 0);
  }

  if (pool <= 0) {
    const netR = await query(
      `SELECT GREATEST(0, COALESCE(SUM(quantity_change), 0))::int AS net
       FROM stock_movements
       WHERE product_id = $1 AND LOWER(TRIM(type::text)) = 'incoming'`,
      [pid]
    );
    pool = Number(netR.rows[0]?.net) || 0;
  }

  return Math.max(0, pool);
}

async function getSourceOnHandForProduct(productId, profileId, stockWarehouseIds = null) {
  const pid = Number(productId);
  if (!Number.isFinite(pid) || pid < 1) return 0;
  const whs =
    stockWarehouseIds?.length > 0 ? stockWarehouseIds : await getFboSourceWarehouseIds(profileId);
  if (!whs.length) return 0;
  const r = await query(
    `SELECT COALESCE(SUM(quantity), 0)::int AS total
     FROM product_warehouse_stock
     WHERE product_id = $1 AND warehouse_id = ANY($2::bigint[])`,
    [pid, whs]
  );
  return Number(r.rows[0]?.total) || 0;
}

async function takeFromStockPools(stockPools, productId, warehouseIds, need) {
  let reserved = 0;
  let remaining = Math.max(0, Math.floor(Number(need) || 0));
  for (const sourceWh of warehouseIds) {
    if (remaining <= 0) break;
    if (!stockPools.has(sourceWh)) {
      stockPools.set(sourceWh, await getWarehouseAvailablePoolForFbo(productId, sourceWh));
    }
    const pool = stockPools.get(sourceWh) || 0;
    const take = Math.min(remaining, pool);
    if (take > 0) {
      reserved += take;
      stockPools.set(sourceWh, Math.max(0, pool - take));
      remaining -= take;
    }
  }
  return reserved;
}

class FboSupplyReserveService {
  /**
   * Покрытие строк FBO: с наличия (FIFO по ready_at на складе списания) и с пути (incoming).
   * Если в журнале уже есть резерв по строке — берём факт; иначе симулируем распределение пула.
   * @returns {Map<string, { reservedFromStock: number, reservedFromIncoming: number }>}
   */
  async _computeReserveBreakdownByItem(productIds, { profileId } = {}) {
    const breakdown = new Map();
    const uniquePids = [...new Set((productIds || []).map((id) => Number(id)).filter((id) => id > 0))];
    if (!uniquePids.length) return breakdown;

    const sourceWarehouseIds = await getFboSourceWarehouseIds(profileId);
    const [queuesByProduct, netReservedByItem, incomingByProduct] = await Promise.all([
      findFboReserveQueuesByProducts(uniquePids, profileId),
      getNetReservedForFboItemsBatch(uniquePids),
      batchGetIncomingPoolForFboProducts(uniquePids),
    ]);

    const warehouseIdsSet = new Set(sourceWarehouseIds);
    for (const queue of queuesByProduct.values()) {
      for (const row of queue) {
        const wh = normalizeWarehouseId(row.deduction_warehouse_id);
        if (wh != null) warehouseIdsSet.add(wh);
      }
    }
    const allWhIds = [...warehouseIdsSet];

    const [onHandByProductWh, reservedOnWhByProductWh] = await Promise.all([
      batchGetWarehouseOnHand(uniquePids, allWhIds),
      batchGetNetReservedOnWarehouses(uniquePids, allWhIds),
    ]);

    const kitFlags = await batchIsKitProductIds(uniquePids);

    const kitQueueEntries = [];
    for (const productId of uniquePids) {
      if (kitFlags.get(productId) !== true) continue;
      for (const row of queuesByProduct.get(productId) || []) {
        kitQueueEntries.push({
          kitProductId: productId,
          fboSupplyItemId: row.supply_item_id,
          lineQty: row.quantity,
        });
      }
    }
    const kitReservedByItem = await batchGetReservedKitUnitsForFboItems(kitQueueEntries);

    for (const productId of uniquePids) {
      const queue = queuesByProduct.get(productId) || [];
      const fallbackWh = normalizeWarehouseId(
        queue.find((row) => Number(row.deduction_warehouse_id) > 0)?.deduction_warehouse_id
      );
      const stockWarehouseIds =
        sourceWarehouseIds.length > 0
          ? sourceWarehouseIds
          : fallbackWh != null
            ? [fallbackWh]
            : [];
      let incomingPool = incomingByProduct.get(productId) || 0;
      const stockPools = new Map();
      const onHandByWh = onHandByProductWh.get(productId) || new Map();
      const reservedByWh = reservedOnWhByProductWh.get(productId) || new Map();
      const isKit = kitFlags.get(productId) === true;
      const kitSim =
        isKit && stockWarehouseIds.length > 0
          ? await createKitFboReserveSimulator(productId, stockWarehouseIds)
          : null;

      for (const row of queue) {
        const itemId = String(row.supply_item_id);
        const qty = Math.max(0, parseInt(row.quantity, 10) || 0);

        let reservedFromStock = 0;
        if (isKit) {
          reservedFromStock = kitReservedByItem.get(itemId) || 0;
          if (reservedFromStock <= 0 && kitSim) {
            reservedFromStock = simulateKitReserveFromPools(kitSim, qty);
          }
        } else {
          reservedFromStock = netReservedByItem.get(itemId) || 0;
          if (reservedFromStock <= 0 && stockWarehouseIds.length > 0) {
            reservedFromStock = takeFromStockPoolsMaps(
              stockPools,
              onHandByWh,
              reservedByWh,
              stockWarehouseIds,
              qty
            );
          }
        }

        const gap = Math.max(0, qty - reservedFromStock);
        const reservedFromIncoming = Math.min(gap, incomingPool);
        incomingPool = Math.max(0, incomingPool - reservedFromIncoming);

        breakdown.set(itemId, { reservedFromStock, reservedFromIncoming });
      }
    }
    return breakdown;
  }

  async enrichItemsWithReserved(items, { profileId, reserveEnabled = true } = {}) {
    if (!repositoryFactory.isUsingPostgreSQL() || !Array.isArray(items)) return items;

    const productIds = [
      ...new Set(
        items
          .map((it) => it.productId ?? it.product_id)
          .filter((id) => id != null && id !== '')
          .map((id) => Number(id))
          .filter((id) => Number.isFinite(id) && id > 0)
      ),
    ];
    const breakdown =
      reserveEnabled === true
        ? await this._computeReserveBreakdownByItem(productIds, { profileId })
        : new Map();
    const sourceWarehouseIds = await getFboSourceWarehouseIds(profileId);
    const [onHandByProductWh, incomingByProduct] = await Promise.all([
      batchGetWarehouseOnHand(productIds, sourceWarehouseIds),
      batchGetIncomingPoolForFboProducts(productIds),
    ]);
    const sourceOnHandByProduct = new Map();
    const sourceIncomingByProduct = incomingByProduct;
    const kitFlags = await batchIsKitProductIds(productIds);
    await Promise.all(
      productIds.map(async (productId) => {
        if (kitFlags.get(productId) === true) {
          const breakdownKit =
            sourceWarehouseIds.length > 0
              ? await computeKitReservableBreakdownForWarehouseIds(productId, sourceWarehouseIds)
              : await computeKitReservableBreakdown(productId, { warehouseId: null });
          sourceOnHandByProduct.set(productId, Number(breakdownKit.total) || 0);
          return;
        }
        const byWh = onHandByProductWh.get(productId) || new Map();
        let total = 0;
        for (const wid of sourceWarehouseIds) {
          total += byWh.get(wid) || 0;
        }
        sourceOnHandByProduct.set(productId, total);
      })
    );

    const kitFallbackEntries = [];
    for (const it of items) {
      const pid = Number(it.productId ?? it.product_id);
      if (!Number.isFinite(pid) || pid <= 0 || !it.id) continue;
      if (breakdown.has(String(it.id)) || reserveEnabled !== true) continue;
      if (kitFlags.get(pid) === true) {
        kitFallbackEntries.push({
          kitProductId: pid,
          fboSupplyItemId: it.id,
          lineQty: it.quantity,
        });
      }
    }
    const kitFallbackReserved = await batchGetReservedKitUnitsForFboItems(kitFallbackEntries);

    const out = [];
    for (const it of items) {
      const pid = it.productId ?? it.product_id;
      const pidNum = Number(pid);
      const sourceOnHand =
        Number.isFinite(pidNum) && pidNum > 0 ? sourceOnHandByProduct.get(pidNum) || 0 : 0;
      const sourceIncoming =
        Number.isFinite(pidNum) && pidNum > 0 ? sourceIncomingByProduct.get(pidNum) || 0 : 0;
      if (!pid || !it.id) {
        out.push({
          ...it,
          reservedQuantity: 0,
          reservedFromStock: 0,
          reservedFromIncoming: 0,
          reservedTotal: 0,
          sourceOnHand,
          sourceIncoming,
        });
        continue;
      }
      const b = breakdown.get(String(it.id));
      if (b && reserveEnabled === true) {
        const reservedTotal = (Number(b.reservedFromStock) || 0) + (Number(b.reservedFromIncoming) || 0);
        out.push({
          ...it,
          reservedQuantity: b.reservedFromStock,
          reservedFromStock: b.reservedFromStock,
          reservedFromIncoming: b.reservedFromIncoming,
          reservedTotal,
          sourceOnHand,
          sourceIncoming,
        });
        continue;
      }
      if (reserveEnabled !== true) {
        out.push({
          ...it,
          reservedQuantity: 0,
          reservedFromStock: 0,
          reservedFromIncoming: 0,
          reservedTotal: 0,
          sourceOnHand,
          sourceIncoming,
        });
        continue;
      }
      const reservedFromStock = kitFlags.get(pidNum) === true
        ? (kitFallbackReserved.get(String(it.id)) ?? 0)
        : await getNetReservedForFboItem(it.id, pid);
      out.push({
        ...it,
        reservedQuantity: reservedFromStock,
        reservedFromStock,
        reservedFromIncoming: 0,
        reservedTotal: reservedFromStock,
        sourceOnHand,
        sourceIncoming,
      });
    }
    return out;
  }

  /** Сводка резерва для списка поставок. */
  async enrichSuppliesListWithReserveTotals(supplies, { profileId } = {}) {
    if (!repositoryFactory.isUsingPostgreSQL() || !Array.isArray(supplies) || !supplies.length) {
      return supplies;
    }

    const deductBySupply = new Map(
      supplies.map((s) => [Number(s.id), s.deductStock === true])
    );
    const reserveSupplyIds = supplies
      .map((s) => Number(s.id))
      .filter((id) => Number.isFinite(id) && id > 0 && deductBySupply.get(id) === true);

    if (!reserveSupplyIds.length) {
      return supplies.map((s) => ({
        ...s,
        reservedFromStockTotal: 0,
        reservedFromIncomingTotal: 0,
      }));
    }

    const itemsR = await query(
      `SELECT i.id, i.fbo_supply_id, i.product_id
       FROM fbo_supply_items i
       WHERE i.fbo_supply_id = ANY($1::bigint[])
       ORDER BY i.fbo_supply_id, i.id`,
      [reserveSupplyIds]
    );
    const allItems = (itemsR.rows || []).map((row) => ({
      id: row.id,
      fboSupplyId: row.fbo_supply_id,
      productId: row.product_id,
    }));

    const productIds = [
      ...new Set(
        allItems
          .map((it) => Number(it.productId))
          .filter((id) => Number.isFinite(id) && id > 0)
      ),
    ];

    const breakdown = await this._computeReserveBreakdownByItem(productIds, { profileId });

    const totalsBySupply = new Map();
    for (const item of allItems) {
      const sid = Number(item.fboSupplyId);
      const b = breakdown.get(String(item.id));
      if (!b) continue;
      if (!totalsBySupply.has(sid)) {
        totalsBySupply.set(sid, { reservedFromStockTotal: 0, reservedFromIncomingTotal: 0 });
      }
      const t = totalsBySupply.get(sid);
      t.reservedFromStockTotal += Number(b.reservedFromStock) || 0;
      t.reservedFromIncomingTotal += Number(b.reservedFromIncoming) || 0;
    }

    return supplies.map((s) => {
      const sid = Number(s.id);
      if (deductBySupply.get(sid) !== true) {
        return { ...s, reservedFromStockTotal: 0, reservedFromIncomingTotal: 0 };
      }
      const t = totalsBySupply.get(sid);
      if (!t) {
        return { ...s, reservedFromStockTotal: 0, reservedFromIncomingTotal: 0 };
      }
      return { ...s, ...t };
    });
  }

  /**
   * Перераспределить резерв по всем активным строкам товара (FIFO по ready_at).
   */
  async rebalanceReservesForProduct(productId, { profileId, skipMarketplaceSync = false } = {}) {
    if (!repositoryFactory.isUsingPostgreSQL()) return;
    const pid = Number(productId);
    if (!Number.isFinite(pid) || pid < 1) return;

    const applyMeta =
      skipMarketplaceSync === true
        ? { skip_marketplace_sync: true, fbo_bulk_rebalance: true }
        : {};

    // Без runWithProductStockLock: applyChange уже берёт pg_advisory_xact_lock по product_id.
    // Сессионная advisory-блокировка здесь вешала бы applyChange на другом соединении.
    const queue = await findFboReserveQueueByProduct(pid, profileId);
    const allItemIds = new Set(queue.map((r) => String(r.supply_item_id)));
    const isKit = await isKitProductId(pid);

    const unreserveQueue = [...queue].sort(compareSupplyRowsForUnreserve);
    for (const row of unreserveQueue) {
      const itemId = row.supply_item_id;
      const label = row.external_shipment_number
        ? `FBO ${row.external_shipment_number}`
        : `FBO поставка №${row.fbo_supply_id}`;
      const nets = await getFboItemReserveNetByProductWarehouse(itemId);
      for (const { productId, warehouseId, net } of nets) {
        if (net <= 0) continue;
        await applyFboReserveDelta({
          productId,
          warehouseId,
          supplyId: row.fbo_supply_id,
          supplyItemId: itemId,
          delta: -net,
          reason: `Пересчёт резерва FBO (${label})`,
          extraMeta: applyMeta,
        }).catch((err) => logFboReserveFailure(`unreserve item ${itemId}`, err));
      }
    }

    const sourceWarehouseIds = await getFboSourceWarehouseIds(profileId);
    const fallbackWh = normalizeWarehouseId(
      queue.find((row) => Number(row.deduction_warehouse_id) > 0)?.deduction_warehouse_id
    );
    const stockWarehouseIds =
      sourceWarehouseIds.length > 0
        ? sourceWarehouseIds
        : fallbackWh != null
          ? [fallbackWh]
          : [];

    if (isKit) {
      for (const row of queue) {
        const itemId = row.supply_item_id;
        const supplyId = row.fbo_supply_id;
        const target = Math.max(0, parseInt(row.quantity, 10) || 0);
        if (target <= 0) continue;
        const label = row.external_shipment_number
          ? `FBO ${row.external_shipment_number}`
          : `FBO поставка №${supplyId}`;
        await applyKitFboReserve(pid, target, {
          supplyId,
          supplyItemId: itemId,
          stockWarehouseIds,
          deductionWarehouseId: row.deduction_warehouse_id,
          label,
          applyMeta,
        }).catch((err) => logFboReserveFailure(`kit reserve item ${itemId}`, err));
      }
    } else {
      const poolByWh = new Map();
      for (const warehouseId of stockWarehouseIds) {
        poolByWh.set(warehouseId, await getWarehouseReservableUnits(pid, warehouseId));
      }

      for (const row of queue) {
        const itemId = row.supply_item_id;
        const supplyId = row.fbo_supply_id;
        const target = Math.max(0, parseInt(row.quantity, 10) || 0);
        if (target <= 0) continue;

        let need = target;
        const label = row.external_shipment_number
          ? `FBO ${row.external_shipment_number}`
          : `FBO поставка №${supplyId}`;

        for (const warehouseId of stockWarehouseIds) {
          if (need <= 0) break;
          let pool = poolByWh.get(warehouseId) || 0;
          if (pool <= 0) continue;
          const add = Math.min(need, pool);
          try {
            await applyFboReserveDelta({
              productId: pid,
              warehouseId,
              supplyId,
              supplyItemId: itemId,
              delta: add,
              reason: `Резерв FBO (${label})`,
              extraMeta: applyMeta,
            });
            poolByWh.set(warehouseId, pool - add);
            need -= add;
          } catch (err) {
            logFboReserveFailure(`product ${pid} item ${itemId} wh ${warehouseId}`, err);
          }
        }
      }
    }

    // Снятие «осиротевшего» резерва только в рамках текущего товара.
    // Резерв комплектующих (meta.kit_product_id) не трогаем при пересчёте одиночного SKU —
    // иначе rebalanceReservesForProduct(компонент) снимает резерв активных строк комплекта.
    const orphanR = isKit
      ? await query(
          `SELECT DISTINCT sm.meta->>'fbo_supply_item_id' AS item_id,
                  sm.meta->>'fbo_supply_id' AS supply_id
           FROM stock_movements sm
           WHERE sm.meta->>'kit_product_id' = $1
             AND sm.type IN ('reserve', 'unreserve')
             AND sm.meta ? 'fbo_supply_item_id'
             AND sm.meta->>'fbo_supply_item_id' ~ '^[0-9]+$'`,
          [String(pid)]
        )
      : await query(
          `SELECT DISTINCT sm.meta->>'fbo_supply_item_id' AS item_id,
                  sm.meta->>'fbo_supply_id' AS supply_id
           FROM stock_movements sm
           INNER JOIN fbo_supply_items si ON si.id = (sm.meta->>'fbo_supply_item_id')::bigint
           WHERE sm.product_id = $1
             AND si.product_id = $1
             AND sm.type IN ('reserve', 'unreserve')
             AND sm.meta ? 'fbo_supply_item_id'
             AND sm.meta->>'fbo_supply_item_id' ~ '^[0-9]+$'`,
          [pid]
        );
    for (const or of orphanR.rows || []) {
      if (allItemIds.has(String(or.item_id))) continue;
      const nets = await getFboItemReserveNetByProductWarehouse(or.item_id);
      for (const { productId, warehouseId, net } of nets) {
        if (net <= 0) continue;
        await applyFboReserveDelta({
          productId,
          warehouseId,
          supplyId: or.supply_id,
          supplyItemId: or.item_id,
          delta: -net,
          reason: 'Снятие резерва FBO (строка неактивна)',
          extraMeta: applyMeta,
        }).catch((err) => logFboReserveFailure(`orphan item ${or.item_id}`, err));
      }
    }
  }

  async rebalanceReservesForSupply(supplyId, { profileId } = {}) {
    if (!repositoryFactory.isUsingPostgreSQL()) return;
    const r = await query(
      `SELECT DISTINCT product_id FROM fbo_supply_items
       WHERE fbo_supply_id = $1 AND product_id IS NOT NULL`,
      [supplyId]
    );
    for (const row of r.rows || []) {
      await this.rebalanceReservesForProduct(row.product_id, { profileId });
    }
  }

  /** Пересчёт резерва по всем товарам активных поставок аккаунта. */
  async rebalanceReservesForProfile(profileId, { skipMarketplaceSync = true } = {}) {
    if (!repositoryFactory.isUsingPostgreSQL()) return { products: 0, movements: 0 };
    const pid = normalizeProfileId(profileId);
    if (pid == null) return { products: 0, movements: 0 };

    const lockR = await query(`SELECT pg_try_advisory_lock($1::bigint) AS ok`, [900_000_000 + pid]);
    if (lockR.rows?.[0]?.ok !== true) {
      console.warn(`[FBO rebalance] profile ${pid}: пересчёт уже выполняется, пропуск`);
      return { products: 0, movements: 0, skipped: true };
    }

    try {
      const r = await query(
        `SELECT DISTINCT si.product_id
         FROM fbo_supply_items si
         INNER JOIN fbo_supplies s ON s.id = si.fbo_supply_id
         WHERE s.profile_id = $1
           AND s.deduction_warehouse_id IS NOT NULL
           AND COALESCE(s.deduct_stock, false) = true
           AND s.status = ANY($2::text[])
           AND si.product_id IS NOT NULL
         ORDER BY si.product_id`,
        [pid, FBO_RESERVE_ACTIVE_STATUSES]
      );
      const productIds = (r.rows || [])
        .map((row) => Number(row.product_id))
        .filter((id) => Number.isFinite(id) && id > 0);

      const movBeforeR = await query(
        `SELECT COUNT(*)::int AS cnt FROM stock_movements WHERE meta ? 'fbo_supply_item_id'`
      );
      const movBefore = Number(movBeforeR.rows[0]?.cnt) || 0;

      let done = 0;
      for (const productId of productIds) {
        await this.rebalanceReservesForProduct(productId, { profileId: pid, skipMarketplaceSync });
        done += 1;
        if (done % 25 === 0 || done === productIds.length) {
          console.log(`[FBO rebalance] ${done}/${productIds.length} товаров`);
        }
      }

      const movAfterR = await query(
        `SELECT COUNT(*)::int AS cnt FROM stock_movements WHERE meta ? 'fbo_supply_item_id'`
      );
      const movAfter = Number(movAfterR.rows[0]?.cnt) || 0;

      return { products: productIds.length, movements: movAfter - movBefore };
    } finally {
      await query(`SELECT pg_advisory_unlock($1::bigint)`, [900_000_000 + pid]).catch(() => {});
    }
  }

  async releaseReservesForSupplyItemIds(
    supplyId,
    itemIds,
    { profileId, skipMarketplaceSync = false } = {}
  ) {
    if (!repositoryFactory.isUsingPostgreSQL()) return;
    const ids = [...new Set((itemIds || []).map((id) => String(id)).filter(Boolean))];
    if (!ids.length) return;

    const netsR = await query(
      `SELECT meta->>'fbo_supply_item_id' AS supply_item_id,
              product_id,
              warehouse_id,
              GREATEST(0, COALESCE(SUM(${NET_RESERVED_MOVEMENT_ROW_CASE_SQL}), 0))::int AS net
       FROM stock_movements
       WHERE meta->>'fbo_supply_item_id' = ANY($1::text[])
         AND type IN ('reserve', 'unreserve')
       GROUP BY meta->>'fbo_supply_item_id', product_id, warehouse_id
       HAVING GREATEST(0, COALESCE(SUM(${NET_RESERVED_MOVEMENT_ROW_CASE_SQL}), 0)) > 0`,
      [ids]
    );

    const label = `Снятие резерва FBO (поставка №${supplyId})`;
    const extraMeta = skipMarketplaceSync
      ? { skip_marketplace_sync: true, fbo_bulk_rebalance: true }
      : {};
    const affectedProducts = new Set();

    for (const row of netsR.rows || []) {
      const net = parseInt(row.net ?? 0, 10) || 0;
      if (net <= 0) continue;
      const productId = Number(row.product_id);
      if (Number.isFinite(productId) && productId > 0) affectedProducts.add(productId);
      await applyFboReserveDelta({
        productId: row.product_id,
        warehouseId: row.warehouse_id,
        supplyId,
        supplyItemId: row.supply_item_id,
        delta: -net,
        reason: label,
        extraMeta,
      }).catch(() => {});
    }

    if (skipMarketplaceSync && affectedProducts.size > 0) {
      try {
        const { syncProductReservedQuantityFromJournal } = await import('./sellableQuantity.service.js');
        for (const productId of affectedProducts) {
          await syncProductReservedQuantityFromJournal(productId).catch(() => {});
        }
      } catch {
        /* ignore */
      }
    }
  }

  async releaseReservesForSupply(supplyId, { profileId, skipMarketplaceSync = false } = {}) {
    if (!repositoryFactory.isUsingPostgreSQL()) return;
    const pid = normalizeProfileId(profileId);
    const itemsR = await query(
      `SELECT si.id
       FROM fbo_supply_items si
       INNER JOIN fbo_supplies s ON s.id = si.fbo_supply_id
       WHERE si.fbo_supply_id = $1
         AND ($2::bigint IS NULL OR s.profile_id = $2)
         AND si.product_id IS NOT NULL`,
      [supplyId, pid]
    );
    const itemIds = (itemsR.rows || []).map((row) => String(row.id));
    await this.releaseReservesForSupplyItemIds(supplyId, itemIds, {
      profileId,
      skipMarketplaceSync,
    });
  }

  async onSupplyStockEvent(productId, warehouseId, { profileId } = {}) {
    const pid = Number(productId);
    if (!Number.isFinite(pid) || pid < 1) return;
    const parentKitIds = await recalculateKitsForComponent(pid, { profileId });
    const ownFboQueue = await findFboReserveQueueByProduct(pid, profileId);
    const hasOwnFboLines = ownFboQueue.length > 0;

    // Комплектующее без собственных строк FBO: резерв ведётся на SKU комплекта.
    if (!hasOwnFboLines && parentKitIds.length > 0) {
      for (const kitId of parentKitIds) {
        await this.rebalanceReservesForProduct(kitId, { profileId });
      }
      return;
    }

    await this.rebalanceReservesForProduct(pid, { profileId });
    for (const kitId of parentKitIds) {
      await this.rebalanceReservesForProduct(kitId, { profileId });
    }
  }
}

export default new FboSupplyReserveService();
