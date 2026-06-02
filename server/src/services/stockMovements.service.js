/**
 * Stock Movements Service
 * Бизнес-логика для журнала движений остатков
 */

import { query } from '../config/database.js';
import { getClient } from '../config/database.js';
import repositoryFactory from '../config/repository-factory.js';
import {
  NET_RESERVED_MOVEMENT_ROW_CASE_SQL,
  NET_RESERVED_SUM_EXPR_SQL,
  RAW_RESERVED_SUM_EXPR_SQL
} from '../constants/netReservedStockSql.js';
import { syncProductQuantityFromWarehouseStock } from './productWarehouseQuantity.service.js';

const STOCK_LOCK_MAX_CONCURRENT = (() => {
  const n = Number(process.env.PRODUCT_STOCK_LOCK_MAX);
  if (Number.isFinite(n) && n >= 1) return Math.min(16, Math.floor(n));
  return 6;
})();

let stockLockInUse = 0;
const stockLockWaitQueue = [];

function acquireStockLockSlot() {
  if (stockLockInUse < STOCK_LOCK_MAX_CONCURRENT) {
    stockLockInUse += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    stockLockWaitQueue.push(resolve);
  }).then(() => {
    stockLockInUse += 1;
  });
}

function releaseStockLockSlot() {
  stockLockInUse = Math.max(0, stockLockInUse - 1);
  const next = stockLockWaitQueue.shift();
  if (next) next();
}

/**
 * Сериализация операций по одному product_id между параллельными HTTP/синками.
 * Иначе два заказа одновременно читают «доступно = 1» до commit первого резерва.
 * Одновременно не более STOCK_LOCK_MAX_CONCURRENT выделенных соединений (остальное — очередь).
 */
export async function runWithProductStockLock(productId, fn) {
  const pid = Number(productId);
  if (!Number.isFinite(pid) || pid < 1) {
    return fn();
  }
  await acquireStockLockSlot();
  const client = await getClient();
  try {
    await client.query('SELECT pg_advisory_lock($1::bigint)', [pid]);
    return await fn();
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1::bigint)', [pid]);
    } catch {
      /* ignore */
    }
    client.release();
    releaseStockLockSlot();
  }
}

function scheduleStockMovementMarketplaceSync(productId, opts) {
  const idNum = Number(productId);
  if (!Number.isFinite(idNum) || idNum < 1) return;
  import('./marketplaceWarehouseStockSync.service.js')
    .then(({ scheduleWarehouseStockMarketplaceSync }) => scheduleWarehouseStockMarketplaceSync(idNum, opts))
    .catch(() => {});
  import('./kitStock.service.js')
    .then(({ scheduleMarketplaceSyncForParentKits }) => scheduleMarketplaceSyncForParentKits(idNum, opts))
    .catch(() => {});
}

class StockMovementsService {
  constructor() {
    this.repository = repositoryFactory.getStockMovementsRepository();
    this.productsRepository = repositoryFactory.getProductsRepository();
    this.profilesRepository = repositoryFactory.getProfilesRepository();
  }

  /** Настройка аккаунта: ручная корректировка наличия в списке остатков. */
  async assertManualWarehouseStockEditAllowed(profileId) {
    const pid =
      profileId != null && profileId !== ''
        ? typeof profileId === 'string'
          ? parseInt(profileId, 10)
          : Number(profileId)
        : NaN;
    if (!Number.isFinite(pid) || pid < 1) {
      const error = new Error('Нет привязки к аккаунту');
      error.statusCode = 403;
      throw error;
    }
    const profile = await this.profilesRepository.findById(pid);
    if (!profile || profile.allow_manual_warehouse_stock_edit !== true) {
      const error = new Error(
        'Ручное изменение наличия на складе отключено в настройках аккаунта'
      );
      error.statusCode = 403;
      throw error;
    }
  }

  /** Настройка аккаунта: сброс истории остатков и задание текущих значений. */
  async assertStockHistoryResetAllowed(profileId) {
    const pid =
      profileId != null && profileId !== ''
        ? typeof profileId === 'string'
          ? parseInt(profileId, 10)
          : Number(profileId)
        : NaN;
    if (!Number.isFinite(pid) || pid < 1) {
      const error = new Error('Нет привязки к аккаунту');
      error.statusCode = 403;
      throw error;
    }
    const profile = await this.profilesRepository.findById(pid);
    if (!profile || profile.allow_stock_history_reset !== true) {
      const error = new Error(
        'Сброс истории остатков отключён в настройках аккаунта'
      );
      error.statusCode = 403;
      throw error;
    }
  }

  /**
   * Склад для списания/отгрузки: предпочтительный → где есть остаток → последний резерв → склад по умолчанию.
   */
  async resolveWarehouseIdForProductStock(productId, preferredWarehouseId = null) {
    const idNum = Number(productId);
    if (!Number.isFinite(idNum) || idNum < 1) {
      return this.productsRepository.resolveOwnWarehouseId(preferredWarehouseId);
    }
    const pref = await this.productsRepository.resolveOwnWarehouseId(preferredWarehouseId);
    if (pref) {
      const onPref = await this.productsRepository.getWarehouseFreeStock(idNum, pref);
      if (onPref > 0) return pref;
    }
    const withStock = await query(
      `SELECT warehouse_id FROM product_warehouse_stock
       WHERE product_id = $1 AND COALESCE(quantity, 0) > 0
       ORDER BY quantity DESC, warehouse_id ASC
       LIMIT 1`,
      [idNum]
    );
    if (withStock.rows?.[0]?.warehouse_id != null) {
      return Number(withStock.rows[0].warehouse_id);
    }
    const fromReserve = await query(
      `SELECT warehouse_id FROM stock_movements
       WHERE product_id = $1
         AND warehouse_id IS NOT NULL
         AND type IN ('reserve', 'unreserve', 'shipment')
       ORDER BY id DESC
       LIMIT 1`,
      [idNum]
    );
    if (fromReserve.rows?.[0]?.warehouse_id != null) {
      return Number(fromReserve.rows[0].warehouse_id);
    }
    return pref || (await this.productsRepository.resolveOwnWarehouseId(null));
  }

  /**
   * Применить изменение остатка к товару и записать движение.
   * Остаток изменяется по выбранному складу (meta.warehouse_id / meta.warehouseId или склад по умолчанию);
   * products.quantity — сумма свободных остатков по всем складам.
   *
   * @param {number|string} productId
   * @param {object} options
   * @param {number} options.delta - изменение остатка на выбранном складе
   * @param {string} options.type - тип операции (receipt, writeoff, shipment, reserve, unreserve, inventory, manual)
   * @param {string} [options.reason] - человекочитаемое описание причины
   * @param {object} [options.meta] - дополнительные данные (warehouse_id опционально)
   */
  async applyChange(productId, { delta, type, reason, meta } = {}) {
    const idNum = typeof productId === 'string' ? parseInt(productId, 10) : productId;
    if (!idNum || Number.isNaN(idNum)) {
      const error = new Error('Некорректный ID товара');
      error.statusCode = 400;
      throw error;
    }

    const product = await this.productsRepository.findById(idNum);
    if (!product) {
      const error = new Error('Товар не найден');
      error.statusCode = 404;
      throw error;
    }

    const metaObj = meta && typeof meta === 'object' && !Array.isArray(meta) ? { ...meta } : {};
    const whRaw = metaObj.warehouse_id ?? metaObj.warehouseId;
    const warehouseId = await this.productsRepository.resolveOwnWarehouseId(whRaw);
    if (!warehouseId) {
      const error = new Error('Не найден склад для операции (добавьте склад type=warehouse без поставщика)');
      error.statusCode = 400;
      throw error;
    }

    const totalBefore = product.quantity != null ? Number(product.quantity) : 0;
    const currentReserved = product.reserved_quantity != null ? Number(product.reserved_quantity) : 0;
    const safeDelta = Number.isNaN(Number(delta)) ? 0 : Number(delta);

    if (type === 'reserve' || type === 'unreserve') {
      return this._applyReserveUnreserveChange(idNum, {
        delta: safeDelta,
        type,
        reason,
        meta: metaObj,
        warehouseId,
        product,
        totalBefore
      });
    }

    const currentWh = await this.productsRepository.getWarehouseFreeStock(idNum, warehouseId);
    let newWh = currentWh + safeDelta;
    if (newWh < 0) newWh = 0;

    await this.productsRepository.setWarehouseFreeStock(idNum, warehouseId, newWh);

    await syncProductQuantityFromWarehouseStock(idNum);

    const productAfter = await this.productsRepository.findById(idNum);
    const totalAfter = productAfter?.quantity != null ? Number(productAfter.quantity) : 0;

    const metaOut = { ...metaObj, warehouse_id: warehouseId };
    const profId = product.profile_id ?? product.profileId ?? null;
    const incAfter =
      productAfter?.incoming_quantity != null ? Number(productAfter.incoming_quantity) : 0;
    const resAfter =
      productAfter?.reserved_quantity != null ? Number(productAfter.reserved_quantity) : 0;

    const movement = await this.repository.create({
      productId: idNum,
      type,
      quantityChange: safeDelta,
      balanceAfter: totalAfter,
      incomingAfter: Number.isFinite(incAfter) ? incAfter : 0,
      reservedAfter: Number.isFinite(resAfter) ? resAfter : 0,
      reason: reason || null,
      meta: metaOut,
      warehouseId,
      profileId: profId
    });

    if (type !== 'reserve' && type !== 'unreserve') {
      try {
        const { default: ordersService } = await import('./orders.service.js');
        await ordersService.trimExcessReservesForProduct(idNum, {
          reason: reason || undefined,
          meta: { from_stock_movement_type: type }
        });
      } catch {
        // не блокируем движение при сбое пересчёта резервов
      }
      try {
        const { default: ordersService } = await import('./orders.service.js');
        await ordersService.ensureReservesForProductIfSupplyAvailable(idNum);
      } catch {
        // не блокируем движение при сбое дозарезервирования
      }
      try {
        const { default: fboSupplyReserveService } = await import('./fboSupplyReserve.service.js');
        await fboSupplyReserveService.onSupplyStockEvent(idNum, warehouseId, {
          profileId: profId,
        });
      } catch {
        /* ignore */
      }
    }

    // Резерв/снятие резерва меняет «доступно к продаже» на МП — отправляем обновлённый остаток.
    const orgId = product.organization_id ?? product.organizationId ?? null;
    scheduleStockMovementMarketplaceSync(idNum, {
      source: `stock_movement:${type}`,
      warehouseId,
      organizationId: orgId
    });

    return {
      productId: idNum,
      quantityBefore: totalBefore,
      quantityAfter: totalAfter,
      delta: safeDelta,
      warehouseId,
      movement
    };
  }

  /**
   * Резерв / снятие резерва: блокировка строки товара, лимит по журналу (не products.reserved_quantity).
   */
  async _applyReserveUnreserveChange(productId, { delta, type, reason, meta, warehouseId, product, totalBefore }) {
    const idNum = productId;
    const safeDelta = Number(delta) || 0;
    const metaOut = { ...meta, warehouse_id: warehouseId };
    const profId = product.profile_id ?? product.profileId ?? null;
    const orgId = product.organization_id ?? product.organizationId ?? null;

    const client = await getClient();
    let movement = null;
    let quantityChange = safeDelta;

    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM products WHERE id = $1 FOR UPDATE', [idNum]);
      // Сериализация резерва по product_id (incoming и журнал — глобальные).
      await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [idNum]);

      const {
        getProductSupplySnapshotWithClient,
        getRawReservedQuantityFromMovementsWithClient
      } = await import('./sellableQuantity.service.js');
      const orderDbIdRaw = metaOut.order_id ?? metaOut.orderId ?? null;
      let netForOrder = null;
      if (orderDbIdRaw != null && String(orderDbIdRaw).trim() !== '') {
        const { getNetReservedForOrderProduct } = await import('./kitStock.service.js');
        netForOrder = await getNetReservedForOrderProduct(orderDbIdRaw, idNum);
      }

      const journalReconcile =
        metaOut.journal_reconcile === true || metaOut.journal_reconcile === 'true';

      if (type === 'reserve' && safeDelta < 0) {
        const reserveAdd = Math.floor(Math.abs(safeDelta));
        if (reserveAdd < 1) {
          const err = new Error('Нулевой или некорректный объём резерва');
          err.statusCode = 400;
          throw err;
        }
        const supply = await getProductSupplySnapshotWithClient(client, idNum);
        const journalBeforeRaw = supply.reservedRaw;
        if (!journalReconcile) {
          const availableForReserve = Math.max(0, Math.floor(supply.available));
          if (availableForReserve <= 0) {
            const err = new Error(
              `Недостаточно остатка для резерва: на складе ${supply.onHand}, в пути ${supply.incoming}, ` +
                `уже зарезервировано ${journalBeforeRaw} (доступно без поставщиков: 0)`
            );
            err.statusCode = 400;
            throw err;
          }
          if (reserveAdd > availableForReserve) {
            const err = new Error(
              `Недостаточно остатка для резерва: на складе ${supply.onHand}, в пути ${supply.incoming}, ` +
                `уже зарезервировано ${journalBeforeRaw}, запрошено ${reserveAdd} ` +
                `(доступно без поставщиков: ${availableForReserve})`
            );
            err.statusCode = 400;
            throw err;
          }
        }
        const journalAfter = journalBeforeRaw + reserveAdd;
        await client.query(
          'UPDATE products SET reserved_quantity = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
          [journalAfter, idNum]
        );
        quantityChange = -reserveAdd;
        if (quantityChange === 0) {
          const err = new Error('Нулевой объём резерва — запись в журнал не создаётся');
          err.statusCode = 400;
          throw err;
        }
      } else if (type === 'unreserve' && safeDelta > 0) {
        const journalBeforeRaw = await getRawReservedQuantityFromMovementsWithClient(client, idNum);
        const cap =
          netForOrder != null && Number.isFinite(netForOrder)
            ? Math.max(0, Math.floor(netForOrder))
            : journalBeforeRaw;
        const release = Math.min(safeDelta, cap);
        if (release <= 0) {
          await client.query('ROLLBACK');
          const err = new Error(
            netForOrder != null && netForOrder <= 0
              ? 'По этому заказу резерв в журнале уже снят (обновите страницу)'
              : 'Нет резерва для снятия по товару'
          );
          err.statusCode = 400;
          throw err;
        }
        const journalAfter = Math.max(0, journalBeforeRaw - release);
        await client.query(
          'UPDATE products SET reserved_quantity = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
          [journalAfter, idNum]
        );
        quantityChange = release;
      } else {
        const err = new Error('Некорректная операция резерва');
        err.statusCode = 400;
        throw err;
      }

      if (type === 'reserve' && (!Number.isFinite(quantityChange) || quantityChange >= 0)) {
        const err = new Error('Некорректная запись резерва: quantity_change должно быть отрицательным');
        err.statusCode = 400;
        throw err;
      }

      movement = await this.repository.insertSnapshotAfterProduct(client, {
        productId: idNum,
        type,
        quantityChange,
        reason: reason || null,
        meta: metaOut,
        warehouseId,
        profileId: profId
      });

      if (type === 'reserve' && !journalReconcile) {
        const snapAfter = await getProductSupplySnapshotWithClient(client, idNum);
        if (snapAfter.reservedRaw > snapAfter.supplyCap) {
          const err = new Error(
            `Резерв превышает наличие и «в пути»: зарезервировано ${snapAfter.reservedRaw}, ` +
              `доступно к резерву ${snapAfter.supplyCap} (на складе ${snapAfter.onHand}, в пути ${snapAfter.incoming})`
          );
          err.statusCode = 400;
          throw err;
        }
      }

      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    try {
      const { syncProductReservedQuantityFromJournal } = await import('./sellableQuantity.service.js');
      await syncProductReservedQuantityFromJournal(idNum);
    } catch {
      /* ignore */
    }

    // После reserve не вызываем trimExcessReservesForProduct: перерезерв нужно отклонять,
    // а не снимать резерв у других заказов (trim остаётся только на приёмку/отгрузку и т.п.).

    const productAfter = await this.productsRepository.findById(idNum);
    const totalAfter = productAfter?.quantity != null ? Number(productAfter.quantity) : 0;

    scheduleStockMovementMarketplaceSync(idNum, {
      source: `stock_movement:${type}`,
      warehouseId,
      organizationId: orgId
    });

    return {
      productId: idNum,
      quantityBefore: totalBefore,
      quantityAfter: totalAfter,
      delta: quantityChange,
      warehouseId,
      movement
    };
  }

  /**
   * Получить историю движений по товару; синхронизирует products.reserved_quantity с журналом.
   */
  async getHistory(productId, { limit = 100, profileId = null, warehouseId = null } = {}) {
    const cap = Math.max(1, Math.min(500, Number(limit) || 100));
    const idNum = typeof productId === 'string' ? parseInt(productId, 10) : Number(productId);
    if (!idNum || Number.isNaN(idNum)) {
      return { movements: [], netReserved: 0 };
    }

    if (await this.hasJournalReserveDrift(idNum, { profileId })) {
      await this.reconcileJournalReserveForProduct(idNum, { profileId }).catch(() => {});
    }

    let whFilter = null;
    if (warehouseId != null && String(warehouseId).trim() !== '') {
      whFilter = await this.productsRepository.resolveOwnWarehouseId(warehouseId);
    }

    const rows = await this.repository.findByProduct(productId, {
      limit: cap,
      profileId,
      warehouseId: whFilter
    });

    const { isKitProductId, isKitStockHistoryMovementType, getKitComponents, readKitDisplayReservedQuantity } =
      await import('./kitStock.service.js');
    const { syncProductReservedQuantityFromJournal } = await import('./sellableQuantity.service.js');
    const isKit = await isKitProductId(idNum);

    let netReserved;
    if (isKit) {
      netReserved = await readKitDisplayReservedQuantity(idNum);
      await syncProductReservedQuantityFromJournal(idNum, { reserved: netReserved });
    } else {
      netReserved = await syncProductReservedQuantityFromJournal(idNum);
      if (netReserved <= 0) {
        const { getReservedQuantityFromMovements } = await import('./sellableQuantity.service.js');
        netReserved = await getReservedQuantityFromMovements(idNum);
      }
      return { movements: rows, netReserved };
    }

    const combined = rows.filter((m) => isKitStockHistoryMovementType(m?.type));

    const comps = await getKitComponents(idNum);
    for (const c of comps || []) {
      const cid = Number(c.component_product_id);
      if (!Number.isFinite(cid) || cid < 1) continue;
      const compRows = await this.repository.findByProduct(cid, {
        limit: Math.min(cap, 80),
        profileId,
        warehouseId: whFilter
      });
      for (const m of compRows || []) {
        const t = String(m?.type || '').toLowerCase();
        if (t !== 'reserve' && t !== 'unreserve') continue;
        combined.push({
          ...m,
          meta: {
            ...(m.meta && typeof m.meta === 'object' ? m.meta : {}),
            kit_component_reserve: true,
            kit_product_id: idNum
          }
        });
      }
    }

    combined.sort((a, b) => {
      const ta = new Date(a.created_at || a.createdAt || 0).getTime();
      const tb = new Date(b.created_at || b.createdAt || 0).getTime();
      return tb - ta;
    });
    return { movements: combined.slice(0, cap), netReserved };
  }

  /**
   * Заказы, под которые сейчас числится ненулевой резерв товара (по журналу reserve/unreserve).
   * Формула нетто-резерва совпадает с products.repository / kitStock (unreserve уменьшает резерв).
   * Для комплектов reservedQty — целые комплекты под заказ (SKU + комплектующие), не «сырой» журнал SKU.
   */
  async listReservedOrdersForProduct(productId, { profileId = null, _skipStaleCleanup = false } = {}) {
    const idNum = typeof productId === 'string' ? parseInt(productId, 10) : Number(productId);
    if (!idNum || Number.isNaN(idNum) || idNum < 1) return [];

    const tid =
      profileId != null && profileId !== ''
        ? typeof profileId === 'string'
          ? parseInt(profileId, 10)
          : Number(profileId)
        : null;
    if (tid != null && Number.isFinite(tid) && tid > 0) {
      const pr = await query(`SELECT profile_id FROM products WHERE id = $1`, [idNum]);
      const own = pr.rows?.[0]?.profile_id;
      if (own != null && String(own) !== String(tid)) return [];
    }

    const { isKitProductId, getReservedKitUnitsForOrder } = await import('./kitStock.service.js');
    const isKit = await isKitProductId(idNum);

    const movementScopeSql = isKit
      ? `product_id = $1
           OR product_id IN (
             SELECT component_product_id FROM kit_components WHERE kit_product_id = $1
           )`
      : `product_id = $1`;

    const res = await query(
      `WITH order_ids AS (
         SELECT DISTINCT (COALESCE(NULLIF(meta->>'order_id',''), NULLIF(meta->>'orderId','')))::bigint AS order_row_id
         FROM stock_movements
         WHERE (${movementScopeSql})
           AND type IN ('reserve', 'unreserve')
           AND (COALESCE(NULLIF(meta->>'order_id',''), NULLIF(meta->>'orderId',''))) ~ '^[0-9]+$'
           AND (COALESCE(NULLIF(meta->>'order_id',''), NULLIF(meta->>'orderId','')))::bigint > 0
       ),
       sku_net AS (
         SELECT (COALESCE(NULLIF(meta->>'order_id',''), NULLIF(meta->>'orderId','')))::bigint AS order_row_id,
           ${NET_RESERVED_SUM_EXPR_SQL}::int AS sku_net_qty
         FROM stock_movements
         WHERE product_id = $1
           AND type IN ('reserve', 'unreserve')
           AND (COALESCE(NULLIF(meta->>'order_id',''), NULLIF(meta->>'orderId',''))) ~ '^[0-9]+$'
         GROUP BY 1
       )
       SELECT o.id,
              o.marketplace,
              o.order_id,
              o.status,
              COALESCE(sku_net.sku_net_qty, 0) AS sku_net_qty,
              (o.id IS NULL) AS order_missing,
              order_ids.order_row_id AS movement_order_db_id
       FROM order_ids
       LEFT JOIN sku_net ON sku_net.order_row_id = order_ids.order_row_id
       LEFT JOIN orders o ON o.id = order_ids.order_row_id
       WHERE COALESCE(sku_net.sku_net_qty, 0) > 0
       ORDER BY o.created_at DESC NULLS LAST, order_ids.order_row_id DESC
       LIMIT 200`,
      [idNum]
    );

    if (!_skipStaleCleanup && (res.rows?.length ?? 0) > 0) {
      const { default: ordersService, isOrderTerminalNoReserve } = await import('./orders.service.js');
      let cleaned = false;
      for (const r of res.rows || []) {
        if (r.order_missing === true) continue;
        if (!isOrderTerminalNoReserve(r.status)) continue;
        const clientMp =
          r.marketplace === 'wb' ? 'wildberries' : r.marketplace === 'ym' ? 'yandex' : 'ozon';
        await ordersService.releaseReserveIfExistsForOrder(clientMp, r.order_id);
        cleaned = true;
      }
      if (cleaned) {
        return this.listReservedOrdersForProduct(productId, { profileId, _skipStaleCleanup: true });
      }
    }

    const { isOrderTerminalNoReserve } = await import('./orders.service.js');

    const out = [];
    for (const r of res.rows || []) {
      const movementOrderDbId = Number(r.movement_order_db_id);
      const orderDbId = Number(r.id);
      const orderMissing = r.order_missing === true;

      if (orderMissing) {
        const reservedQty = Number(r.sku_net_qty) || 0;
        if (reservedQty <= 0) continue;
        out.push({
          orderDbId: Number.isFinite(movementOrderDbId) ? movementOrderDbId : null,
          marketplace: 'ozon',
          orderId: `удалён #${movementOrderDbId}`,
          status: 'заказ удалён',
          reservedQty,
          staleReserve: true,
          deletedOrderReserve: true
        });
        continue;
      }

      if (!Number.isFinite(orderDbId) || orderDbId < 1) continue;

      let reservedQty = Number(r.sku_net_qty) || 0;
      if (isKit) {
        reservedQty = await getReservedKitUnitsForOrder(idNum, orderDbId);
      }
      if (reservedQty <= 0) continue;

      const status = r.status != null ? String(r.status) : '';
      out.push({
        orderDbId,
        marketplace:
          r.marketplace === 'wb' ? 'wildberries' : r.marketplace === 'ym' ? 'yandex' : 'ozon',
        orderId: r.order_id,
        status,
        reservedQty,
        staleReserve: isOrderTerminalNoReserve(status),
        ...(isKit ? { kitSkuNetQty: Number(r.sku_net_qty) || 0 } : {})
      });
    }
    return out;
  }

  /**
   * Резерв под поставки FBO (meta.fbo_supply_item_id) — в колонке «Резерв» учитывается, в заказах не показывается.
   */
  async listFboReservedSuppliesForProduct(productId, { profileId = null } = {}) {
    const idNum = typeof productId === 'string' ? parseInt(productId, 10) : Number(productId);
    if (!idNum || Number.isNaN(idNum) || idNum < 1) return [];

    const tid =
      profileId != null && profileId !== ''
        ? typeof profileId === 'string'
          ? parseInt(profileId, 10)
          : Number(profileId)
        : null;
    if (tid != null && Number.isFinite(tid) && tid > 0) {
      const pr = await query(`SELECT profile_id FROM products WHERE id = $1`, [idNum]);
      const own = pr.rows?.[0]?.profile_id;
      if (own != null && String(own) !== String(tid)) return [];
    }

    const res = await query(
      `WITH nets AS (
         SELECT meta->>'fbo_supply_item_id' AS item_id,
                meta->>'fbo_supply_id' AS supply_id,
                GREATEST(0, COALESCE(SUM(${NET_RESERVED_MOVEMENT_ROW_CASE_SQL}), 0))::int AS reserved_qty
         FROM stock_movements
         WHERE product_id = $1
           AND type IN ('reserve', 'unreserve')
           AND meta->>'fbo_supply_item_id' IS NOT NULL
           AND (meta->>'fbo_supply_item_id') ~ '^[0-9]+$'
         GROUP BY meta->>'fbo_supply_item_id', meta->>'fbo_supply_id'
         HAVING GREATEST(0, COALESCE(SUM(${NET_RESERVED_MOVEMENT_ROW_CASE_SQL}), 0)) > 0
       )
       SELECT n.item_id,
              n.supply_id,
              n.reserved_qty,
              s.marketplace,
              s.status,
              s.external_shipment_number,
              si.quantity::int AS line_qty
       FROM nets n
       LEFT JOIN fbo_supplies s ON s.id = (n.supply_id)::bigint
       LEFT JOIN fbo_supply_items si ON si.id = (n.item_id)::bigint
       WHERE ($2::bigint IS NULL OR s.profile_id = $2 OR s.id IS NULL)
       ORDER BY s.ready_at ASC NULLS LAST, s.id DESC, n.item_id`,
      [idNum, tid]
    );

    return (res.rows || []).map((r) => {
      const supplyId = Number(r.supply_id);
      const supplyItemId = Number(r.item_id);
      const ext = r.external_shipment_number != null ? String(r.external_shipment_number).trim() : '';
      const label = ext
        ? `FBO ${ext}`
        : Number.isFinite(supplyId) && supplyId > 0
          ? `FBO поставка №${supplyId}`
          : 'FBO поставка';
      return {
        supplyId: Number.isFinite(supplyId) ? supplyId : null,
        supplyItemId: Number.isFinite(supplyItemId) ? supplyItemId : null,
        reservedQty: Number(r.reserved_qty) || 0,
        marketplace: r.marketplace != null ? String(r.marketplace) : '',
        status: r.status != null ? String(r.status) : '',
        externalShipmentNumber: ext,
        lineQty: Number(r.line_qty) || 0,
        label
      };
    });
  }

  /**
   * Сводка резерва для модалки остатков (комплект: колонка = только SKU комплекта).
   */
  async getReserveSummaryForProduct(productId, { profileId = null } = {}) {
    const idNum = typeof productId === 'string' ? parseInt(productId, 10) : Number(productId);
    if (!idNum || Number.isNaN(idNum) || idNum < 1) {
      return {
        displayReservedQty: 0,
        ordersReservedQty: 0,
        componentJournalReserve: 0,
        orphanComponentReserve: 0,
        orphanJournalReserve: 0,
        fboReservedQty: 0
      };
    }

    const fboSupplies = await this.listFboReservedSuppliesForProduct(idNum, { profileId });
    const fboReservedQty = fboSupplies.reduce((s, row) => s + (Number(row.reservedQty) || 0), 0);

    const orders = await this.listReservedOrdersForProduct(idNum, {
      profileId,
      _skipStaleCleanup: true
    });
    const ordersReservedQty = orders.reduce((s, o) => s + (Number(o.reservedQty) || 0), 0);

    const { isKitProductId, readKitDisplayReservedQuantity, getKitComponents } =
      await import('./kitStock.service.js');
    const { getReservedQuantityFromMovements } = await import('./sellableQuantity.service.js');

    const isKit = await isKitProductId(idNum);
    const displayReservedQty = isKit
      ? await readKitDisplayReservedQuantity(idNum)
      : await getReservedQuantityFromMovements(idNum);

    let componentJournalReserve = 0;
    if (isKit) {
      const comps = await getKitComponents(idNum);
      for (const c of comps || []) {
        const cid = Number(c.component_product_id);
        if (!Number.isFinite(cid) || cid < 1) continue;
        componentJournalReserve += await getReservedQuantityFromMovements(cid);
      }
    }

    const orphanComponentReserve =
      isKit && orders.length === 0 && componentJournalReserve > 0 ? componentJournalReserve : 0;

    /** Резерв в журнале сверх заказов и FBO (лишний нетто в журнале). */
    const orphanJournalReserve = Math.max(
      0,
      displayReservedQty - ordersReservedQty - fboReservedQty
    );
    /** Нетто в журнале меньше, чем резерв по заказам/FBO (лишние unreserve без привязки). */
    const journalDeficit = Math.max(
      0,
      ordersReservedQty + fboReservedQty - displayReservedQty
    );

    return {
      displayReservedQty,
      ordersReservedQty,
      fboReservedQty,
      componentJournalReserve,
      orphanComponentReserve,
      orphanJournalReserve,
      journalDeficit,
      isKit
    };
  }

  /** Нетто-резерв FBO по product_id (только строки с fbo_supply_item_id). */
  async _fboJournalNetForProduct(productId) {
    const pid = Number(productId);
    if (!Number.isFinite(pid) || pid < 1) return 0;
    const r = await query(
      `SELECT GREATEST(0, COALESCE(SUM(${NET_RESERVED_MOVEMENT_ROW_CASE_SQL}), 0))::int AS rv
       FROM stock_movements
       WHERE product_id = $1
         AND type IN ('reserve', 'unreserve')
         AND meta->>'fbo_supply_item_id' IS NOT NULL
         AND (meta->>'fbo_supply_item_id') ~ '^[0-9]+$'`,
      [pid]
    );
    return Number(r.rows?.[0]?.rv ?? 0) || 0;
  }

  /** Нетто и сырое нетто резерва по product_id в журнале. */
  async _journalNetsForProduct(productId) {
    const pid = Number(productId);
    if (!Number.isFinite(pid) || pid < 1) {
      return { journalNet: 0, rawNet: 0 };
    }
    const r = await query(
      `SELECT ${NET_RESERVED_SUM_EXPR_SQL}::int AS net,
              ${RAW_RESERVED_SUM_EXPR_SQL}::numeric AS raw
       FROM stock_movements
       WHERE product_id = $1 AND type IN ('reserve', 'unreserve')`,
      [pid]
    );
    const row = r.rows?.[0];
    return {
      journalNet: Number(row?.net ?? 0) || 0,
      rawNet: Number(row?.raw ?? 0) || 0
    };
  }

  /** Сумма положительных нетто-резервов по заказам (meta.order_id) для product_id. */
  async _ordersJournalNetForProduct(productId) {
    const pid = Number(productId);
    if (!Number.isFinite(pid) || pid < 1) return 0;
    const r = await query(
      `WITH nets AS (
         SELECT ${NET_RESERVED_SUM_EXPR_SQL}::int AS net_r
         FROM stock_movements
         WHERE product_id = $1
           AND type IN ('reserve', 'unreserve')
           AND (COALESCE(NULLIF(meta->>'order_id',''), NULLIF(meta->>'orderId',''))) ~ '^[0-9]+$'
         GROUP BY (COALESCE(NULLIF(meta->>'order_id',''), NULLIF(meta->>'orderId','')))::bigint
       )
       SELECT COALESCE(SUM(net_r), 0)::int AS total FROM nets WHERE net_r > 0`,
      [pid]
    );
    return Number(r.rows?.[0]?.total ?? 0) || 0;
  }

  /**
   * Корректирующая запись в журнал (без проверки остатка и без pg_advisory_lock сессии).
   */
  async _applyJournalReconcileDelta(productId, { type, qty, reason, meta = {} } = {}) {
    const pid = Number(productId);
    const units = Math.floor(Number(qty) || 0);
    if (!Number.isFinite(pid) || pid < 1 || units < 1) return null;

    const product = await this.productsRepository.findById(pid);
    if (!product) {
      const error = new Error('Товар не найден');
      error.statusCode = 404;
      throw error;
    }

    const metaObj = meta && typeof meta === 'object' && !Array.isArray(meta) ? { ...meta } : {};
    const warehouseId = await this.resolveWarehouseIdForProductStock(
      pid,
      metaObj.warehouse_id ?? metaObj.warehouseId
    );
    if (!warehouseId) {
      const error = new Error('Не найден склад для операции');
      error.statusCode = 400;
      throw error;
    }

    const typeNorm = String(type || '').toLowerCase();
    const quantityChange =
      typeNorm === 'reserve' ? -units : typeNorm === 'unreserve' ? units : null;
    if (quantityChange == null) {
      const error = new Error('Некорректный тип сверки журнала');
      error.statusCode = 400;
      throw error;
    }

    const profId = product.profile_id ?? product.profileId ?? null;
    const metaOut = { ...metaObj, warehouse_id: warehouseId, journal_reconcile: true };

    const client = await getClient();
    try {
      await client.query('BEGIN');
      const movement = await this.repository.insertSnapshotAfterProduct(client, {
        productId: pid,
        type: typeNorm,
        quantityChange,
        reason: reason || null,
        meta: metaOut,
        warehouseId,
        profileId: profId
      });
      const movementId = movement?.id ?? movement?.movement_id;
      if (movementId != null) {
        await client.query(
          `UPDATE stock_movements sm
           SET reserved_after = COALESCE((
             SELECT ${NET_RESERVED_SUM_EXPR_SQL}::int
             FROM stock_movements
             WHERE product_id = $1 AND type IN ('reserve', 'unreserve')
           ), 0)
           WHERE sm.id = $2`,
          [pid, movementId]
        );
      }
      await client.query(
        `UPDATE products p
         SET reserved_quantity = COALESCE((
           SELECT ${NET_RESERVED_SUM_EXPR_SQL}::int
           FROM stock_movements sm
           WHERE sm.product_id = p.id AND sm.type IN ('reserve', 'unreserve')
         ), 0),
         updated_at = CURRENT_TIMESTAMP
         WHERE p.id = $1::bigint`,
        [pid]
      );
      await client.query('COMMIT');
      if (movementId != null) {
        const rv = await query(
          `SELECT reserved_after FROM stock_movements WHERE id = $1`,
          [movementId]
        );
        if (movement && rv.rows?.[0]) {
          movement.reserved_after = rv.rows[0].reserved_after;
        }
      }
      return movement;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * Выровнять нетто журнала с суммой резерва по заказам и FBO для одного product_id.
   * Устраняет «лишние» unreserve без order_id, из‑за которых глобальный нетто = 0 при активных заказах.
   */
  async _reconcileJournalNetForProductId(productId, { profileId = null, sourceProductId = null } = {}) {
    const pid = Number(productId);
    if (!Number.isFinite(pid) || pid < 1) {
      return { productId: pid, reserveAdded: 0, unreserveAdded: 0, skipped: true };
    }

    const { journalNet, rawNet } = await this._journalNetsForProduct(pid);
    const ordersNet = await this._ordersJournalNetForProduct(pid);
    const fboNet = await this._fboJournalNetForProduct(pid);
    const expectedNet = ordersNet + fboNet;
    const rawDrift = rawNet - expectedNet;

    if (rawDrift === 0) {
      return { productId: pid, reserveAdded: 0, unreserveAdded: 0, skipped: true, journalNet, rawNet, expectedNet };
    }

    const src = Number(sourceProductId) || pid;
    if (rawDrift < 0) {
      const add = Math.floor(-rawDrift);
      if (add < 1) {
        return { productId: pid, reserveAdded: 0, unreserveAdded: 0, skipped: true, journalNet, rawNet, expectedNet };
      }
      await this._applyJournalReconcileDelta(pid, {
        type: 'reserve',
        qty: add,
        reason: 'Сверка журнала резерва с заказами и FBO',
        meta: {
          deficit_qty: add,
          source_product_id: src,
          journal_net_before: journalNet,
          expected_net: expectedNet
        }
      });
      return { productId: pid, reserveAdded: add, unreserveAdded: 0, skipped: false, journalNet, rawNet, expectedNet };
    }

    const release = Math.floor(rawDrift);
    if (release < 1) {
      return { productId: pid, reserveAdded: 0, unreserveAdded: 0, skipped: true, journalNet, expectedNet };
    }
    await this._applyJournalReconcileDelta(pid, {
      type: 'unreserve',
      qty: release,
      reason: 'Снятие резерва без привязки к заказу или FBO',
      meta: {
        orphan_cleanup: true,
        unattributed_qty: release,
        source_product_id: src,
        journal_net_before: journalNet,
        expected_net: expectedNet
      }
    });
    return { productId: pid, reserveAdded: 0, unreserveAdded: release, skipped: false, journalNet, rawNet, expectedNet };
  }

  /** Есть ли рассинхрон нетто журнала с резервом по заказам/FBO (комплект + комплектующие). */
  async hasJournalReserveDrift(productId, { profileId = null } = {}) {
    const idNum = typeof productId === 'string' ? parseInt(productId, 10) : Number(productId);
    if (!idNum || Number.isNaN(idNum) || idNum < 1) return false;

    const tid =
      profileId != null && profileId !== ''
        ? typeof profileId === 'string'
          ? parseInt(profileId, 10)
          : Number(profileId)
        : null;
    if (tid != null && Number.isFinite(tid) && tid > 0) {
      const pr = await query(`SELECT profile_id FROM products WHERE id = $1`, [idNum]);
      const own = pr.rows?.[0]?.profile_id;
      if (own != null && String(own) !== String(tid)) return false;
    }

    const productIds = await this._productIdsForReserveRelease(idNum);
    for (const pid of productIds) {
      const { rawNet } = await this._journalNetsForProduct(pid);
      const ordersNet = await this._ordersJournalNetForProduct(pid);
      const fboNet = await this._fboJournalNetForProduct(pid);
      if (rawNet !== ordersNet + fboNet) return true;
    }
    return false;
  }

  /**
   * Сверка журнала резерва для товара (комплект + комплектующие).
   */
  async reconcileJournalReserveForProduct(productId, { profileId = null } = {}) {
    const idNum = typeof productId === 'string' ? parseInt(productId, 10) : Number(productId);
    if (!idNum || Number.isNaN(idNum) || idNum < 1) {
      return { lines: 0, reserveAdded: 0, unreserveAdded: 0, details: [] };
    }

    const tid =
      profileId != null && profileId !== ''
        ? typeof profileId === 'string'
          ? parseInt(profileId, 10)
          : Number(profileId)
        : null;
    if (tid != null && Number.isFinite(tid) && tid > 0) {
      const pr = await query(`SELECT profile_id FROM products WHERE id = $1`, [idNum]);
      const own = pr.rows?.[0]?.profile_id;
      if (own != null && String(own) !== String(tid)) {
        return { lines: 0, reserveAdded: 0, unreserveAdded: 0, details: [] };
      }
    }

    const productIds = await this._productIdsForReserveRelease(idNum);
    const details = [];
    let reserveAdded = 0;
    let unreserveAdded = 0;
    let lines = 0;

    for (const pid of productIds) {
      const row = await this._reconcileJournalNetForProductId(pid, {
        profileId,
        sourceProductId: idNum
      });
      if (!row.skipped) {
        lines += 1;
        reserveAdded += row.reserveAdded || 0;
        unreserveAdded += row.unreserveAdded || 0;
      }
      details.push(row);
    }

    const { syncProductReservedQuantityFromJournal } = await import('./sellableQuantity.service.js');
    const { isKitProductId, readKitDisplayReservedQuantity } = await import('./kitStock.service.js');
    try {
      if (await isKitProductId(idNum)) {
        const net = await readKitDisplayReservedQuantity(idNum);
        await syncProductReservedQuantityFromJournal(idNum, { reserved: net });
      } else {
        await syncProductReservedQuantityFromJournal(idNum);
      }
    } catch {
      /* ignore */
    }

    return { lines, reserveAdded, unreserveAdded, details };
  }

  /**
   * Снять резерв в журнале без заказа и без FBO (рассинхрон / удалённая запись).
   */
  async releaseUnattributedJournalReserve(productId, { profileId = null } = {}) {
    const idNum = typeof productId === 'string' ? parseInt(productId, 10) : Number(productId);
    if (!idNum || Number.isNaN(idNum) || idNum < 1) {
      const error = new Error('Некорректный ID товара');
      error.statusCode = 400;
      throw error;
    }

    const summary = await this.getReserveSummaryForProduct(idNum, { profileId });
    const orphanQty = Math.floor(Number(summary.orphanJournalReserve) || 0);
    if (orphanQty <= 0) {
      const deficit = Math.floor(Number(summary.journalDeficit) || 0);
      if (deficit > 0) {
        const recon = await this.reconcileJournalReserveForProduct(idNum, { profileId });
        return {
          releasedProductLines: recon.lines,
          releasedQty: recon.unreserveAdded,
          reserveAdded: recon.reserveAdded,
          skipped: recon.lines === 0
        };
      }
      return { releasedProductLines: 0, releasedQty: 0, skipped: true };
    }

    const recon = await this.reconcileJournalReserveForProduct(idNum, { profileId });
    return {
      releasedProductLines: recon.lines,
      releasedQty: recon.unreserveAdded,
      reserveAdded: recon.reserveAdded,
      skipped: recon.lines === 0
    };
  }

  /**
   * Снять весь нетто-резерв, если нет ни заказов, ни FBO (ручная очистка со страницы остатков).
   */
  async releaseOrphanNetReserveForProduct(productId, { profileId = null } = {}) {
    const idNum = typeof productId === 'string' ? parseInt(productId, 10) : Number(productId);
    if (!idNum || Number.isNaN(idNum) || idNum < 1) {
      const error = new Error('Некорректный ID товара');
      error.statusCode = 400;
      throw error;
    }

    const summary = await this.getReserveSummaryForProduct(idNum, { profileId });
    if (Number(summary.orphanJournalReserve) > 0) {
      return this.releaseUnattributedJournalReserve(idNum, { profileId });
    }

    const orders = await this.listReservedOrdersForProduct(idNum, {
      profileId,
      _skipStaleCleanup: true
    });
    const fbo = await this.listFboReservedSuppliesForProduct(idNum, { profileId });
    if (orders.length > 0 || fbo.length > 0) {
      return { releasedProductLines: 0, skipped: true };
    }

    const { getReservedQuantityFromMovements } = await import('./sellableQuantity.service.js');
    const productIds = await this._productIdsForReserveRelease(idNum);
    let releasedProductLines = 0;

    for (const pid of productIds) {
      const net = await getReservedQuantityFromMovements(pid);
      if (net <= 0) continue;
      await this.applyChange(pid, {
        delta: net,
        type: 'unreserve',
        reason: 'Снятие резерва без активного заказа',
        meta: { manual_unreserve: true, orphan_cleanup: true, source_product_id: idNum }
      });
      releasedProductLines += 1;
    }

    return { releasedProductLines, skipped: false };
  }

  async _netReservedForOrderProduct(orderDbId, productId) {
    const oid = Number(orderDbId);
    const pid = Number(productId);
    if (!Number.isFinite(oid) || oid < 1 || !Number.isFinite(pid) || pid < 1) return 0;
    const r = await query(
      `SELECT ${NET_RESERVED_SUM_EXPR_SQL}::int AS rv
       FROM stock_movements
       WHERE product_id = $1
         AND type IN ('reserve', 'unreserve')
         AND (COALESCE(NULLIF(meta->>'order_id',''), NULLIF(meta->>'orderId',''))) ~ '^[0-9]+$'
         AND (COALESCE(NULLIF(meta->>'order_id',''), NULLIF(meta->>'orderId','')))::bigint = $2::bigint`,
      [pid, oid]
    );
    return Number(r.rows?.[0]?.rv ?? 0) || 0;
  }

  async _productIdsForReserveRelease(productId) {
    const pid = Number(productId);
    const ids = new Set([pid]);
    const { isKitProductId, getKitComponents } = await import('./kitStock.service.js');
    if (await isKitProductId(pid)) {
      const comps = await getKitComponents(pid);
      for (const c of comps || []) {
        const cid = Number(c.component_product_id);
        if (Number.isFinite(cid) && cid > 0) ids.add(cid);
      }
    }
    return [...ids];
  }

  /**
   * Снять весь нетто-резерв по товару (комплект + комплектующие) по всем заказам из журнала.
   * Не блокируется статусом заказа — ручная очистка со страницы остатков.
   */
  async releaseAllReservesForProduct(productId, { profileId = null } = {}) {
    const idNum = typeof productId === 'string' ? parseInt(productId, 10) : Number(productId);
    if (!idNum || Number.isNaN(idNum) || idNum < 1) {
      const error = new Error('Некорректный ID товара');
      error.statusCode = 400;
      throw error;
    }

    const list = await this.listReservedOrdersForProduct(idNum, { profileId, _skipStaleCleanup: true });
    let releasedOrders = 0;
    let releasedProductLines = 0;

    if (!list.length) {
      const orphan = await this.releaseOrphanNetReserveForProduct(idNum, { profileId });
      return {
        releasedOrders: 0,
        releasedProductLines: orphan.releasedProductLines || 0,
        ordersChecked: 0,
        orphanCleanup: true
      };
    }

    const productIds = await this._productIdsForReserveRelease(idNum);

    for (const row of list) {
      const orderDbId = row.orderDbId;
      const label = String(row.orderId ?? '');
      let touched = false;
      for (const pid of productIds) {
        const net = await this._netReservedForOrderProduct(orderDbId, pid);
        if (net <= 0) continue;
        await this.applyChange(pid, {
          delta: net,
          type: 'unreserve',
          reason: `Снятие резерва: очистка по товару, заказ ${label}`.trim(),
          meta: {
            order_id: orderDbId,
            orderId: label,
            manual_unreserve: true,
            bulk_product_release: true,
            source_product_id: idNum
          }
        });
        releasedProductLines += 1;
        touched = true;
      }
      if (touched) releasedOrders += 1;
    }

    return {
      releasedOrders,
      releasedProductLines,
      ordersChecked: list.length
    };
  }

  /** Снять резерв по одному заказу (со страницы остатков; без проверки статуса заказа). */
  async releaseOrderReserveForProduct(productId, orderDbId, { profileId = null } = {}) {
    const idNum = typeof productId === 'string' ? parseInt(productId, 10) : Number(productId);
    const oid = Number(orderDbId);
    if (!Number.isFinite(idNum) || idNum < 1 || !Number.isFinite(oid) || oid < 1) {
      const error = new Error('Некорректные параметры');
      error.statusCode = 400;
      throw error;
    }

    const tid =
      profileId != null && profileId !== ''
        ? typeof profileId === 'string'
          ? parseInt(profileId, 10)
          : Number(profileId)
        : null;
    if (tid != null && Number.isFinite(tid) && tid > 0) {
      const pr = await query(`SELECT profile_id FROM products WHERE id = $1`, [idNum]);
      const own = pr.rows?.[0]?.profile_id;
      if (own != null && String(own) !== String(tid)) {
        const error = new Error('Товар не найден');
        error.statusCode = 404;
        throw error;
      }
    }

    const or = await query(
      `SELECT order_id, marketplace FROM orders WHERE id = $1 LIMIT 1`,
      [oid]
    );
    const orderRow = or.rows?.[0];
    if (!orderRow) {
      const error = new Error('Заказ не найден');
      error.statusCode = 404;
      throw error;
    }

    const label = String(orderRow.order_id ?? '');
    const productIds = await this._productIdsForReserveRelease(idNum);
    let releasedProductLines = 0;
    for (const pid of productIds) {
      const net = await this._netReservedForOrderProduct(oid, pid);
      if (net <= 0) continue;
      await this.applyChange(pid, {
        delta: net,
        type: 'unreserve',
        reason: `Снятие резерва: заказ ${label}`.trim(),
        meta: {
          order_id: oid,
          orderId: label,
          manual_unreserve: true,
          source_product_id: idNum
        }
      });
      releasedProductLines += 1;
    }

    return { releasedProductLines, orderDbId: oid, orderId: label };
  }

  /**
   * Перемещение товара между складами (свободный остаток).
   * Делает два движения: -qty на складе-источнике и +qty на складе-получателе.
   *
   * @param {number|string} productId
   * @param {{ fromWarehouseId: number|string, toWarehouseId: number|string, quantity: number, reason?: string, meta?: object, profileId?: number|string|null }} options
   */
  async transfer(productId, { fromWarehouseId, toWarehouseId, quantity, reason, meta, profileId } = {}) {
    const pid = typeof productId === "string" ? parseInt(productId, 10) : Number(productId);
    if (!Number.isFinite(pid) || pid < 1) {
      const error = new Error('Некорректный ID товара');
      error.statusCode = 400;
      throw error;
    }

    const q = Number(quantity);
    if (!Number.isFinite(q) || q <= 0) {
      const error = new Error('quantity (количество) должно быть > 0');
      error.statusCode = 400;
      throw error;
    }

    const fromId = await this.productsRepository.resolveStrictOwnWarehouseId(fromWarehouseId);
    const toId = await this.productsRepository.resolveStrictOwnWarehouseId(toWarehouseId);
    if (!fromId || !toId) {
      const error = new Error('Укажите корректные склады (только свои склады типа warehouse)');
      error.statusCode = 400;
      throw error;
    }
    if (fromId === toId) {
      const error = new Error('Склад-источник и склад-получатель должны отличаться');
      error.statusCode = 400;
      throw error;
    }

    const whOrg = await query(
      `SELECT id, organization_id FROM warehouses WHERE id IN ($1, $2)`,
      [fromId, toId]
    );
    const orgByWh = new Map(
      (whOrg.rows || []).map((row) => [Number(row.id), row.organization_id != null ? Number(row.organization_id) : null])
    );
    if (!orgByWh.has(fromId) || !orgByWh.has(toId)) {
      const error = new Error('Склад не найден');
      error.statusCode = 404;
      throw error;
    }
    const orgFrom = orgByWh.get(fromId);
    const orgTo = orgByWh.get(toId);
    if (orgFrom != null && orgTo != null && orgFrom !== orgTo) {
      const error = new Error('Перемещение возможно только между складами одной организации');
      error.statusCode = 400;
      throw error;
    }
    if ((orgFrom == null) !== (orgTo == null)) {
      const error = new Error('Укажите склады одной организации (оба склада должны быть привязаны к одной организации)');
      error.statusCode = 400;
      throw error;
    }

    // Товар + проверка профиля (мультитенант).
    const product = await this.productsRepository.findById(pid);
    if (!product) {
      const error = new Error('Товар не найден');
      error.statusCode = 404;
      throw error;
    }
    const prodProfileId = product.profile_id ?? product.profileId ?? null;
    if (profileId != null && profileId !== '' && prodProfileId != null && String(prodProfileId) !== String(profileId)) {
      const error = new Error('Товар не найден');
      error.statusCode = 404;
      throw error;
    }
    const prodOrgId = product.organization_id ?? product.organizationId ?? null;
    const prodOrgNum = prodOrgId != null && prodOrgId !== '' ? Number(prodOrgId) : null;
    if (
      orgFrom != null &&
      prodOrgNum != null &&
      Number.isFinite(prodOrgNum) &&
      prodOrgNum !== orgFrom
    ) {
      const error = new Error('Товар не относится к организации выбранных складов');
      error.statusCode = 400;
      throw error;
    }

    // Транзакция нужна, чтобы не потерять остаток при параллельных перемещениях/списаниях.
    const client = await getClient();
    const transferId =
      meta?.transfer_id ||
      `tr_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const metaObj = meta && typeof meta === 'object' && !Array.isArray(meta) ? { ...meta } : {};
    metaObj.transfer_id = transferId;
    metaObj.from_warehouse_id = fromId;
    metaObj.to_warehouse_id = toId;

    try {
      await client.query('BEGIN');

      // Гарантируем строки в product_warehouse_stock.
      await client.query(
        `INSERT INTO product_warehouse_stock (product_id, warehouse_id, quantity)
         VALUES ($1, $2, 0), ($1, $3, 0)
         ON CONFLICT (product_id, warehouse_id) DO NOTHING`,
        [pid, fromId, toId]
      );

      // Блокируем обе строки.
      const r = await client.query(
        `SELECT warehouse_id, quantity
         FROM product_warehouse_stock
         WHERE product_id = $1 AND warehouse_id IN ($2, $3)
         FOR UPDATE`,
        [pid, fromId, toId]
      );
      const byWh = new Map(r.rows.map((x) => [Number(x.warehouse_id), Number(x.quantity) || 0]));
      const fromQty = byWh.get(fromId) ?? 0;
      const toQty = byWh.get(toId) ?? 0;

      if (fromQty < q) {
        const error = new Error(`Недостаточно остатка на складе-источнике (доступно: ${fromQty}, нужно: ${q})`);
        error.statusCode = 400;
        throw error;
      }

      const nextFrom = fromQty - q;
      const nextTo = toQty + q;

      await client.query(
        `UPDATE product_warehouse_stock SET quantity = $3 WHERE product_id = $1 AND warehouse_id = $2`,
        [pid, fromId, nextFrom]
      );
      await client.query(
        `UPDATE product_warehouse_stock SET quantity = $3 WHERE product_id = $1 AND warehouse_id = $2`,
        [pid, toId, nextTo]
      );

      const insertMovement = async ({ delta, warehouseId, direction }) => {
        const metaMove = { ...metaObj, direction };
        return await this.repository.insertSnapshotAfterProduct(client, {
          productId: pid,
          type: 'transfer',
          quantityChange: delta,
          reason: reason || null,
          meta: metaMove,
          warehouseId,
          profileId: prodProfileId,
        });
      };

      const movementOut = await insertMovement({ delta: -q, warehouseId: fromId, direction: 'out' });
      const movementIn = await insertMovement({ delta: q, warehouseId: toId, direction: 'in' });

      await client.query('COMMIT');

      await syncProductQuantityFromWarehouseStock(pid);

      return {
        ok: true,
        productId: pid,
        fromWarehouseId: fromId,
        toWarehouseId: toId,
        quantity: q,
        fromBefore: fromQty,
        fromAfter: nextFrom,
        toBefore: toQty,
        toAfter: nextTo,
        transferId,
        movements: { out: movementOut, in: movementIn },
      };
    } catch (e) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw e;
    } finally {
      try {
        client.release();
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Очистить историю движений по товару и задать текущие: в пути, наличие на складе, резерв.
   * Доступно пересчитывается на клиенте (наличие + в пути − резерв).
   */
  async resetProductStockHistoryAndSetValues(
    productId,
    { warehouseId, incoming, onHand, reserved, profileId, reason = null } = {}
  ) {
    const pid = typeof productId === 'string' ? parseInt(productId, 10) : Number(productId);
    if (!Number.isFinite(pid) || pid < 1) {
      const error = new Error('Некорректный ID товара');
      error.statusCode = 400;
      throw error;
    }

    await this.assertStockHistoryResetAllowed(profileId);

    const product = await this.productsRepository.findById(pid);
    if (!product) {
      const error = new Error('Товар не найден');
      error.statusCode = 404;
      throw error;
    }

    const productProfileId = product.profile_id ?? product.profileId ?? null;
    if (profileId != null && productProfileId != null && String(productProfileId) !== String(profileId)) {
      const error = new Error('Нет доступа к товару');
      error.statusCode = 403;
      throw error;
    }

    const pt = String(product.product_type ?? product.productType ?? '').trim().toLowerCase();
    if (pt === 'kit') {
      const error = new Error('Для комплектов сброс истории недоступен');
      error.statusCode = 400;
      throw error;
    }

    const whId = await this.productsRepository.resolveOwnWarehouseId(warehouseId);
    if (!whId) {
      const error = new Error('Укажите склад для установки наличия');
      error.statusCode = 400;
      throw error;
    }

    const incomingN = Math.max(0, Math.floor(Number(incoming) || 0));
    const onHandN = Math.max(0, Math.floor(Number(onHand) || 0));
    const reservedN = Math.max(0, Math.floor(Number(reserved) || 0));
    const profId = productProfileId;
    const resetReason = reason || 'Сброс истории остатков администратором аккаунта';

    return runWithProductStockLock(pid, async () => {
      const client = await getClient();
      try {
        await client.query('BEGIN');
        await client.query('SELECT id FROM products WHERE id = $1 FOR UPDATE', [pid]);

        await client.query('DELETE FROM stock_movements WHERE product_id = $1', [pid]);
        await client.query('DELETE FROM product_warehouse_stock WHERE product_id = $1', [pid]);
        await client.query(
          `INSERT INTO product_warehouse_stock (product_id, warehouse_id, quantity)
           VALUES ($1, $2, $3)
           ON CONFLICT (product_id, warehouse_id) DO UPDATE SET quantity = EXCLUDED.quantity`,
          [pid, whId, onHandN]
        );
        await client.query(
          `UPDATE products
           SET quantity = $1,
               incoming_quantity = $2,
               reserved_quantity = 0,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $3`,
          [onHandN, incomingN, pid]
        );

        const metaBase = {
          stock_history_reset: true,
          warehouse_id: whId,
          admin_set: { incoming: incomingN, onHand: onHandN, reserved: reservedN },
        };

        if (onHandN > 0) {
          await this.repository.insertSnapshotAfterProduct(client, {
            productId: pid,
            type: 'opening_balance',
            quantityChange: onHandN,
            reason: resetReason,
            meta: metaBase,
            warehouseId: whId,
            profileId: profId,
          });
        }

        if (incomingN > 0) {
          await this.repository.insertSnapshotAfterProduct(client, {
            productId: pid,
            type: 'incoming',
            quantityChange: incomingN,
            reason: `${resetReason}: в пути`,
            meta: metaBase,
            warehouseId: null,
            profileId: profId,
          });
        }

        if (reservedN > 0) {
          const reserveMovement = await this.repository.insertSnapshotAfterProduct(client, {
            productId: pid,
            type: 'reserve',
            quantityChange: -reservedN,
            reason: `${resetReason}: резерв`,
            meta: { ...metaBase, journal_reconcile: true },
            warehouseId: whId,
            profileId: profId,
          });
          const movementId = reserveMovement?.id ?? reserveMovement?.movement_id;
          if (movementId != null) {
            await client.query(
              `UPDATE stock_movements sm
               SET reserved_after = COALESCE((
                 SELECT ${NET_RESERVED_SUM_EXPR_SQL}::int
                 FROM stock_movements
                 WHERE product_id = $1 AND type IN ('reserve', 'unreserve')
               ), 0)
               WHERE sm.id = $2`,
              [pid, movementId]
            );
          }
          await client.query(
            `UPDATE products p
             SET reserved_quantity = COALESCE((
               SELECT ${NET_RESERVED_SUM_EXPR_SQL}::int
               FROM stock_movements sm
               WHERE sm.product_id = p.id AND sm.type IN ('reserve', 'unreserve')
             ), 0),
             updated_at = CURRENT_TIMESTAMP
             WHERE p.id = $1::bigint`,
            [pid]
          );
        }

        await client.query('COMMIT');

        const { syncProductReservedQuantityFromJournal } = await import('./sellableQuantity.service.js');
        const netReserved = await syncProductReservedQuantityFromJournal(pid);

        const orgId = product.organization_id ?? product.organizationId ?? null;
        scheduleStockMovementMarketplaceSync(pid, {
          source: 'stock_history_reset',
          warehouseId: whId,
          organizationId: orgId,
        });

        const available = Math.max(0, onHandN + incomingN - (netReserved || reservedN));

        return {
          productId: pid,
          warehouseId: whId,
          incoming: incomingN,
          onHand: onHandN,
          reserved: netReserved || reservedN,
          available,
        };
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    });
  }
}

export default new StockMovementsService();
