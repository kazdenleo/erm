/**
 * Резерв остатков под поставки FBO: свободное наличие на складе списания FBO
 * и на складе ручных заказов (если задан в настройках), очередь по ready_at.
 */

import { query } from '../config/database.js';
import repositoryFactory from '../config/repository-factory.js';
import stockMovementsService, { runWithProductStockLock } from './stockMovements.service.js';
import { getProductSupplySnapshotWithClient } from './sellableQuantity.service.js';
import { NET_RESERVED_MOVEMENT_ROW_CASE_SQL } from '../constants/netReservedStockSql.js';

const FBO_RESERVE_ACTIVE_STATUSES = ['new', 'packed', 'ready_for_supply'];

const fboSourceWarehousesCache = new Map();

function normalizeWarehouseId(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Склады-источники для FBO: склад списания + склад ручных заказов. */
async function getFboSourceWarehouseIds(profileId) {
  const pid = normalizeProfileId(profileId);
  if (pid == null) return [];
  const cacheKey = String(pid);
  if (fboSourceWarehousesCache.has(cacheKey)) {
    return fboSourceWarehousesCache.get(cacheKey);
  }
  const r = await query(
    `SELECT fbo_deduction_warehouse_id, manual_orders_warehouse_id
     FROM profiles WHERE id = $1`,
    [pid]
  );
  const row = r.rows?.[0];
  const ids = [];
  for (const raw of [row?.fbo_deduction_warehouse_id, row?.manual_orders_warehouse_id]) {
    const n = normalizeWarehouseId(raw);
    if (n != null && !ids.includes(n)) ids.push(n);
  }
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

function readyAtTs(v) {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

/** Снимать резерв — с самых поздних поставок (LIFO по ready_at). */
function compareSupplyRowsForUnreserve(a, b) {
  const ta = readyAtTs(a?.ready_at);
  const tb = readyAtTs(b?.ready_at);
  // null → в конец (как "самая поздняя / неизвестная")
  const na = ta == null;
  const nb = tb == null;
  if (na && nb) {
    // fallback по id, чтобы было детерминированно
    const sa = Number(a?.fbo_supply_id) || 0;
    const sb = Number(b?.fbo_supply_id) || 0;
    if (sa !== sb) return sb - sa;
    const ia = Number(a?.supply_item_id) || 0;
    const ib = Number(b?.supply_item_id) || 0;
    return ib - ia;
  }
  if (na) return -1; // a(null) раньше в сортировке DESC (т.е. "снимать первым")
  if (nb) return 1;
  if (ta !== tb) return tb - ta; // поздние раньше
  const sa = Number(a?.fbo_supply_id) || 0;
  const sb = Number(b?.fbo_supply_id) || 0;
  if (sa !== sb) return sb - sa;
  const ia = Number(a?.supply_item_id) || 0;
  const ib = Number(b?.supply_item_id) || 0;
  return ib - ia;
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

    for (const productId of uniquePids) {
      const queue = await findFboReserveQueueByProduct(productId, profileId);
      const fallbackWh = normalizeWarehouseId(
        queue.find((row) => Number(row.deduction_warehouse_id) > 0)?.deduction_warehouse_id
      );
      const stockWarehouseIds =
        sourceWarehouseIds.length > 0
          ? sourceWarehouseIds
          : fallbackWh != null
            ? [fallbackWh]
            : [];
      let incomingPool = await getIncomingPoolForFboProduct(productId, stockWarehouseIds);
      const stockPools = new Map();

      for (const row of queue) {
        const itemId = String(row.supply_item_id);
        const qty = Math.max(0, parseInt(row.quantity, 10) || 0);

        let reservedFromStock = await getNetReservedForFboItem(row.supply_item_id, productId);
        if (reservedFromStock <= 0 && stockWarehouseIds.length > 0) {
          reservedFromStock = await takeFromStockPools(stockPools, productId, stockWarehouseIds, qty);
        }

        const gap = Math.max(0, qty - reservedFromStock);
        const reservedFromIncoming = Math.min(gap, incomingPool);
        incomingPool = Math.max(0, incomingPool - reservedFromIncoming);

        breakdown.set(itemId, { reservedFromStock, reservedFromIncoming });
      }
    }
    return breakdown;
  }

  async enrichItemsWithReserved(items, { profileId } = {}) {
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
    const breakdown = await this._computeReserveBreakdownByItem(productIds, { profileId });

    const out = [];
    for (const it of items) {
      const pid = it.productId ?? it.product_id;
      if (!pid || !it.id) {
        out.push({ ...it, reservedQuantity: 0, reservedFromStock: 0, reservedFromIncoming: 0 });
        continue;
      }
      const b = breakdown.get(String(it.id));
      if (b) {
        out.push({
          ...it,
          reservedQuantity: b.reservedFromStock,
          reservedFromStock: b.reservedFromStock,
          reservedFromIncoming: b.reservedFromIncoming,
        });
        continue;
      }
      const reservedFromStock = await getNetReservedForFboItem(it.id, pid);
      out.push({
        ...it,
        reservedQuantity: reservedFromStock,
        reservedFromStock,
        reservedFromIncoming: 0,
      });
    }
    return out;
  }

  /** Сводка резерва для списка поставок. */
  async enrichSuppliesListWithReserveTotals(supplies, { profileId } = {}) {
    if (!repositoryFactory.isUsingPostgreSQL() || !Array.isArray(supplies) || !supplies.length) {
      return supplies;
    }
    const supplyIds = supplies.map((s) => Number(s.id)).filter((id) => Number.isFinite(id) && id > 0);
    if (!supplyIds.length) return supplies;

    const itemsR = await query(
      `SELECT i.id, i.fbo_supply_id, i.product_id, i.quantity::int AS quantity
       FROM fbo_supply_items i
       WHERE i.fbo_supply_id = ANY($1::bigint[])
       ORDER BY i.fbo_supply_id, i.id`,
      [supplyIds]
    );
    const allItems = (itemsR.rows || []).map((row) => ({
      id: row.id,
      fboSupplyId: row.fbo_supply_id,
      productId: row.product_id,
      quantity: row.quantity,
    }));
    const enrichedAll = await this.enrichItemsWithReserved(allItems, { profileId });
    const enrichedByItemId = new Map(enrichedAll.map((it) => [String(it.id), it]));

    const totalsBySupply = new Map();
    for (const item of allItems) {
      const sid = Number(item.fboSupplyId);
      const enriched = enrichedByItemId.get(String(item.id));
      if (!enriched) continue;
      if (!totalsBySupply.has(sid)) {
        totalsBySupply.set(sid, { reservedFromStockTotal: 0, reservedFromIncomingTotal: 0 });
      }
      const t = totalsBySupply.get(sid);
      t.reservedFromStockTotal += Number(enriched.reservedFromStock) || 0;
      t.reservedFromIncomingTotal += Number(enriched.reservedFromIncoming) || 0;
    }

    return supplies.map((s) => {
      const t = totalsBySupply.get(Number(s.id));
      if (!t) {
        return { ...s, reservedFromStockTotal: 0, reservedFromIncomingTotal: 0 };
      }
      return { ...s, ...t };
    });
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

      // Если нужно снять резерв (например, после списания остатка) — снимаем в обратном приоритете:
      // сначала самые поздние поставки, чтобы более ранние по ready_at оставались зарезервированы.
      const unreserveQueue = [...queue].sort(compareSupplyRowsForUnreserve);
      for (const row of unreserveQueue) {
        const itemId = row.supply_item_id;
        const current = await getNetReservedForFboItem(itemId, pid);
        if (current <= 0) continue;
        const label = row.external_shipment_number
          ? `FBO ${row.external_shipment_number}`
          : `FBO поставка №${row.fbo_supply_id}`;
        const byWh = await getNetReservedForFboItemByWarehouse(itemId, pid);
        const warehouses =
          byWh.length > 0
            ? byWh
            : [
                {
                  warehouseId: normalizeWarehouseId(row.deduction_warehouse_id),
                  net: current,
                },
              ].filter((w) => w.warehouseId != null);
        for (const { warehouseId, net } of warehouses) {
          if (net <= 0) continue;
          await applyFboReserveDelta({
            productId: pid,
            warehouseId,
            supplyId: row.fbo_supply_id,
            supplyItemId: itemId,
            delta: -net,
            reason: `Пересчёт резерва FBO (${label})`,
          }).catch(() => {});
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
            });
            poolByWh.set(warehouseId, pool - add);
            need -= add;
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

  /** Пересчёт резерва по всем товарам активных поставок аккаунта. */
  async rebalanceReservesForProfile(profileId) {
    if (!repositoryFactory.isUsingPostgreSQL()) return { products: 0, movements: 0 };
    const pid = normalizeProfileId(profileId);
    if (pid == null) return { products: 0, movements: 0 };

    const r = await query(
      `SELECT DISTINCT si.product_id
       FROM fbo_supply_items si
       INNER JOIN fbo_supplies s ON s.id = si.fbo_supply_id
       WHERE s.profile_id = $1
         AND s.deduction_warehouse_id IS NOT NULL
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
      await this.rebalanceReservesForProduct(productId, { profileId: pid });
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
