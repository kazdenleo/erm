/**
 * Расчёт «Доступно».
 * - UI (по умолчанию): наличие на складе + поставщики.
 * - Маркетплейсы (forMarketplace): то же − резерв под заказы (чтобы не принимать лишние заказы).
 */

import { query } from '../config/database.js';
import repositoryFactory from '../config/repository-factory.js';
import { isKitProductId, readKitMarketplaceStockFromDb, readKitStockFromDb } from './kitStock.service.js';

/** Резерв из журнала (как в таблице остатков на клиенте), а не устаревший products.reserved_quantity. */
export async function getReservedQuantityFromMovements(productId) {
  const pid = typeof productId === 'string' ? parseInt(productId, 10) : Number(productId);
  if (!Number.isFinite(pid) || pid < 1) return 0;
  try {
    const r = await query(
      `SELECT GREATEST(0, COALESCE(SUM(
          CASE
            WHEN type = 'reserve' THEN -(quantity_change::numeric)
            WHEN type = 'unreserve' THEN -(quantity_change::numeric)
            ELSE 0
          END
        ), 0))::int AS rv
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
      `SELECT COALESCE(SUM(quantity), 0)::int AS quantity
       FROM product_warehouse_stock
       WHERE product_id = $1`,
      [pid]
    );
    onHand = Number(r.rows[0]?.quantity ?? 0) || 0;
  }

  let suppliers = 0;
  if (repositoryFactory.isUsingPostgreSQL()) {
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

  let reserved = 0;
  if (opts.forMarketplace === true) {
    reserved = await getReservedQuantityFromMovements(pid);
  }

  const available = Math.max(0, Math.floor(onHand + suppliers - reserved));
  return {
    available,
    onHand,
    suppliers,
    ...(opts.forMarketplace
      ? {
          reserved,
          displayAvailable: Math.max(0, Math.floor(onHand + suppliers))
        }
      : {})
  };
}

/**
 * Доступно под резерв заказа: наличие на складе (PWS) + «в пути» − резерв из журнала.
 * Без остатков поставщиков. Единая формула для orders / stockMovements / kitStock.
 */
export async function getReservableSupplyUnits(productId, opts = {}) {
  const pid = typeof productId === 'string' ? parseInt(productId, 10) : Number(productId);
  if (!Number.isFinite(pid) || pid < 1) return 0;

  const metrics = await computeAvailableQuantity(pid, {
    warehouseId: opts.warehouseId ?? opts.warehouse_id ?? null,
    profileId: opts.profileId ?? null
  });
  let incoming = 0;
  try {
    const r = await query(
      `SELECT COALESCE(incoming_quantity, 0)::int AS incoming_quantity FROM products WHERE id = $1`,
      [pid]
    );
    incoming = Number(r.rows[0]?.incoming_quantity ?? 0) || 0;
  } catch {
    incoming = 0;
  }
  const reserved =
    opts.reservedMap instanceof Map
      ? opts.reservedMap.get(pid) || 0
      : await getReservedQuantityFromMovements(pid);
  return Math.max(0, (Number(metrics.onHand) || 0) + incoming - reserved);
}

export default {
  computeAvailableQuantity,
  getReservedQuantityFromMovements,
  getReservableSupplyUnits
};
