/**
 * Резерв остатков под поставки FBO: только свободное наличие на складе списания,
 * очередь по дате готовности (ready_at) — сначала более ранние поставки.
 */

import { query } from '../config/database.js';
import repositoryFactory from '../config/repository-factory.js';
import stockMovementsService, { runWithProductStockLock } from './stockMovements.service.js';
import { NET_RESERVED_MOVEMENT_ROW_CASE_SQL } from '../constants/netReservedStockSql.js';

const FBO_RESERVE_ACTIVE_STATUSES = ['new', 'packed', 'ready_for_supply'];

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
  const pid = normalizeProfileId(profileId);
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
     WHERE si.product_id = $1
       AND ($2::bigint IS NULL OR s.profile_id = $2)
       AND s.deduction_warehouse_id IS NOT NULL
       AND s.status = ANY($3::text[])
     ORDER BY s.ready_at ASC NULLS LAST, s.id ASC, si.id ASC`,
    [productId, pid, FBO_RESERVE_ACTIVE_STATUSES]
  );
  return r.rows || [];
}

async function applyFboReserveDelta({ productId, warehouseId, supplyId, supplyItemId, delta, reason }) {
  const d = Math.floor(Number(delta) || 0);
  if (d === 0) return;
  if (d > 0) {
    await stockMovementsService.applyChange(productId, {
      delta: -d,
      type: 'reserve',
      reason,
      meta: {
        warehouse_id: warehouseId,
        fbo_supply_id: String(supplyId),
        fbo_supply_item_id: String(supplyItemId),
      },
    });
    return;
  }
  await stockMovementsService.applyChange(productId, {
    delta: Math.abs(d),
    type: 'unreserve',
    reason,
    meta: {
      warehouse_id: warehouseId,
      fbo_supply_id: String(supplyId),
      fbo_supply_item_id: String(supplyItemId),
    },
  });
}

class FboSupplyReserveService {
  async enrichItemsWithReserved(items) {
    if (!repositoryFactory.isUsingPostgreSQL() || !Array.isArray(items)) return items;
    const out = [];
    for (const it of items) {
      const pid = it.productId ?? it.product_id;
      if (!pid || !it.id) {
        out.push({ ...it, reservedQuantity: 0 });
        continue;
      }
      const reservedQuantity = await getNetReservedForFboItem(it.id, pid);
      out.push({ ...it, reservedQuantity });
    }
    return out;
  }

  /**
   * Перераспределить резерв по всем активным строкам товара (FIFO по ready_at).
   */
  async rebalanceReservesForProduct(productId, { profileId } = {}) {
    if (!repositoryFactory.isUsingPostgreSQL()) return;
    const pid = Number(productId);
    if (!Number.isFinite(pid) || pid < 1) return;

    return runWithProductStockLock(pid, async () => {
      const queue = await findFboReserveQueueByProduct(pid, profileId);
      const allItemIds = new Set(queue.map((r) => String(r.supply_item_id)));

      for (const row of queue) {
        const itemId = row.supply_item_id;
        const current = await getNetReservedForFboItem(itemId, pid);
        if (current <= 0) continue;
        const label = row.external_shipment_number
          ? `FBO ${row.external_shipment_number}`
          : `FBO поставка №${row.fbo_supply_id}`;
        await applyFboReserveDelta({
          productId: pid,
          warehouseId: row.deduction_warehouse_id,
          supplyId: row.fbo_supply_id,
          supplyItemId: itemId,
          delta: -current,
          reason: `Пересчёт резерва FBO (${label})`,
        }).catch(() => {});
      }

      const byWarehouse = new Map();
      for (const row of queue) {
        const wh = Number(row.deduction_warehouse_id);
        if (!Number.isFinite(wh) || wh < 1) continue;
        if (!byWarehouse.has(wh)) byWarehouse.set(wh, []);
        byWarehouse.get(wh).push(row);
      }

      for (const [warehouseId, rows] of byWarehouse) {
        let pool = await getWarehouseReservableUnits(pid, warehouseId);
        for (const row of rows) {
          const itemId = row.supply_item_id;
          const supplyId = row.fbo_supply_id;
          const target = Math.max(0, parseInt(row.quantity, 10) || 0);
          if (target <= 0 || pool <= 0) continue;
          const add = Math.min(target, pool);
          const label = row.external_shipment_number
            ? `FBO ${row.external_shipment_number}`
            : `FBO поставка №${supplyId}`;
          try {
            await applyFboReserveDelta({
              productId: pid,
              warehouseId,
              supplyId,
              supplyItemId: itemId,
              delta: add,
              reason: `Резерв FBO (${label})`,
            });
            pool -= add;
          } catch {
            /* недостаточно доступного остатка */
          }
        }
      }

      const orphanR = await query(
        `SELECT DISTINCT meta->>'fbo_supply_item_id' AS item_id,
                meta->>'fbo_supply_id' AS supply_id,
                warehouse_id
         FROM stock_movements
         WHERE product_id = $1
           AND type IN ('reserve', 'unreserve')
           AND meta->>'fbo_supply_item_id' IS NOT NULL
           AND meta->>'fbo_supply_id' IS NOT NULL`,
        [pid]
      );
      for (const or of orphanR.rows || []) {
        if (allItemIds.has(String(or.item_id))) continue;
        const net = await getNetReservedForFboItem(or.item_id, pid);
        if (net <= 0) continue;
        await applyFboReserveDelta({
          productId: pid,
          warehouseId: or.warehouse_id,
          supplyId: or.supply_id,
          supplyItemId: or.item_id,
          delta: -net,
          reason: 'Снятие резерва FBO (строка неактивна)',
        }).catch(() => {});
      }
    });
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

  async releaseReservesForSupply(supplyId, { profileId } = {}) {
    if (!repositoryFactory.isUsingPostgreSQL()) return;
    const pid = normalizeProfileId(profileId);
    const itemsR = await query(
      `SELECT si.id, si.product_id, s.deduction_warehouse_id
       FROM fbo_supply_items si
       INNER JOIN fbo_supplies s ON s.id = si.fbo_supply_id
       WHERE si.fbo_supply_id = $1
         AND ($2::bigint IS NULL OR s.profile_id = $2)
         AND si.product_id IS NOT NULL`,
      [supplyId, pid]
    );
    for (const row of itemsR.rows || []) {
      const productId = Number(row.product_id);
      const net = await getNetReservedForFboItem(row.id, productId);
      if (net <= 0) continue;
      const wh = row.deduction_warehouse_id;
      await applyFboReserveDelta({
        productId,
        warehouseId: wh,
        supplyId,
        supplyItemId: row.id,
        delta: -net,
        reason: `Снятие резерва FBO (поставка №${supplyId})`,
      }).catch(() => {});
    }
  }

  async onSupplyStockEvent(productId, warehouseId, { profileId } = {}) {
    const pid = Number(productId);
    if (!Number.isFinite(pid) || pid < 1) return;
    await this.rebalanceReservesForProduct(pid, { profileId });
  }
}

export default new FboSupplyReserveService();
