/**
 * Остатки комплектов: всегда из БД по составу kit_components (независимо от фильтров списка).
 * Резерв по заказу на комплект — резерв комплектующих.
 */

import { query } from '../config/database.js';
import { computeAvailableQuantity } from './sellableQuantity.service.js';
import { scheduleWarehouseStockMarketplaceSync } from './marketplaceWarehouseStockSync.service.js';
import logger from '../utils/logger.js';

export function isKitProductType(raw) {
  return String(raw || '').toLowerCase() === 'kit';
}

export async function isKitProductId(productId) {
  const pid = Number(productId);
  if (!Number.isFinite(pid) || pid < 1) return false;
  const r = await query(
    `SELECT product_type FROM products WHERE id = $1 LIMIT 1`,
    [pid]
  );
  return isKitProductType(r.rows[0]?.product_type);
}

/** @returns {Promise<Array<{ component_product_id: number, quantity: number }>>} */
export async function getKitComponents(kitProductId) {
  const kitId = Number(kitProductId);
  if (!Number.isFinite(kitId) || kitId < 1) return [];
  const r = await query(
    `SELECT component_product_id, quantity
     FROM kit_components
     WHERE kit_product_id = $1
     ORDER BY id`,
    [kitId]
  );
  return (r.rows || []).map((row) => ({
    component_product_id: Number(row.component_product_id),
    quantity: Math.max(1, parseInt(row.quantity, 10) || 1)
  }));
}

async function getComponentWarehouseSupply(componentProductId) {
  const pid = Number(componentProductId);
  const pr = await query(
    `SELECT COALESCE(quantity, 0)::int AS quantity,
            COALESCE(incoming_quantity, 0)::int AS incoming_quantity,
            COALESCE(reserved_quantity, 0)::int AS reserved_quantity
     FROM products WHERE id = $1 LIMIT 1`,
    [pid]
  );
  const row = pr.rows[0];
  const actual = Number(row?.quantity ?? 0) || 0;
  const incoming = Number(row?.incoming_quantity ?? 0) || 0;
  const reserved = Number(row?.reserved_quantity ?? 0) || 0;
  return {
    actual,
    incoming,
    reserved,
    availableSupply: Math.max(0, actual + incoming - reserved)
  };
}

/**
 * Остатки комплекта для UI и МП: min(floor(остаток комплектующего / qty в комплекте)).
 */
export async function computeKitDisplayStock(kitProductId, opts = {}) {
  const components = await getKitComponents(kitProductId);
  if (components.length === 0) {
    return { onHand: 0, incoming: 0, reserved: 0, suppliers: 0, available: 0 };
  }

  let minOnHand = Infinity;
  let minIncoming = Infinity;
  let minSuppliers = Infinity;

  for (const c of components) {
    const perKit = c.quantity;
    const metrics = await computeAvailableQuantity(c.component_product_id, {
      warehouseId: opts.warehouseId ?? null,
      profileId: opts.profileId ?? null,
      forMarketplace: false
    });
    const supply = await getComponentWarehouseSupply(c.component_product_id);
    minOnHand = Math.min(minOnHand, Math.floor(metrics.onHand / perKit));
    minSuppliers = Math.min(minSuppliers, Math.floor(metrics.suppliers / perKit));
    minIncoming = Math.min(minIncoming, Math.floor(supply.incoming / perKit));
  }

  const onHand = Number.isFinite(minOnHand) ? Math.max(0, minOnHand) : 0;
  const suppliers = Number.isFinite(minSuppliers) ? Math.max(0, minSuppliers) : 0;
  const incoming = Number.isFinite(minIncoming) ? Math.max(0, minIncoming) : 0;
  const available = onHand + suppliers;

  const kr = await query(
    `SELECT COALESCE(reserved_quantity, 0)::int AS reserved FROM products WHERE id = $1`,
    [Number(kitProductId)]
  );
  const reserved = Number(kr.rows[0]?.reserved ?? 0) || 0;

  return { onHand, incoming, reserved, suppliers, available };
}

/** Сколько комплектов уже зарезервировано под orders.id (по движениям комплектующих). */
export async function getReservedKitUnitsForOrder(kitProductId, orderDbId) {
  const components = await getKitComponents(kitProductId);
  if (components.length === 0) return 0;
  const oid = Number(orderDbId);
  if (!Number.isFinite(oid) || oid < 1) return 0;

  let minKits = Infinity;
  for (const c of components) {
    const r = await query(
      `SELECT
         COALESCE(SUM(CASE WHEN type = 'reserve' THEN -quantity_change ELSE 0 END), 0)::int AS reserved,
         COALESCE(SUM(CASE WHEN type = 'unreserve' THEN quantity_change ELSE 0 END), 0)::int AS unreserved
       FROM stock_movements
       WHERE product_id = $1
         AND type IN ('reserve', 'unreserve')
         AND (meta->>'order_id')::bigint = $2::bigint`,
      [c.component_product_id, oid]
    );
    const row = r.rows?.[0];
    const reserved = row?.reserved != null ? Number(row.reserved) : 0;
    const unreserved = row?.unreserved != null ? Number(row.unreserved) : 0;
    const net = Math.max(0, reserved - unreserved);
    minKits = Math.min(minKits, Math.floor(net / c.quantity));
  }
  return Number.isFinite(minKits) ? Math.max(0, minKits) : 0;
}

/** Сколько комплектов можно зарезервировать (по складу: факт + в пути − резерв комплектующих). */
export async function computeMaxKitUnitsReservable(kitProductId) {
  const components = await getKitComponents(kitProductId);
  if (components.length === 0) return 0;

  let minKits = Infinity;
  for (const c of components) {
    const supply = await getComponentWarehouseSupply(c.component_product_id);
    const kitsFromComp = Math.floor(supply.availableSupply / c.quantity);
    minKits = Math.min(minKits, kitsFromComp);
  }
  return Number.isFinite(minKits) ? Math.max(0, minKits) : 0;
}

export async function computeKitMarketplaceStock(kitProductId, opts = {}) {
  const components = await getKitComponents(kitProductId);
  if (components.length === 0) return 0;

  let minKits = Infinity;
  for (const c of components) {
    const perKit = c.quantity;
    const { available } = await computeAvailableQuantity(c.component_product_id, {
      warehouseId: opts.warehouseId ?? null,
      profileId: opts.profileId ?? null,
      forMarketplace: true
    });
    minKits = Math.min(minKits, Math.floor(available / perKit));
  }
  return Number.isFinite(minKits) ? Math.max(0, minKits) : 0;
}

/** Подставить в объект товара-комплекта рассчитанные остатки (для API). */
export async function enrichKitProductStock(product, opts = {}) {
  if (!product || !isKitProductType(product.product_type)) return product;
  const metrics = await computeKitDisplayStock(product.id, opts);
  product.quantity = metrics.onHand;
  product.supplierStockTotal = metrics.suppliers;
  product.kit_quantity_derived = true;
  product.kit_display_stock = metrics;
  return product;
}

/** После изменения остатка комплектующего — обновить остатки на МП у родительских комплектов. */
export function scheduleMarketplaceSyncForParentKits(componentProductId, opts = {}) {
  setImmediate(async () => {
    try {
      const pid = Number(componentProductId);
      if (!Number.isFinite(pid) || pid < 1) return;
      const r = await query(
        `SELECT DISTINCT kit_product_id FROM kit_components WHERE component_product_id = $1`,
        [pid]
      );
      for (const row of r.rows || []) {
        const kitId = row.kit_product_id;
        if (kitId == null) continue;
        scheduleWarehouseStockMarketplaceSync(kitId, {
          source: opts.source || 'kit_component_changed',
          organizationId: opts.organizationId ?? null,
          warehouseId: opts.warehouseId ?? null
        });
      }
    } catch (e) {
      logger.warn('[Kit Stock] scheduleMarketplaceSyncForParentKits:', e?.message || e);
    }
  });
}

/**
 * Резерв под заказ на комплект: резервируем комплектующие.
 * @returns {Promise<number>} фактически зарезервировано комплектов (единиц kit)
 */
export async function applyKitOrderReserve(kitProductId, kitsWanted, orderIdLabel, meta, applyReserveFn) {
  const kitId = Number(kitProductId);
  const wanted = Math.max(1, parseInt(kitsWanted, 10) || 1);
  const maxKits = await computeMaxKitUnitsReservable(kitId);
  const kitsToReserve = Math.min(wanted, maxKits);
  if (kitsToReserve <= 0) return 0;

  const components = await getKitComponents(kitId);
  for (const c of components) {
    const compQty = kitsToReserve * c.quantity;
    await applyReserveFn(c.component_product_id, compQty, orderIdLabel, {
      ...meta,
      kit_product_id: kitId,
      kit_units: kitsToReserve,
      component_per_kit: c.quantity
    });
  }

  scheduleWarehouseStockMarketplaceSync(kitId, {
    source: 'kit_order_reserve',
    organizationId: meta?.organizationId ?? null,
    warehouseId: meta?.warehouse_id ?? meta?.warehouseId ?? null
  });

  return kitsToReserve;
}

/** Снять все резервы по orders.id (в т.ч. по комплектующим). @returns {Promise<number[]>} product_id с затронутым резервом */
export async function releaseAllReservesForOrder(orderDbId, orderIdLabel, unreserveFn) {
  const oid = Number(orderDbId);
  if (!Number.isFinite(oid) || oid < 1) return [];

  const r = await query(
    `SELECT product_id,
            GREATEST(0,
              COALESCE(SUM(CASE WHEN type = 'reserve' THEN -quantity_change
                                WHEN type = 'unreserve' THEN quantity_change
                                ELSE 0 END), 0)
            )::int AS net_reserved
     FROM stock_movements
     WHERE (meta->>'order_id')::bigint = $1::bigint
       AND type IN ('reserve', 'unreserve')
     GROUP BY product_id
     HAVING COALESCE(SUM(CASE WHEN type = 'reserve' THEN -quantity_change
                               WHEN type = 'unreserve' THEN quantity_change
                               ELSE 0 END), 0) > 0`,
    [oid]
  );

  const affected = [];
  for (const row of r.rows || []) {
    const pid = Number(row.product_id);
    const net = Number(row.net_reserved) || 0;
    if (!Number.isFinite(pid) || pid < 1 || net <= 0) continue;
    await unreserveFn(pid, net, orderIdLabel, { order_id: oid, orderId: orderIdLabel });
    scheduleMarketplaceSyncForParentKits(pid, { source: 'order_unreserve' });
    affected.push(pid);
  }
  return affected;
}

export default {
  isKitProductType,
  isKitProductId,
  getKitComponents,
  computeKitDisplayStock,
  computeMaxKitUnitsReservable,
  getReservedKitUnitsForOrder,
  computeKitMarketplaceStock,
  enrichKitProductStock,
  scheduleMarketplaceSyncForParentKits,
  applyKitOrderReserve,
  releaseAllReservesForOrder
};
