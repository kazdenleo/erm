/**
 * Расчёт «Доступно».
 * - UI (по умолчанию): наличие на складе + поставщики.
 * - Маркетплейсы (forMarketplace): то же − резерв под заказы (чтобы не принимать лишние заказы).
 */

import { query } from '../config/database.js';
import repositoryFactory from '../config/repository-factory.js';

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
    const pr = await query(
      `SELECT COALESCE(reserved_quantity, 0)::int AS reserved FROM products WHERE id = $1`,
      [pid]
    );
    reserved = Number(pr.rows[0]?.reserved ?? 0) || 0;
  }

  const available = Math.max(0, Math.floor(onHand + suppliers - reserved));
  return { available, onHand, suppliers, ...(opts.forMarketplace ? { reserved } : {}) };
}

export default { computeAvailableQuantity };
