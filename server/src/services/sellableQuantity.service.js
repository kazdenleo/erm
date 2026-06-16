/**
 * Расчёт «Доступно».
 * Формула (таблица остатков): наличие + в пути + поставщики − резерв.
 * - Маркетплейсы (forMarketplace): для комплектов — число в скобках «Доступно» (целые + собираемость), для SKU — «Доступно».
 */

import { query } from '../config/database.js';
import repositoryFactory from '../config/repository-factory.js';
import { isKitProductId, readKitMarketplaceStockFromDb, readKitStockFromDb } from './kitStock.service.js';
import {
  NET_RESERVED_MOVEMENT_ROW_CASE_SQL,
  NET_RESERVED_SUM_EXPR_SQL,
  RAW_RESERVED_SUM_EXPR_SQL,
  allocateWarehouseScopedReserved,
  allocateWarehouseScopedIncoming,
  parseStockMovementWarehouseId,
  warehouseScopedOnHandForAllocation,
} from '../constants/netReservedStockSql.js';

export { NET_RESERVED_MOVEMENT_ROW_CASE_SQL, NET_RESERVED_SUM_EXPR_SQL, RAW_RESERVED_SUM_EXPR_SQL };

/**
 * Привести products.reserved_quantity к журналу (или к правилу отображения комплекта).
 * Вызывается при загрузке истории и списка остатков, если колонка «устарела».
 */
export async function syncProductReservedQuantityFromJournal(productId, opts = {}) {
  const pid = typeof productId === 'string' ? parseInt(productId, 10) : Number(productId);
  if (!Number.isFinite(pid) || pid < 1) return 0;

  let rv =
    opts.reserved != null && Number.isFinite(Number(opts.reserved))
      ? Math.max(0, Math.floor(Number(opts.reserved)))
      : null;

  if (rv == null) {
    const { isKitProductId, readKitDisplayReservedQuantity } = await import('./kitStock.service.js');
    if (await isKitProductId(pid)) {
      rv = await readKitDisplayReservedQuantity(pid, opts);
    } else {
      rv = await getReservedQuantityFromMovements(pid);
    }
  }

  try {
    await query(
      `UPDATE products SET reserved_quantity = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [rv, pid]
    );
  } catch {
    /* ignore */
  }
  return rv;
}

async function queryWarehouseScopedReservedFromMovements(run, productId, whId) {
  const pid = typeof productId === 'string' ? parseInt(productId, 10) : Number(productId);
  const [strictR, nullR, onHandR, whOnHandR] = await Promise.all([
    run(
      `SELECT ${NET_RESERVED_SUM_EXPR_SQL}::int AS rv
       FROM stock_movements
       WHERE product_id = $1 AND type IN ('reserve', 'unreserve') AND warehouse_id = $2`,
      [pid, whId]
    ),
    run(
      `SELECT ${NET_RESERVED_SUM_EXPR_SQL}::int AS rv
       FROM stock_movements
       WHERE product_id = $1 AND type IN ('reserve', 'unreserve') AND warehouse_id IS NULL`,
      [pid]
    ),
    run(
      `SELECT COALESCE(SUM(quantity), 0)::int AS pws_qty,
              (SELECT COALESCE(quantity, 0)::int FROM products WHERE id = $1) AS product_qty
       FROM product_warehouse_stock
       WHERE product_id = $1`,
      [pid]
    ),
    run(
      `SELECT COALESCE(quantity, 0)::int AS qty
       FROM product_warehouse_stock
       WHERE product_id = $1 AND warehouse_id = $2`,
      [pid, whId]
    )
  ]);
  const strict = Number(strictR.rows[0]?.rv ?? 0) || 0;
  const nullReserve = Number(nullR.rows[0]?.rv ?? 0) || 0;
  const totalOnHand = Number(onHandR.rows[0]?.pws_qty ?? 0) || 0;
  const legacyProductQty = Number(onHandR.rows[0]?.product_qty ?? 0) || 0;
  const whOnHand = warehouseScopedOnHandForAllocation({
    whOnHand: Number(whOnHandR.rows[0]?.qty ?? 0) || 0,
    totalOnHand,
    legacyProductQty
  });
  return allocateWarehouseScopedReserved({
    strict,
    nullReserve,
    whOnHand,
    totalOnHand,
    legacyProductQty
  });
}

async function readWarehouseScopedIncomingWithClient(run, productId, whId) {
  const pid = typeof productId === 'string' ? parseInt(productId, 10) : Number(productId);
  const wh = Number(whId);
  if (!Number.isFinite(pid) || pid < 1 || !Number.isFinite(wh) || wh < 1) return 0;

  const [strictR, nullR, whOnHandR, totalOnHandR, globalR, journalR, stockJournalR, whJournalR] =
    await Promise.all([
    run(
      `SELECT COALESCE(SUM(quantity_change), 0)::int AS inc
       FROM stock_movements
       WHERE product_id = $1 AND LOWER(TRIM(type::text)) = 'incoming' AND warehouse_id = $2`,
      [pid, wh]
    ),
    run(
      `SELECT COALESCE(SUM(quantity_change), 0)::int AS inc
       FROM stock_movements
       WHERE product_id = $1 AND LOWER(TRIM(type::text)) = 'incoming' AND warehouse_id IS NULL`,
      [pid]
    ),
    run(
      `SELECT COALESCE(quantity, 0)::int AS qty
       FROM product_warehouse_stock WHERE product_id = $1 AND warehouse_id = $2`,
      [pid, wh]
    ),
    run(
      `SELECT COALESCE(SUM(quantity), 0)::int AS qty
       FROM product_warehouse_stock WHERE product_id = $1`,
      [pid]
    ),
    run(
      `SELECT COALESCE(incoming_quantity, 0)::int AS inc, COALESCE(quantity, 0)::int AS legacy_qty
       FROM products WHERE id = $1`,
      [pid]
    ),
    run(
      `SELECT 1 AS ok
       FROM stock_movements
       WHERE product_id = $1 AND LOWER(TRIM(type::text)) = 'incoming'
       LIMIT 1`,
      [pid]
    ),
    run(
      `SELECT 1 AS ok FROM stock_movements WHERE product_id = $1 LIMIT 1`,
      [pid]
    ),
    run(
      `SELECT 1 AS ok
       FROM stock_movements
       WHERE product_id = $1
         AND LOWER(TRIM(type::text)) = 'incoming'
         AND warehouse_id = $2
       LIMIT 1`,
      [pid, wh]
    )
  ]);

  const totalOnHand = Number(totalOnHandR.rows[0]?.qty ?? 0) || 0;
  const legacyProductQty = Number(globalR.rows[0]?.legacy_qty ?? 0) || 0;
  const whOnHand = warehouseScopedOnHandForAllocation({
    whOnHand: Number(whOnHandR.rows[0]?.qty ?? 0) || 0,
    totalOnHand,
    legacyProductQty
  });

  return allocateWarehouseScopedIncoming({
    strictRaw: Number(strictR.rows[0]?.inc ?? 0) || 0,
    nullRaw: Number(nullR.rows[0]?.inc ?? 0) || 0,
    whOnHand,
    totalOnHand: totalOnHand > 0 ? totalOnHand : legacyProductQty,
    legacyProductQty,
    globalIncoming: Number(globalR.rows[0]?.inc ?? 0) || 0,
    hasIncomingJournal: (journalR.rows?.length ?? 0) > 0,
    hasStockJournal: (stockJournalR.rows?.length ?? 0) > 0,
    hasWarehouseIncomingJournal: (whJournalR.rows?.length ?? 0) > 0
  });
}

/** Резерв из журнала (как в таблице остатков на клиенте), а не устаревший products.reserved_quantity. */
export async function getReservedQuantityFromMovements(productId, opts = {}) {
  const pid = typeof productId === 'string' ? parseInt(productId, 10) : Number(productId);
  if (!Number.isFinite(pid) || pid < 1) return 0;
  const whId = parseStockMovementWarehouseId(opts.warehouseId ?? opts.warehouse_id);
  try {
    if (whId != null) {
      return await queryWarehouseScopedReservedFromMovements(query, pid, whId);
    }
    const r = await query(
      `SELECT ${NET_RESERVED_SUM_EXPR_SQL}::int AS rv
       FROM stock_movements
       WHERE product_id = $1 AND type IN ('reserve', 'unreserve')`,
      [pid]
    );
    return Number(r.rows[0]?.rv ?? 0) || 0;
  } catch {
    const pr = await query(
      `SELECT COALESCE(reserved_quantity, 0)::int AS reserved FROM products WHERE id = $1`,
      [pid]
    );
    return Number(pr.rows[0]?.reserved ?? 0) || 0;
  }
}

/**
 * @param {number|string} productId
 * @param {{ warehouseId?: number|string|null, profileId?: number|string|null, forMarketplace?: boolean }} [opts]
 * @returns {Promise<{ available: number, onHand: number, suppliers: number, reserved?: number }>}
 */
export async function computeAvailableQuantity(productId, opts = {}) {
  const pid = typeof productId === 'string' ? parseInt(productId, 10) : Number(productId);
  if (!Number.isFinite(pid) || pid < 1) {
    return { available: 0, onHand: 0, suppliers: 0 };
  }

  if (await isKitProductId(pid)) {
    if (opts.forMarketplace === true) {
      const mp = await readKitMarketplaceStockFromDb(pid, opts);
      return {
        available: mp.available,
        onHand: mp.onHand,
        suppliers: mp.suppliers,
        reserved: mp.reserved,
        displayAvailable: mp.displayAvailable
      };
    }
    const ui = await readKitStockFromDb(pid, opts);
    return {
      available: ui.available,
      onHand: ui.onHand,
      suppliers: ui.suppliers,
      reserved: ui.reserved
    };
  }

  const warehouseId =
    opts.warehouseId != null && String(opts.warehouseId).trim() !== ''
      ? typeof opts.warehouseId === 'string'
        ? parseInt(opts.warehouseId, 10)
        : Number(opts.warehouseId)
      : null;

  let onHand = 0;
  if (warehouseId != null && Number.isFinite(warehouseId) && warehouseId > 0) {
    const r = await query(
      `SELECT COALESCE(quantity, 0)::int AS quantity
       FROM product_warehouse_stock
       WHERE product_id = $1 AND warehouse_id = $2`,
      [pid, warehouseId]
    );
    onHand = Number(r.rows[0]?.quantity ?? 0) || 0;
  } else {
    const r = await query(
      `SELECT COALESCE(SUM(quantity), 0)::int AS pws_qty,
              (SELECT COALESCE(quantity, 0)::int FROM products WHERE id = $1) AS product_qty
       FROM product_warehouse_stock
       WHERE product_id = $1`,
      [pid]
    );
    const pwsOnHand = Number(r.rows[0]?.pws_qty ?? 0) || 0;
    const productQty = Number(r.rows[0]?.product_qty ?? 0) || 0;
    onHand = Math.max(pwsOnHand, productQty);
  }

  let incoming = 0;
  try {
    const ir = await query(
      `SELECT COALESCE(incoming_quantity, 0)::int AS incoming_quantity FROM products WHERE id = $1`,
      [pid]
    );
    incoming = Number(ir.rows[0]?.incoming_quantity ?? 0) || 0;
  } catch {
    incoming = 0;
  }

  let suppliers = 0;
  const supplierSyncOn = opts.supplierSyncEnabled !== false;
  if (supplierSyncOn && repositoryFactory.isUsingPostgreSQL()) {
    const repo = repositoryFactory.getSupplierStocksRepository();
    if (repo && typeof repo.findBreakdownByProductIds === 'function') {
      const mainWarehouseId =
        warehouseId != null && Number.isFinite(warehouseId) && warehouseId > 0
          ? String(warehouseId)
          : null;
      const rows = await repo.findBreakdownByProductIds([pid], {
        mainWarehouseId,
        profileId: opts.profileId ?? null
      });
      suppliers = (rows || []).reduce((s, row) => s + (Number(row.stock) || 0), 0);
    }
  }

  const reserved =
    opts.forMarketplace === true ? await getReservedQuantityFromMovements(pid, opts) : 0;

  const available = Math.max(0, Math.floor(onHand + incoming + suppliers - reserved));
  return {
    available,
    onHand,
    incoming,
    suppliers,
    ...(opts.forMarketplace
      ? {
          reserved,
          displayAvailable: available
        }
      : {})
  };
}

/**
 * «Доступно» без поставщиков — как в таблице остатков: (наличие + в пути + поставщики − резерв) − поставщики.
 */
export function computeOwnWarehouseAvailable({ onHand = 0, incoming = 0, reserved = 0 } = {}) {
  return Math.max(
    0,
    Math.floor((Number(onHand) || 0) + (Number(incoming) || 0) - (Number(reserved) || 0))
  );
}

/** Резерв из журнала в рамках открытой транзакции (для проверки перед записью движения). */
export async function getReservedQuantityFromMovementsWithClient(client, productId, opts = {}) {
  const pid = typeof productId === 'string' ? parseInt(productId, 10) : Number(productId);
  if (!Number.isFinite(pid) || pid < 1) return 0;
  const run = client && typeof client.query === 'function' ? client.query.bind(client) : query;
  const whId = parseStockMovementWarehouseId(opts.warehouseId ?? opts.warehouse_id);
  try {
    if (whId != null) {
      return await queryWarehouseScopedReservedFromMovements(run, pid, whId);
    }
    const r = await run(
      `SELECT ${NET_RESERVED_SUM_EXPR_SQL}::int AS rv
       FROM stock_movements
       WHERE product_id = $1 AND type IN ('reserve', 'unreserve')`,
      [pid]
    );
    return Number(r.rows[0]?.rv ?? 0) || 0;
  } catch {
    return 0;
  }
}

/** Сырой нетто-резерв из журнала (без GREATEST) в рамках транзакции. */
export async function getRawReservedQuantityFromMovementsWithClient(client, productId) {
  const pid = typeof productId === 'string' ? parseInt(productId, 10) : Number(productId);
  if (!Number.isFinite(pid) || pid < 1) return 0;
  const run = client && typeof client.query === 'function' ? client.query.bind(client) : query;
  try {
    const r = await run(
      `SELECT ${RAW_RESERVED_SUM_EXPR_SQL}::numeric AS rv
       FROM stock_movements
       WHERE product_id = $1 AND type IN ('reserve', 'unreserve')`,
      [pid]
    );
    return Math.max(0, Math.floor(Number(r.rows[0]?.rv ?? 0) || 0));
  } catch {
    return 0;
  }
}

/**
 * Снимок поставки товара: наличие (сумма по всем складам или один склад), «в пути», резерв, доступно, потолок резерва.
 * При warehouseId «в пути» — по журналу incoming с warehouse_id (и доля legacy без склада).
 * @param {{ warehouseId?: number|string|null, reservedMap?: Map }} [opts]
 */
export async function getProductSupplySnapshotWithClient(client, productId, opts = {}) {
  const pid = typeof productId === 'string' ? parseInt(productId, 10) : Number(productId);
  if (!Number.isFinite(pid) || pid < 1) {
    return { onHand: 0, incoming: 0, reserved: 0, reservedRaw: 0, available: 0, supplyCap: 0 };
  }

  const run = client && typeof client.query === 'function' ? client.query.bind(client) : query;

  const whRaw = opts.warehouseId ?? opts.warehouse_id ?? null;
  const whId =
    whRaw != null && String(whRaw).trim() !== ''
      ? typeof whRaw === 'string'
        ? parseInt(whRaw, 10)
        : Number(whRaw)
      : null;
  const warehouseScoped = Number.isFinite(whId) && whId > 0;

  let onHand = 0;
  if (warehouseScoped) {
    const onHandR = await run(
      `SELECT COALESCE(quantity, 0)::int AS pws_qty
       FROM product_warehouse_stock
       WHERE product_id = $1 AND warehouse_id = $2`,
      [pid, whId]
    );
    onHand = Number(onHandR.rows[0]?.pws_qty ?? 0) || 0;
  } else {
    const onHandR = await run(
      `SELECT COALESCE(SUM(quantity), 0)::int AS pws_qty
       FROM product_warehouse_stock
       WHERE product_id = $1`,
      [pid]
    );
    const pwsOnHand = Number(onHandR.rows[0]?.pws_qty ?? 0) || 0;
    let productQty = 0;
    try {
      const pq = await run(`SELECT COALESCE(quantity, 0)::int AS quantity FROM products WHERE id = $1`, [
        pid
      ]);
      productQty = Number(pq.rows[0]?.quantity ?? 0) || 0;
    } catch {
      productQty = 0;
    }
    onHand = Math.max(pwsOnHand, productQty);
  }

  let incoming = 0;
  try {
    if (warehouseScoped) {
      incoming = await readWarehouseScopedIncomingWithClient(run, pid, whId);
    } else {
      const pr = await run(
        `SELECT COALESCE(incoming_quantity, 0)::int AS incoming_quantity FROM products WHERE id = $1`,
        [pid]
      );
      incoming = Number(pr.rows[0]?.incoming_quantity ?? 0) || 0;
    }
  } catch {
    incoming = 0;
  }

  const whReserveOpts = warehouseScoped ? { warehouseId: whId } : {};
  const reservedWarehouseScoped = warehouseScoped
    ? await getReservedQuantityFromMovementsWithClient(client, pid, whReserveOpts)
    : null;
  const reserved =
    opts.reservedMap instanceof Map
      ? opts.reservedMap.get(pid) || 0
      : warehouseScoped
        ? reservedWarehouseScoped
        : await getReservedQuantityFromMovementsWithClient(client, pid);
  const reservedRaw =
    opts.reservedMap instanceof Map
      ? reserved
      : await getRawReservedQuantityFromMovementsWithClient(client, pid);

  const supplyCap = onHand + incoming;
  // На конкретном складе «доступно» — по резерву, привязанному к этому складу (не глобальному).
  const reservedForAvailable = warehouseScoped ? reservedWarehouseScoped : reservedRaw;
  const available = computeOwnWarehouseAvailable({
    onHand,
    incoming,
    reserved: reservedForAvailable
  });

  return { onHand, incoming, reserved, reservedRaw, available, supplyCap };
}

/**
 * Доступно под резерв: PWS (по складу, если указан) + «в пути» − резерв.
 * При warehouseId резерв считается по движениям этого склада (+ доля legacy без склада).
 */
export async function getReservableSupplyUnitsWithClient(client, productId, opts = {}) {
  const snap = await getProductSupplySnapshotWithClient(client, productId, opts);
  return snap.available;
}

/**
 * Доступно под резерв заказа: наличие на складе (PWS) + «в пути» − резерв из журнала.
 * Без остатков поставщиков (= «Доступно» в таблице остатков минус поставщики).
 */
export async function getReservableSupplyUnits(productId, opts = {}) {
  return getReservableSupplyUnitsWithClient(null, productId, opts);
}

/** Сколько единиц можно зарезервировать сейчас (0 — без записи в журнал). */
export async function getReserveableUnitsWithClient(client, productId, opts = {}) {
  const snap = await getProductSupplySnapshotWithClient(client, productId, opts);
  return Math.max(0, Math.floor(snap.available));
}

export default {
  computeAvailableQuantity,
  computeOwnWarehouseAvailable,
  syncProductReservedQuantityFromJournal,
  getReservedQuantityFromMovements,
  getReservedQuantityFromMovementsWithClient,
  getRawReservedQuantityFromMovementsWithClient,
  getProductSupplySnapshotWithClient,
  getReservableSupplyUnits,
  getReservableSupplyUnitsWithClient,
  getReserveableUnitsWithClient,
  NET_RESERVED_MOVEMENT_ROW_CASE_SQL,
  NET_RESERVED_SUM_EXPR_SQL,
  RAW_RESERVED_SUM_EXPR_SQL
};
