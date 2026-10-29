/**
 * Себестоимость и витрина от поставщика, у которого ещё есть свободный остаток.
 */

import { query } from '../config/database.js';
import repositoryFactory from '../config/repository-factory.js';
import logger from '../utils/logger.js';
import { pickEffectiveSupplierOffer, pricesNearlyEqual } from '../utils/effectiveSupplierOffer.js';
import { sumPurchasableSupplierWarehouseStock } from '../utils/supplierProcurementArrival.js';
import { freeSupplierUnits, sqlOpenSupplierReserved } from '../utils/supplierStockReservation.js';

/**
 * Свободный остаток для цены (закупка в текущее/следующее окно), без обнуления после отсечки.
 */
export async function loadPurchasableSupplierRows(productId) {
  const pid = Number(productId);
  if (!Number.isFinite(pid) || pid < 1 || !repositoryFactory.isUsingPostgreSQL()) return [];

  const r = await query(
    `SELECT ss.supplier_id, ss.stock, ss.price, ss.warehouses, s.api_config,
            ${sqlOpenSupplierReserved('ss.supplier_id', 'ss.product_id')}::int AS reserved
       FROM supplier_stocks ss
       INNER JOIN suppliers s ON s.id = ss.supplier_id
      WHERE ss.product_id = $1
        AND COALESCE(ss.stock, 0) > 0
        AND ss.price IS NOT NULL
        AND CAST(ss.price AS NUMERIC) > 0`,
    [pid]
  );

  const rows = [];
  for (const row of r.rows || []) {
    const purchasable = sumPurchasableSupplierWarehouseStock({
      apiConfig: row.api_config,
      stockWarehouses: row.warehouses,
      aggregatedStock: row.stock,
    });
    const free = freeSupplierUnits(purchasable, row.reserved);
    if (free <= 0) continue;
    rows.push({
      supplier_id: Number(row.supplier_id),
      price: Number(row.price),
      stock: free,
    });
  }
  return rows;
}

export async function getEffectiveSupplierOffer(productId) {
  const rows = await loadPurchasableSupplierRows(productId);
  return pickEffectiveSupplierOffer(rows);
}

export async function getEffectiveSupplierCost(productId) {
  const offer = await getEffectiveSupplierOffer(productId);
  return offer?.price ?? null;
}

/**
 * Витрина: только свободный orderable остаток поставщиков на цене дешёвого.
 * @param {Array<{ stock?: number, price?: number, supplier_id?: number }>} breakdownRows
 */
export function marketplaceSupplierQtyFromBreakdown(breakdownRows) {
  const offer = pickEffectiveSupplierOffer(breakdownRows);
  return offer ? offer.freeStockAtPrice : 0;
}

/**
 * Обновить products.cost, если она пустая или совпадает с прайсом поставщика
 * (ручную уникальную себестоимость не трогаем).
 */
export async function syncProductCostFromEffectiveSupplier(productId, effectivePrice) {
  const pid = Number(productId);
  const price = Number(effectivePrice);
  if (!Number.isFinite(pid) || pid < 1 || !Number.isFinite(price) || price <= 0) {
    return { updated: false, previous: null };
  }

  const cur = await query(`SELECT cost FROM products WHERE id = $1 LIMIT 1`, [pid]);
  const previous =
    cur.rows?.[0]?.cost != null && cur.rows[0].cost !== ''
      ? Number(cur.rows[0].cost)
      : null;
  if (previous != null && Number.isFinite(previous) && pricesNearlyEqual(previous, price)) {
    return { updated: false, previous };
  }

  let canUpdate = previous == null || !Number.isFinite(previous);
  if (!canUpdate) {
    const mirrored = await query(
      `SELECT 1
         FROM supplier_stocks
        WHERE product_id = $1
          AND price IS NOT NULL
          AND ABS(CAST(price AS NUMERIC) - $2::numeric) < 0.02
        LIMIT 1`,
      [pid, previous]
    );
    canUpdate = (mirrored.rows?.length ?? 0) > 0;
  }
  if (!canUpdate) return { updated: false, previous, skipped: 'manual_cost' };

  await query(
    `UPDATE products SET cost = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
    [price, pid]
  );
  return { updated: true, previous, next: price };
}

const _recalcTimers = new Map();

/**
 * После смены свободного остатка поставщика — подтянуть себестоимость и мин./продажные цены на МП.
 */
export function scheduleEffectiveCostPriceRecalc(productId, delayMs = 4000) {
  const pid = Number(productId);
  if (!Number.isFinite(pid) || pid < 1) return;
  const prev = _recalcTimers.get(pid);
  if (prev) clearTimeout(prev);
  const t = setTimeout(() => {
    _recalcTimers.delete(pid);
    refreshEffectiveCostAndPrices(pid).catch((e) => {
      logger.warn('[EffectiveSupplierCost] recalc failed', {
        productId: pid,
        message: e?.message || String(e),
      });
    });
  }, Math.max(500, delayMs));
  if (typeof t.unref === 'function') t.unref();
  _recalcTimers.set(pid, t);
}

export async function refreshEffectiveCostAndPrices(productId) {
  const pid = Number(productId);
  if (!Number.isFinite(pid) || pid < 1) return { ok: false };

  const offer = await getEffectiveSupplierOffer(pid);
  if (!offer) return { ok: true, skipped: 'no_free_supplier_stock' };

  const sync = await syncProductCostFromEffectiveSupplier(pid, offer.price);
  if (!sync.updated && sync.skipped === 'manual_cost') {
    return { ok: true, skipped: 'manual_cost', offer };
  }
  if (!sync.updated) {
    return { ok: true, skipped: 'cost_unchanged', offer };
  }

  logger.info('[EffectiveSupplierCost] себестоимость от фактического поставщика', {
    productId: pid,
    previous: sync.previous,
    next: offer.price,
    free: offer.freeStockAtPrice,
    suppliers: offer.supplierIds,
  });

  const { default: pricesService } = await import('./prices.service.js');
  await pricesService.recalculateAndSaveForProduct(pid, {
    useCalculatorCache: true,
  });
  return { ok: true, updated: true, offer, previous: sync.previous };
}

export default {
  getEffectiveSupplierOffer,
  getEffectiveSupplierCost,
  marketplaceSupplierQtyFromBreakdown,
  syncProductCostFromEffectiveSupplier,
  scheduleEffectiveCostPriceRecalc,
  refreshEffectiveCostAndPrices,
  loadPurchasableSupplierRows,
};
