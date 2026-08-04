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
  RAW_RESERVED_SUM_EXPR_SQL,
  orderReserveMovementMatchSql,
  parseStockMovementWarehouseId,
  stockMovementMetaOrderKeySql,
  stockMovementWarehouseStrictSql
} from '../constants/netReservedStockSql.js';
import { syncProductQuantityFromWarehouseStock } from './productWarehouseQuantity.service.js';

const STOCK_LOCK_MAX_CONCURRENT = (() => {
  const n = Number(process.env.PRODUCT_STOCK_LOCK_MAX);
  if (Number.isFinite(n) && n >= 1) return Math.min(16, Math.floor(n));
  return 6;
})();

let stockLockInUse = 0;
const stockLockWaitQueue = [];

const STOCK_LOCK_WAIT_MS = (() => {
  const n = Number(process.env.PRODUCT_STOCK_LOCK_WAIT_MS);
  if (Number.isFinite(n) && n >= 5000) return Math.min(120000, Math.floor(n));
  return 45000;
})();

function acquireStockLockSlot() {
  if (stockLockInUse < STOCK_LOCK_MAX_CONCURRENT) {
    stockLockInUse += 1;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const entry = { resolve, reject, timer: null };
    entry.timer = setTimeout(() => {
      const idx = stockLockWaitQueue.indexOf(entry);
      if (idx >= 0) stockLockWaitQueue.splice(idx, 1);
      const err = new Error(
        'Операция со складом ожидает освобождения блокировки слишком долго. Повторите через несколько секунд.'
      );
      err.statusCode = 503;
      err.code = 'STOCK_LOCK_TIMEOUT';
      reject(err);
    }, STOCK_LOCK_WAIT_MS);
    stockLockWaitQueue.push(entry);
  }).then(() => {
    stockLockInUse += 1;
  });
}

function releaseStockLockSlot() {
  stockLockInUse = Math.max(0, stockLockInUse - 1);
  const next = stockLockWaitQueue.shift();
  if (!next) return;
  if (next.timer) clearTimeout(next.timer);
  next.resolve();
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
  async resolveWarehouseIdForProductStock(productId, preferredWarehouseId = null, profileId = null) {
    const idNum = Number(productId);
    let effectiveProfileId = profileId;
    if (!effectiveProfileId && Number.isFinite(idNum) && idNum > 0) {
      const product = await this.productsRepository.findById(idNum);
      effectiveProfileId = product?.profile_id ?? product?.profileId ?? null;
    }
    if (!Number.isFinite(idNum) || idNum < 1) {
      return this.productsRepository.resolveOwnWarehouseId(preferredWarehouseId, effectiveProfileId);
    }
    const pref = await this.productsRepository.resolveOwnWarehouseId(
      preferredWarehouseId,
      effectiveProfileId
    );
    if (pref) {
      const onPref = await this.productsRepository.getWarehouseFreeStock(idNum, pref);
      if (onPref > 0) return pref;
    }
    const withStock = effectiveProfileId
      ? await query(
          `SELECT pws.warehouse_id
           FROM product_warehouse_stock pws
           INNER JOIN warehouses w ON w.id = pws.warehouse_id
           WHERE pws.product_id = $1
             AND COALESCE(pws.quantity, 0) > 0
             AND w.profile_id = $2
           ORDER BY pws.quantity DESC, pws.warehouse_id ASC
           LIMIT 1`,
          [idNum, effectiveProfileId]
        )
      : await query(
          `SELECT warehouse_id FROM product_warehouse_stock
           WHERE product_id = $1 AND COALESCE(quantity, 0) > 0
           ORDER BY quantity DESC, warehouse_id ASC
           LIMIT 1`,
          [idNum]
        );
    if (withStock.rows?.[0]?.warehouse_id != null) {
      return Number(withStock.rows[0].warehouse_id);
    }
    const fromReserve = effectiveProfileId
      ? await query(
          `SELECT sm.warehouse_id
           FROM stock_movements sm
           INNER JOIN warehouses w ON w.id = sm.warehouse_id
           WHERE sm.product_id = $1
             AND sm.warehouse_id IS NOT NULL
             AND sm.type IN ('reserve', 'unreserve', 'shipment')
             AND w.profile_id = $2
           ORDER BY sm.id DESC
           LIMIT 1`,
          [idNum, effectiveProfileId]
        )
      : await query(
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
    return pref || (await this.productsRepository.resolveOwnWarehouseId(null, effectiveProfileId));
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
    const productProfileId = product.profile_id ?? product.profileId ?? null;
    const warehouseId = await this.productsRepository.resolveOwnWarehouseId(whRaw, productProfileId);
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

    const typeNormEarly = String(type || '').trim().toLowerCase();

    const currentWh = await this.productsRepository.getWarehouseFreeStock(idNum, warehouseId);
    const newWhRaw = currentWh + safeDelta;
    const typeNorm = String(type || '').trim().toLowerCase();
    const allowNegativeClamp =
      metaObj.allow_negative_clamp === true ||
      typeNorm === 'inventory' ||
      metaObj.kit_assembly_receipt === true ||
      metaObj.kit_assembly_receipt_reversal === true ||
      metaObj.kit_component_restore === true ||
      metaObj.stock_history_reset === true ||
      metaObj.receipt_reversal === true ||
      metaObj.deleted === true;

    if (newWhRaw < 0 && !allowNegativeClamp) {
      const error = new Error(
        `Недостаточно наличия на складе #${warehouseId}: есть ${currentWh}, ` +
          `изменение ${safeDelta > 0 ? '+' : ''}${safeDelta}`
      );
      error.statusCode = 409;
      throw error;
    }
    const newWh = Math.max(0, newWhRaw);

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

    metaOut.warehouse_balance_before = currentWh;
    metaOut.warehouse_balance_after = newWh;

    if (typeNormEarly === 'manual') {
      try {
        const { isKitProductId } = await import('./kitStock.service.js');
        if (await isKitProductId(idNum)) {
          metaOut.kit_manual = true;
        }
      } catch {
        /* ignore */
      }
    }

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
      if (typeNormEarly === 'manual') {
        try {
          const { recalculateKitsForComponent } = await import('./kitStock.service.js');
          await recalculateKitsForComponent(idNum, { warehouseId, profileId: profId });
        } catch {
          /* ignore */
        }
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
        getRawReservedQuantityFromMovementsWithClient,
        getReservedQuantityFromMovementsWithClient
      } = await import('./sellableQuantity.service.js');
      const orderDbIdNum = metaOut.order_id != null ? Number(metaOut.order_id) : NaN;
      const mpOrderId =
        metaOut.orderId != null && String(metaOut.orderId).trim() !== ''
          ? String(metaOut.orderId).trim()
          : null;
      let netForOrder = null;
      if ((Number.isFinite(orderDbIdNum) && orderDbIdNum >= 1) || mpOrderId) {
        const { getNetReservedForOrderProduct } = await import('./kitStock.service.js');
        const manualUnreserve =
          metaOut.manual_unreserve === true ||
          metaOut.manual_unreserve === 'true' ||
          metaOut.bulk_product_release === true;
        const whFromMeta = parseStockMovementWarehouseId(
          metaOut.warehouse_id ?? metaOut.warehouseId
        );
        // Ручное снятие по складу: лимит netForOrder только на этом складе (не глобальный ноль).
        const whCap = manualUnreserve ? (whFromMeta ?? null) : whFromMeta;
        netForOrder = await getNetReservedForOrderProduct(
          Number.isFinite(orderDbIdNum) && orderDbIdNum >= 1 ? orderDbIdNum : 0,
          idNum,
          mpOrderId,
          whCap
        );
      }
      const fboItemIdRaw = metaOut.fbo_supply_item_id;
      if (
        netForOrder == null &&
        fboItemIdRaw != null &&
        String(fboItemIdRaw).trim() !== ''
      ) {
        const fboWh = parseStockMovementWarehouseId(metaOut.warehouse_id ?? metaOut.warehouseId);
        const fboParams = [idNum, String(fboItemIdRaw).trim()];
        let fboWhSql = '';
        if (fboWh != null) {
          fboWhSql = ' AND warehouse_id = $3';
          fboParams.push(fboWh);
        }
        const fboR = await client.query(
          `SELECT GREATEST(0, COALESCE(SUM(${NET_RESERVED_MOVEMENT_ROW_CASE_SQL}), 0))::int AS net
           FROM stock_movements
           WHERE product_id = $1 AND meta->>'fbo_supply_item_id' = $2${fboWhSql}`,
          fboParams
        );
        netForOrder = Number(fboR.rows?.[0]?.net ?? 0) || 0;
      }

      const journalReconcile =
        metaOut.journal_reconcile === true || metaOut.journal_reconcile === 'true';
      const strictWh =
        metaOut.strict_warehouse === true ||
        metaOut.strictWarehouse === true ||
        metaOut.fbs_strict_warehouse === true;
      const snapshotOpts = warehouseId != null ? { warehouseId } : {};

      if (type === 'reserve' && safeDelta < 0) {
        const reserveAdd = Math.floor(Math.abs(safeDelta));
        if (reserveAdd < 1) {
          const err = new Error('Нулевой или некорректный объём резерва');
          err.statusCode = 400;
          throw err;
        }
        const supply = await getProductSupplySnapshotWithClient(client, idNum, snapshotOpts);
        const warehouseScopedReserve = snapshotOpts.warehouseId != null;
        const reservedBefore = warehouseScopedReserve ? supply.reserved : supply.reservedRaw;
        const journalBeforeRaw = supply.reservedRaw;
        if (!journalReconcile) {
          const availableForReserve = Math.max(0, Math.floor(supply.available));
          if (availableForReserve <= 0) {
            const whHint =
              warehouseId != null ? ` (склад #${warehouseId})` : '';
            const err = new Error(
              `Недостаточно остатка для резерва${whHint}: на складе ${supply.onHand}, в пути ${supply.incoming}, ` +
                `уже зарезервировано ${reservedBefore} (доступно без поставщиков: 0)`
            );
            err.statusCode = 400;
            throw err;
          }
          if (reserveAdd > availableForReserve) {
            const whHint =
              warehouseId != null ? ` (склад #${warehouseId})` : '';
            const err = new Error(
              `Недостаточно остатка для резерва${whHint}: на складе ${supply.onHand}, в пути ${supply.incoming}, ` +
                `уже зарезервировано ${reservedBefore}, запрошено ${reserveAdd} ` +
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
        const manualOrphan =
          metaOut.manual_unreserve === true ||
          metaOut.manual_unreserve === 'true' ||
          metaOut.orphan_cleanup === true ||
          metaOut.direct_orphan_release === true;
        const whCap = parseStockMovementWarehouseId(metaOut.warehouse_id ?? metaOut.warehouseId);
        let journalBeforeRaw;
        if (manualOrphan && whCap != null) {
          journalBeforeRaw = await getReservedQuantityFromMovementsWithClient(client, idNum, {
            warehouseId: whCap
          });
        } else {
          journalBeforeRaw = await getRawReservedQuantityFromMovementsWithClient(client, idNum);
        }
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
        await this._ensureUnreserveReserveFromMeta(metaOut, {
          productId: idNum,
          releaseQty: release,
          netReserved: netForOrder,
          warehouseId: whCap ?? warehouseId,
          orderDbId: Number.isFinite(orderDbIdNum) && orderDbIdNum >= 1 ? orderDbIdNum : null,
          orderIdLabel: mpOrderId,
        });
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
        const snapAfter = await getProductSupplySnapshotWithClient(client, idNum, snapshotOpts);
        const warehouseScopedReserve =
          snapshotOpts.warehouseId != null &&
          String(snapshotOpts.warehouseId).trim() !== '';
        const reservedCheck = warehouseScopedReserve ? snapAfter.reserved : snapAfter.reservedRaw;
        if (reservedCheck > snapAfter.supplyCap) {
          const err = new Error(
            `Резерв превышает наличие и «в пути»: зарезервировано ${reservedCheck}, ` +
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

    // Снимок резерва на заказе — для быстрого списка без пересчёта журнала.
    if (Number.isFinite(orderDbIdNum) && orderDbIdNum >= 1) {
      try {
        const ordersService = (await import('./orders.service.js')).default;
        if (typeof ordersService.refreshOrderReserveSnapshot === 'function') {
          await ordersService.refreshOrderReserveSnapshot(orderDbIdNum);
        }
      } catch {
        /* ignore — список подтянется при следующем бэкфилле/резерве */
      }
    }

    // После reserve не вызываем trimExcessReservesForProduct: перерезерв нужно отклонять,
    // а не снимать резерв у других заказов (trim остаётся только на приёмку/отгрузку и т.п.).

    const productAfter = await this.productsRepository.findById(idNum);
    const totalAfter = productAfter?.quantity != null ? Number(productAfter.quantity) : 0;

    const skipMpSync =
      metaOut.skip_marketplace_sync === true ||
      metaOut.skip_marketplace_sync === 'true' ||
      metaOut.fbo_bulk_rebalance === true;
    if (!skipMpSync) {
      scheduleStockMovementMarketplaceSync(idNum, {
        source: `stock_movement:${type}`,
        warehouseId,
        organizationId: orgId
      });
    }

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
   * Если caller не передал reserve_from_*, проставляем списание meta пропорционально
   * текущему резерву заказа (иначе unreserve оставляет фантомный meta_incoming).
   */
  async _ensureUnreserveReserveFromMeta(
    metaOut,
    { productId, releaseQty, netReserved = null, warehouseId = null, orderDbId = null, orderIdLabel = null } = {}
  ) {
    if (!metaOut || typeof metaOut !== 'object') return;
    const hasExplicit =
      metaOut.reserve_from_on_hand != null || metaOut.reserve_from_incoming != null;
    if (hasExplicit) return;

    const release = Math.max(0, Math.floor(Number(releaseQty) || 0));
    if (release < 1) return;

    const oid = Number(orderDbId);
    const hasOrder = (Number.isFinite(oid) && oid >= 1) ||
      (orderIdLabel != null && String(orderIdLabel).trim() !== '');
    if (!hasOrder) {
      // Нет привязки к заказу — списываем как on_hand (не оставляем фантом incoming).
      metaOut.reserve_from_on_hand = release;
      metaOut.reserve_from_incoming = 0;
      return;
    }

    try {
      const { queryOrderProductReserveMetaMap, allocateUnreserveReserveFromMeta } = await import(
        './orders.service.js'
      );
      const orderIds = Number.isFinite(oid) && oid >= 1 ? [oid] : [];
      // Без numeric order_id meta map не строится — fallback ниже.
      let fromOnHand = 0;
      let fromIncoming = 0;
      if (orderIds.length) {
        const metaMap = await queryOrderProductReserveMetaMap(productId, orderIds, {
          warehouseId,
        });
        const cur = metaMap.get(oid) || { fromOnHand: 0, fromIncoming: 0 };
        fromOnHand = cur.fromOnHand;
        fromIncoming = cur.fromIncoming;
      }
      const alloc = allocateUnreserveReserveFromMeta(
        release,
        { fromOnHand, fromIncoming },
        netReserved
      );
      // Если meta в журнале пустая (старые reserve без тегов) — не раздуваем incoming.
      if (fromOnHand + fromIncoming < 1) {
        metaOut.reserve_from_on_hand = release;
        metaOut.reserve_from_incoming = 0;
      } else {
        metaOut.reserve_from_on_hand = alloc.reserve_from_on_hand;
        metaOut.reserve_from_incoming = alloc.reserve_from_incoming;
      }
    } catch {
      metaOut.reserve_from_on_hand = release;
      metaOut.reserve_from_incoming = 0;
    }
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

    let whFilter = null;
    if (warehouseId != null && String(warehouseId).trim() !== '') {
      whFilter = await this.productsRepository.resolveOwnWarehouseId(warehouseId, profileId);
    }

    const rows = await this.repository.findByProduct(productId, {
      limit: cap,
      profileId,
      warehouseId: whFilter
    });

    const { isKitProductId, isKitStockHistoryMovementType } = await import('./kitStock.service.js');
    const { getReservedQuantityFromMovements } = await import('./sellableQuantity.service.js');
    const isKit = await isKitProductId(idNum);

    let netReserved;
    if (whFilter != null) {
      netReserved = await getReservedQuantityFromMovements(idNum, { warehouseId: whFilter });
    } else {
      netReserved = await getReservedQuantityFromMovements(idNum);
    }

    if (!isKit) {
      return { movements: rows, netReserved };
    }

    const movements = rows.filter((m) => isKitStockHistoryMovementType(m?.type));
    return { movements: movements.slice(0, cap), netReserved };
  }

  /**
   * Реестр ручных списаний (type = writeoff).
   */
  async listWriteoffs({
    limit = 200,
    offset = 0,
    profileId = null,
    organizationId = null,
    warehouseId = null,
  } = {}) {
    let whFilter = null;
    if (warehouseId != null && String(warehouseId).trim() !== '') {
      whFilter = await this.productsRepository.resolveOwnWarehouseId(warehouseId, profileId);
    }
    const rows = await this.repository.findWriteoffs({
      limit,
      offset,
      profileId,
      organizationId,
      warehouseId: whFilter,
    });
    return rows.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      quantity: Math.abs(Number(row.quantity_change) || 0),
      reason: row.reason || null,
      warehouseId: row.warehouse_id,
      warehouseName: row.warehouse_name || null,
      organizationId: row.organization_id ?? null,
      organizationName: row.organization_name || null,
      productId: row.product_id,
      productSku: row.product_sku || null,
      productName: row.product_name || null,
      meta: row.meta ?? null,
    }));
  }

  /**
   * Заказы, под которые сейчас числится ненулевой резерв товара (по журналу reserve/unreserve).
   * Формула нетто-резерва совпадает с products.repository / kitStock (unreserve уменьшает резерв).
   * Для комплектов reservedQty — комплектов под заказ (validation: SKU + комплектующие без двойного счёта).
   */
  async resolveWarehouseFilter(warehouseId, profileId = null) {
    if (warehouseId == null || String(warehouseId).trim() === '') return null;
    return this.productsRepository.resolveOwnWarehouseId(warehouseId, profileId);
  }

  _movementWarehouseSql(warehouseId, params) {
    const whId = parseStockMovementWarehouseId(warehouseId);
    if (whId == null) return '';
    params.push(whId);
    return stockMovementWarehouseStrictSql('', whId, params.length);
  }

  /**
   * Снятия резерва без order_id уменьшают нетто в журнале, но не движения заказов.
   * Для модалки выравниваем qty по заказам с journalNet (сначала более новые заказы в списке).
   */
  async _reconcileOrderReserveListWithJournal(out, productId, { warehouseId = null, isKit = false } = {}) {
    if (!Array.isArray(out) || out.length === 0) return out;
    const idNum = typeof productId === 'string' ? parseInt(productId, 10) : Number(productId);
    if (!idNum || Number.isNaN(idNum) || idNum < 1) return out;

    const whFilterId = parseStockMovementWarehouseId(warehouseId);
    const movementOpts = whFilterId != null ? { warehouseId: whFilterId } : {};
    const { readKitSkuNetReserved } = await import('./kitStock.service.js');
    const { getReservedQuantityFromMovements } = await import('./sellableQuantity.service.js');
    const journalNet = isKit
      ? await readKitSkuNetReserved(idNum, movementOpts)
      : await getReservedQuantityFromMovements(idNum, movementOpts);

    let excess = out.reduce((s, o) => s + (Number(o.reservedQty) || 0), 0) - journalNet;
    if (excess <= 0) return out;

    for (let i = 0; i < out.length && excess > 0; i++) {
      const cur = Math.max(0, Number(out[i].reservedQty) || 0);
      if (cur <= 0) continue;
      const drop = Math.min(cur, excess);
      out[i].reservedQty = cur - drop;
      excess -= drop;
    }
    return out.filter((o) => (Number(o.reservedQty) || 0) > 0);
  }

  /**
   * Источник резерва по meta движений (с наличия / в пути / смешанный).
   */
  async _enrichReservedOrdersWithSource(out, productId, { warehouseId = null, isKit = false } = {}) {
    if (!Array.isArray(out) || out.length === 0) return out;

    const idNum = typeof productId === 'string' ? parseInt(productId, 10) : Number(productId);
    if (!idNum || Number.isNaN(idNum) || idNum < 1) return out;

    const { queryOrderProductReserveMetaMap, scaleReserveMetaToDisplayQty } = await import(
      './orders.service.js'
    );

    const manualGroupIdsByDisplayOrder = new Map();
    const manualDisplayIds = out
      .filter((o) => o.marketplace === 'manual' && Number(o.orderDbId) > 0)
      .map((o) => Number(o.orderDbId));

    if (isKit && manualDisplayIds.length) {
      const gr = await query(
        `SELECT o1.id AS display_id, o2.id AS sibling_id
         FROM orders o1
         JOIN orders o2 ON o2.marketplace = 'manual'
           AND o2.order_group_id IS NOT NULL
           AND TRIM(o2.order_group_id) <> ''
           AND o2.order_group_id = o1.order_group_id
           AND o2.product_id = $1
         WHERE o1.id = ANY($2::bigint[])`,
        [idNum, manualDisplayIds]
      );
      for (const row of gr.rows || []) {
        const displayId = Number(row.display_id);
        const siblingId = Number(row.sibling_id);
        if (!Number.isFinite(displayId) || displayId < 1 || !Number.isFinite(siblingId) || siblingId < 1) {
          continue;
        }
        if (!manualGroupIdsByDisplayOrder.has(displayId)) {
          manualGroupIdsByDisplayOrder.set(displayId, new Set());
        }
        manualGroupIdsByDisplayOrder.get(displayId).add(siblingId);
      }
    }

    const allOrderDbIds = new Set();
    for (const o of out) {
      const oid = Number(o.orderDbId);
      if (!Number.isFinite(oid) || oid < 1) continue;
      const groupSet = manualGroupIdsByDisplayOrder.get(oid);
      if (groupSet?.size) {
        for (const id of groupSet) allOrderDbIds.add(id);
      } else {
        allOrderDbIds.add(oid);
      }
    }

    const metaMap = await queryOrderProductReserveMetaMap(idNum, [...allOrderDbIds], { warehouseId });

    return out.map((o) => {
      const qty = Math.max(0, Number(o.reservedQty) || 0);
      const oid = Number(o.orderDbId);
      let fromOnHand = 0;
      let fromIncoming = 0;

      if (Number.isFinite(oid) && oid > 0) {
        const groupSet = manualGroupIdsByDisplayOrder.get(oid);
        if (groupSet?.size) {
          for (const id of groupSet) {
            const m = metaMap.get(id);
            if (m) {
              fromOnHand += m.fromOnHand;
              fromIncoming += m.fromIncoming;
            }
          }
        } else {
          const m = metaMap.get(oid);
          if (m) {
            fromOnHand = m.fromOnHand;
            fromIncoming = m.fromIncoming;
          }
        }
      }

      const scaled = scaleReserveMetaToDisplayQty({ fromOnHand, fromIncoming }, qty);
      return {
        ...o,
        reserveFromOnHand: scaled.fromOnHand,
        reserveFromIncoming: scaled.fromIncoming,
        reserveSource: scaled.reserveSource
      };
    });
  }

  async listReservedOrdersForProduct(
    productId,
    { profileId = null, warehouseId = null, _skipStaleCleanup = false, _skipShipmentReconcile = false } = {}
  ) {
    const idNum = typeof productId === 'string' ? parseInt(productId, 10) : Number(productId);
    if (!idNum || Number.isNaN(idNum) || idNum < 1) return [];

    if (!_skipShipmentReconcile) {
      try {
        const { default: ordersService } = await import('./orders.service.js');
        await ordersService.reconcileMissingShipmentStockForProduct(idNum, { profileId });
      } catch (_) {
        /* не блокируем список резерва */
      }
    }

    // Дубль «целый комплект + комплектующие» сверх qty заказа — снять при открытии модалки.
    if (!_skipStaleCleanup) {
      try {
        await this._reconcileKitReserveForProductModal(idNum);
      } catch (_) {
        /* не блокируем список резерва */
      }
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
      if (own != null && String(own) !== String(tid)) return [];
    }

    const {
      isKitProductId,
      getKitComponents,
      getReservedKitUnitsForManualOrderGroup,
      getReservedKitUnitsForOrderValidation,
      reconcileExcessKitWholeReserveForOrder
    } = await import('./kitStock.service.js');
    const isKit = await isKitProductId(idNum);

    const whFilterId = parseStockMovementWarehouseId(warehouseId);
    const kitUnreserveFn = (pid, net, oid, m) =>
      this.applyChange(pid, {
        delta: net,
        type: 'unreserve',
        reason: `Снятие лишнего резерва целых комплектов на SKU (заказ ${oid})`.trim(),
        meta: m
      });

    const movementScopeSql = isKit
      ? `product_id = $1
           OR product_id IN (
             SELECT component_product_id FROM kit_components WHERE kit_product_id = $1
           )`
      : `product_id = $1`;

    const params = [idNum];
    let whSql = '';
    if (whFilterId != null) {
      params.push(whFilterId);
      whSql = ` AND warehouse_id = $${params.length}`;
    }

    const metaKeySql = stockMovementMetaOrderKeySql('');
    const orderLateralSql = `LEFT JOIN LATERAL (
         SELECT o.id, o.marketplace, o.order_id, o.status, o.created_at
         FROM orders o
         WHERE (order_keys.meta_key ~ '^[0-9]+$' AND o.id = order_keys.meta_key::bigint)
            OR (
              o.order_id IS NOT NULL
              AND TRIM(o.order_id) = TRIM(order_keys.meta_key)
            )
         ORDER BY CASE WHEN order_keys.meta_key ~ '^[0-9]+$' AND o.id = order_keys.meta_key::bigint THEN 0 ELSE 1 END,
                  o.id DESC
         LIMIT 1
       ) o ON true`;

    const res = isKit
      ? await query(
          `WITH order_keys AS (
             SELECT DISTINCT ${metaKeySql} AS meta_key
             FROM stock_movements
             WHERE (${movementScopeSql})
               AND type IN ('reserve', 'unreserve')
               AND ${metaKeySql} IS NOT NULL
               AND TRIM(${metaKeySql}) <> ''${whSql}
           ),
           sku_net AS (
             SELECT ${metaKeySql} AS meta_key,
               ${NET_RESERVED_SUM_EXPR_SQL}::int AS sku_net_qty
             FROM stock_movements
             WHERE product_id = $1
               AND type IN ('reserve', 'unreserve')
               AND ${metaKeySql} IS NOT NULL
               AND TRIM(${metaKeySql}) <> ''${whSql}
             GROUP BY 1
             HAVING ${NET_RESERVED_SUM_EXPR_SQL} > 0
           )
           SELECT o.id,
                  o.marketplace,
                  o.order_id,
                  o.status,
                  COALESCE(sku_net.sku_net_qty, 0) AS sku_net_qty,
                  (o.id IS NULL) AS order_missing,
                  CASE
                    WHEN order_keys.meta_key ~ '^[0-9]+$' THEN order_keys.meta_key::bigint
                    ELSE NULL
                  END AS movement_order_db_id
           FROM order_keys
           LEFT JOIN sku_net ON sku_net.meta_key = order_keys.meta_key
           ${orderLateralSql}
           ORDER BY o.created_at DESC NULLS LAST, order_keys.meta_key DESC
           LIMIT 200`,
          params
        )
      : await query(
          `WITH order_keys AS (
             SELECT DISTINCT ${metaKeySql} AS meta_key
             FROM stock_movements
             WHERE (${movementScopeSql})
               AND type IN ('reserve', 'unreserve')
               AND ${metaKeySql} IS NOT NULL
               AND TRIM(${metaKeySql}) <> ''${whSql}
           ),
           sku_net AS (
             SELECT ${metaKeySql} AS meta_key,
               ${NET_RESERVED_SUM_EXPR_SQL}::int AS sku_net_qty
             FROM stock_movements
             WHERE product_id = $1
               AND type IN ('reserve', 'unreserve')
               AND ${metaKeySql} IS NOT NULL
               AND TRIM(${metaKeySql}) <> ''${whSql}
             GROUP BY 1
             HAVING ${NET_RESERVED_SUM_EXPR_SQL} > 0
           )
           SELECT o.id,
                  o.marketplace,
                  o.order_id,
                  o.status,
                  COALESCE(sku_net.sku_net_qty, 0) AS sku_net_qty,
                  (o.id IS NULL) AS order_missing,
                  CASE
                    WHEN order_keys.meta_key ~ '^[0-9]+$' THEN order_keys.meta_key::bigint
                    ELSE NULL
                  END AS movement_order_db_id
           FROM order_keys
           INNER JOIN sku_net ON sku_net.meta_key = order_keys.meta_key
           ${orderLateralSql}
           ORDER BY o.created_at DESC NULLS LAST, order_keys.meta_key DESC
           LIMIT 200`,
          params
        );

    if (!_skipStaleCleanup && (res.rows?.length ?? 0) > 0) {
      const { default: ordersService, isOrderTerminalNoReserve } = await import('./orders.service.js');
      let cleaned = false;
      for (const r of res.rows || []) {
        if (r.order_missing === true) {
          const movementOrderDbId = Number(r.movement_order_db_id);
          if (Number.isFinite(movementOrderDbId) && movementOrderDbId > 0) {
            try {
              await ordersService.releaseReserveForOrderDbIdFromJournal(movementOrderDbId, {
                reasonSuffix: 'заказ удалён',
                orderIdLabel: String(movementOrderDbId),
                reallocate: true
              });
              cleaned = true;
            } catch (_) {
              /* stale cleanup — не блокируем список */
            }
          }
          continue;
        }
        const status = String(r.status ?? '').trim().toLowerCase();
        let shouldClear = isOrderTerminalNoReserve(r.status);
        if (!shouldClear && status === 'assembled' && Number.isFinite(Number(r.id)) && Number(r.id) > 0) {
          const or = await query(
            `SELECT id, quantity, product_id, marketplace, order_id, status FROM orders WHERE id = $1 LIMIT 1`,
            [r.id]
          );
          const orderRow = or.rows?.[0];
          if (orderRow) {
            shouldClear = await ordersService.isOrderFullyShipped(orderRow);
          }
        }
        if (!shouldClear) continue;
        try {
          await this.releaseAllStaleReserveForOrder(r.id, r.order_id, { profileId });
        } catch (_) {
          /* stale cleanup — не блокируем список */
        }
        cleaned = true;
      }
      if (cleaned) {
        return this.listReservedOrdersForProduct(productId, {
          profileId,
          warehouseId,
          _skipStaleCleanup: true,
          _skipShipmentReconcile: true
        });
      }
    }

    const { isOrderTerminalNoReserve } = await import('./orders.service.js');
    const { getOrderStatusLabel } = await import('../constants/orderStatuses.js');

    if (isKit && whFilterId != null) {
      const seenReconcile = new Set();
      for (const r of res.rows || []) {
        if (r.order_missing === true) continue;
        const orderDbId = Number(r.id);
        if (!Number.isFinite(orderDbId) || orderDbId < 1 || seenReconcile.has(orderDbId)) continue;
        seenReconcile.add(orderDbId);
        try {
          await reconcileExcessKitWholeReserveForOrder(
            idNum,
            orderDbId,
            r.order_id != null ? String(r.order_id).trim() : String(orderDbId),
            {
              warehouse_id: whFilterId,
              order_id: orderDbId,
              orderId: r.order_id
            },
            kitUnreserveFn
          );
        } catch (_) {
          /* не блокируем список */
        }
      }
    }

    const out = [];
    const seenManualKitGroups = new Set();
    const seenKitOrderDbIds = new Set();
    for (const r of res.rows || []) {
      const movementOrderDbId = Number(r.movement_order_db_id);
      const orderDbId = Number(r.id);
      const orderMissing = r.order_missing === true;

      if (orderMissing) {
        let reservedQty = Number(r.sku_net_qty) || 0;
        if (isKit && Number.isFinite(movementOrderDbId) && movementOrderDbId > 0) {
          const kitUnits = await getReservedKitUnitsForOrderValidation(idNum, movementOrderDbId, {
            warehouseId: whFilterId
          });
          if (kitUnits > 0) reservedQty = kitUnits;
        }
        if (reservedQty <= 0) continue;
        const deletedStatus = 'заказ удалён';
        out.push({
          orderDbId: Number.isFinite(movementOrderDbId) ? movementOrderDbId : null,
          marketplace: 'ozon',
          orderId: `удалён #${movementOrderDbId}`,
          status: deletedStatus,
          statusLabel: deletedStatus,
          reservedQty,
          staleReserve: true,
          deletedOrderReserve: true
        });
        continue;
      }

      if (!Number.isFinite(orderDbId) || orderDbId < 1) continue;
      if (isKit && seenKitOrderDbIds.has(orderDbId)) continue;

      const ordRow = await query(
        `SELECT product_id, marketplace, order_group_id, order_id FROM orders WHERE id = $1 LIMIT 1`,
        [orderDbId]
      );
      const rowProductId = Number(ordRow.rows?.[0]?.product_id);
      const rowMp = String(ordRow.rows?.[0]?.marketplace || '').toLowerCase();
      const rowGroupId = String(ordRow.rows?.[0]?.order_group_id || '').trim();
      if (
        isKit &&
        rowMp === 'manual' &&
        Number.isFinite(rowProductId) &&
        rowProductId > 0 &&
        rowProductId !== idNum
      ) {
        const comps = await getKitComponents(idNum);
        const isLooseComponentLine = (comps || []).some(
          (c) => Number(c.component_product_id) === rowProductId
        );
        if (isLooseComponentLine) continue;
      }

      let reservedQty = Number(r.sku_net_qty) || 0;
      let displayOrderId = r.order_id;
      if (isKit) {
        if (rowMp === 'manual' && rowGroupId) {
          if (seenManualKitGroups.has(rowGroupId)) continue;
          seenManualKitGroups.add(rowGroupId);
          reservedQty = await getReservedKitUnitsForManualOrderGroup(idNum, rowGroupId, {
            profileId: tid,
            warehouseId: whFilterId
          });
          const kitLine = await query(
            `SELECT order_id FROM orders
             WHERE marketplace = 'manual' AND order_group_id = $1 AND product_id = $2
             ORDER BY id ASC LIMIT 1`,
            [rowGroupId, idNum]
          );
          if (kitLine.rows?.[0]?.order_id) {
            displayOrderId = kitLine.rows[0].order_id;
          }
        } else {
          reservedQty = await getReservedKitUnitsForOrderValidation(idNum, orderDbId, {
            warehouseId: whFilterId
          });
        }
      }
      if (reservedQty <= 0) continue;
      if (isKit) seenKitOrderDbIds.add(orderDbId);

      const status = r.status != null ? String(r.status) : '';
      const mpRaw = String(r.marketplace || '').toLowerCase();
      const marketplace =
        mpRaw === 'manual'
          ? 'manual'
          : mpRaw === 'wb'
            ? 'wildberries'
            : mpRaw === 'ym'
              ? 'yandex'
              : mpRaw === 'ozon'
                ? 'ozon'
                : mpRaw || 'ozon';
      out.push({
        orderDbId,
        marketplace,
        orderId: displayOrderId,
        status,
        statusLabel: getOrderStatusLabel(status),
        reservedQty,
        staleReserve: isOrderTerminalNoReserve(status),
        ...(isKit ? { kitSkuNetQty: Number(r.sku_net_qty) || 0 } : {})
      });
    }

    if (isKit) {
      const manualGroupParams = [idNum];
      let manualGroupProfileSql = '';
      if (tid != null && Number.isFinite(tid) && tid > 0) {
        manualGroupParams.push(tid);
        manualGroupProfileSql = `AND profile_id = $${manualGroupParams.length}`;
      }
      const manualGroupsRes = await query(
        `SELECT DISTINCT ON (order_group_id)
                order_group_id, id, order_id, status
         FROM orders
         WHERE marketplace = 'manual'
           AND product_id = $1
           AND order_group_id IS NOT NULL
           AND TRIM(order_group_id) <> ''
           ${manualGroupProfileSql}
         ORDER BY order_group_id, id ASC`,
        manualGroupParams
      );
      for (const gr of manualGroupsRes.rows || []) {
        const gid = String(gr.order_group_id || '').trim();
        if (!gid || seenManualKitGroups.has(gid)) continue;
        const reservedQty = await getReservedKitUnitsForManualOrderGroup(idNum, gid, {
          profileId: tid,
          warehouseId: whFilterId
        });
        if (reservedQty <= 0) continue;
        seenManualKitGroups.add(gid);
        const status = gr.status != null ? String(gr.status) : '';
        out.push({
          orderDbId: Number(gr.id),
          marketplace: 'manual',
          orderId: gr.order_id,
          status,
          statusLabel: getOrderStatusLabel(status),
          reservedQty,
          staleReserve: isOrderTerminalNoReserve(status)
        });
      }
    }

    const reconciled = isKit
      ? out
      : await this._reconcileOrderReserveListWithJournal(out, idNum, {
          warehouseId: whFilterId,
          isKit
        });
    return this._enrichReservedOrdersWithSource(reconciled, idNum, {
      warehouseId: whFilterId,
      isKit
    });
  }

  /**
   * Резерв под поставки FBO (meta.fbo_supply_item_id) — в колонке «Резерв» учитывается, в заказах не показывается.
   */
  async listFboReservedSuppliesForProduct(productId, { profileId = null, warehouseId = null } = {}) {
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

    const whId = parseStockMovementWarehouseId(warehouseId);
    const params = [idNum, tid];
    let whSql = '';
    if (whId != null) {
      params.push(whId);
      whSql = ` AND warehouse_id = $${params.length}`;
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
           AND (meta->>'fbo_supply_item_id') ~ '^[0-9]+$'${whSql}
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
      params
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
  async getReserveSummaryForProduct(
    productId,
    {
      profileId = null,
      warehouseId = null,
      ordersPreloaded = null,
      fboSuppliesPreloaded = null
    } = {}
  ) {
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

    const fboSupplies =
      fboSuppliesPreloaded != null
        ? fboSuppliesPreloaded
        : await this.listFboReservedSuppliesForProduct(idNum, { profileId, warehouseId });
    const fboReservedQty = fboSupplies.reduce((s, row) => s + (Number(row.reservedQty) || 0), 0);

    const orders =
      ordersPreloaded != null
        ? ordersPreloaded
        : await this.listReservedOrdersForProduct(idNum, {
            profileId,
            warehouseId,
            _skipShipmentReconcile: true,
            _skipStaleCleanup: true
          });
    const ordersReservedQty = orders.reduce((s, o) => s + (Number(o.reservedQty) || 0), 0);

    const { isKitProductId, readKitSkuNetReserved, getKitComponents } =
      await import('./kitStock.service.js');
    const { getReservedQuantityFromMovements } = await import('./sellableQuantity.service.js');

    const isKit = await isKitProductId(idNum);
    const movementOpts = {
      ...(warehouseId != null && parseStockMovementWarehouseId(warehouseId) != null
        ? { warehouseId: parseStockMovementWarehouseId(warehouseId) }
        : {}),
      ...(profileId != null && profileId !== '' ? { profileId } : {})
    };
    const displayReservedQty = isKit
      ? await readKitSkuNetReserved(idNum, movementOpts)
      : await getReservedQuantityFromMovements(idNum, movementOpts);

    let componentJournalReserve = 0;
    if (isKit) {
      const comps = await getKitComponents(idNum);
      for (const c of comps || []) {
        const cid = Number(c.component_product_id);
        if (!Number.isFinite(cid) || cid < 1) continue;
        componentJournalReserve += await getReservedQuantityFromMovements(cid, movementOpts);
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
  async _fboJournalNetForProduct(productId, { warehouseId = null } = {}) {
    const pid = Number(productId);
    if (!Number.isFinite(pid) || pid < 1) return 0;
    const params = [pid];
    const whSql = this._movementWarehouseSql(warehouseId, params);
    const r = await query(
      `SELECT GREATEST(0, COALESCE(SUM(${NET_RESERVED_MOVEMENT_ROW_CASE_SQL}), 0))::int AS rv
       FROM stock_movements
       WHERE product_id = $1
         AND type IN ('reserve', 'unreserve')
         AND meta->>'fbo_supply_item_id' IS NOT NULL
         AND (meta->>'fbo_supply_item_id') ~ '^[0-9]+$'${whSql}`,
      params
    );
    return Number(r.rows?.[0]?.rv ?? 0) || 0;
  }

  /** Нетто и сырое нетто резерва по product_id в журнале. */
  async _journalNetsForProduct(productId, { warehouseId = null } = {}) {
    const pid = Number(productId);
    if (!Number.isFinite(pid) || pid < 1) {
      return { journalNet: 0, rawNet: 0 };
    }
    const params = [pid];
    const whSql = this._movementWarehouseSql(warehouseId, params);
    const r = await query(
      `SELECT ${NET_RESERVED_SUM_EXPR_SQL}::int AS net,
              ${RAW_RESERVED_SUM_EXPR_SQL}::numeric AS raw
       FROM stock_movements
       WHERE product_id = $1 AND type IN ('reserve', 'unreserve')${whSql}`,
      params
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
    const metaKeySql = stockMovementMetaOrderKeySql('');
    const r = await query(
      `WITH nets AS (
         SELECT ${NET_RESERVED_SUM_EXPR_SQL}::int AS net_r
         FROM stock_movements
         WHERE product_id = $1
           AND type IN ('reserve', 'unreserve')
           AND ${metaKeySql} IS NOT NULL
           AND TRIM(${metaKeySql}) <> ''
         GROUP BY ${metaKeySql}
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
  async _reconcileJournalNetForProductId(
    productId,
    { profileId = null, sourceProductId = null, warehouseId = null } = {}
  ) {
    const pid = Number(productId);
    if (!Number.isFinite(pid) || pid < 1) {
      return { productId: pid, reserveAdded: 0, unreserveAdded: 0, skipped: true };
    }

    const { journalNet, rawNet } = await this._journalNetsForProduct(pid, { warehouseId });
    const ordersNet = await this._ordersJournalNetForProduct(pid);
    const fboNet = await this._fboJournalNetForProduct(pid, { warehouseId });
    const expectedNet = ordersNet + fboNet;
    const rawDrift = rawNet - expectedNet;

    if (rawDrift === 0) {
      return { productId: pid, reserveAdded: 0, unreserveAdded: 0, skipped: true, journalNet, rawNet, expectedNet };
    }

    const src = Number(sourceProductId) || pid;
    const whId = parseStockMovementWarehouseId(warehouseId);
    const reconcileMetaBase =
      whId != null
        ? { warehouse_id: whId, warehouseId: whId }
        : {};
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
          ...reconcileMetaBase,
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
        ...reconcileMetaBase,
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
  async reconcileJournalReserveForProduct(productId, { profileId = null, warehouseId = null } = {}) {
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
        sourceProductId: idNum,
        warehouseId
      });
      if (!row.skipped) {
        lines += 1;
        reserveAdded += row.reserveAdded || 0;
        unreserveAdded += row.unreserveAdded || 0;
      }
      details.push(row);
    }

    const { syncProductReservedQuantityFromJournal } = await import('./sellableQuantity.service.js');
    const { isKitProductId, readKitSkuNetReserved } = await import('./kitStock.service.js');
    try {
      if (await isKitProductId(idNum)) {
        const net = await readKitSkuNetReserved(idNum);
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
   * Прямое снятие лишнего нетто-резерва в журнале (если сверка rawNet не сработала).
   */
  async _directUnreserveExcessJournal(
    productId,
    { profileId = null, warehouseId = null, maxQty = null } = {}
  ) {
    const idNum = typeof productId === 'string' ? parseInt(productId, 10) : Number(productId);
    if (!idNum || Number.isNaN(idNum) || idNum < 1) {
      return { releasedProductLines: 0, releasedQty: 0, skipped: true };
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
        return { releasedProductLines: 0, releasedQty: 0, skipped: true };
      }
    }

    const whFilter =
      warehouseId != null && String(warehouseId).trim() !== ''
        ? await this.productsRepository.resolveOwnWarehouseId(warehouseId, tid ?? profileId)
        : null;
    const movementOpts =
      whFilter != null ? { warehouseId: whFilter } : {};

    const { getReservedQuantityFromMovements } = await import('./sellableQuantity.service.js');
    const {
      isKitProductId,
      getKitComponents,
      readKitSkuNetReserved,
      buildKitComponentQtyMap
    } = await import('./kitStock.service.js');

    const baseMeta = {
      manual_unreserve: true,
      orphan_cleanup: true,
      source_product_id: idNum,
      direct_orphan_release: true
    };
    if (whFilter != null) baseMeta.warehouse_id = whFilter;

    const reason = 'Снятие лишнего резерва без заказа и FBO';
    let releasedProductLines = 0;
    let releasedQty = 0;

    const isKit = await isKitProductId(idNum);
    if (isKit) {
      await this._reconcileKitReserveForProductModal(idNum).catch(() => {});
      const kitUnitsTarget =
        maxQty != null && Number.isFinite(Number(maxQty)) && Number(maxQty) > 0
          ? Math.floor(Number(maxQty))
          : await readKitSkuNetReserved(idNum, movementOpts);
      if (kitUnitsTarget >= 1) {
        const onSku = await readKitSkuNetReserved(idNum, movementOpts);
        if (onSku > 0) {
          const release = Math.min(onSku, kitUnitsTarget);
          await this.applyChange(idNum, {
            delta: release,
            type: 'unreserve',
            reason,
            meta: { ...baseMeta, kit_units: release }
          });
          releasedProductLines = 1;
          releasedQty = release;
        } else {
          const components = await getKitComponents(idNum);
          const qtyMap = buildKitComponentQtyMap(components, kitUnitsTarget);
          for (const [cid, needQty] of qtyMap.entries()) {
            const net = await getReservedQuantityFromMovements(cid, movementOpts);
            const release = Math.min(net, needQty);
            if (release < 1) continue;
            await this.applyChange(cid, {
              delta: release,
              type: 'unreserve',
              reason,
              meta: {
                ...baseMeta,
                kit_component_reserve: true,
                kit_product_id: idNum,
                kit_units: kitUnitsTarget
              }
            });
            releasedProductLines += 1;
          }
          if (releasedProductLines > 0) {
            releasedQty = kitUnitsTarget;
          }
        }
      }
    } else {
      const productIds = await this._productIdsForReserveRelease(idNum);
      let remaining =
        maxQty != null && Number.isFinite(Number(maxQty)) ? Math.floor(Number(maxQty)) : Infinity;

      for (const pid of productIds) {
        const net = await getReservedQuantityFromMovements(pid, movementOpts);
        if (net <= 0) continue;
        const release = remaining === Infinity ? net : Math.min(net, remaining);
        if (release < 1) continue;

        await this.applyChange(pid, {
          delta: release,
          type: 'unreserve',
          reason,
          meta: { ...baseMeta }
        });
        releasedProductLines += 1;
        releasedQty += release;
        if (remaining !== Infinity) {
          remaining -= release;
          if (remaining <= 0) break;
        }
      }
    }

    const { syncProductReservedQuantityFromJournal } = await import('./sellableQuantity.service.js');
    try {
      if (isKit) {
        const net = await readKitSkuNetReserved(idNum, movementOpts);
        await syncProductReservedQuantityFromJournal(idNum, { reserved: net });
      } else {
        await syncProductReservedQuantityFromJournal(idNum);
      }
    } catch {
      /* ignore */
    }

    return {
      releasedProductLines,
      releasedQty,
      skipped: releasedProductLines === 0
    };
  }

  /**
   * Снять резерв в журнале без заказа и без FBO (рассинхрон / удалённая запись).
   */
  async releaseUnattributedJournalReserve(
    productId,
    { profileId = null, warehouseId = null, allowDeficitFix = false } = {}
  ) {
    const idNum = typeof productId === 'string' ? parseInt(productId, 10) : Number(productId);
    if (!idNum || Number.isNaN(idNum) || idNum < 1) {
      const error = new Error('Некорректный ID товара');
      error.statusCode = 400;
      throw error;
    }

    const whFilter =
      warehouseId != null && String(warehouseId).trim() !== ''
        ? await this.productsRepository.resolveOwnWarehouseId(warehouseId, profileId)
        : null;

    const { isKitProductId } = await import('./kitStock.service.js');
    if (await isKitProductId(idNum)) {
      await this._reconcileKitReserveForProductModal(idNum).catch(() => {});
    }

    const summary = await this.getReserveSummaryForProduct(idNum, { profileId, warehouseId: whFilter });
    const orphanQty = Math.floor(Number(summary.orphanJournalReserve) || 0);
    if (orphanQty <= 0) {
      const deficit = Math.floor(Number(summary.journalDeficit) || 0);
      if (deficit > 0 && allowDeficitFix) {
        const recon = await this.reconcileJournalReserveForProduct(idNum, { profileId, warehouseId: whFilter });
        return {
          releasedProductLines: recon.lines,
          releasedQty: recon.unreserveAdded,
          reserveAdded: recon.reserveAdded,
          skipped: recon.lines === 0
        };
      }
      return { releasedProductLines: 0, releasedQty: 0, skipped: true };
    }

    const recon = await this.reconcileJournalReserveForProduct(idNum, { profileId, warehouseId: whFilter });
    if (recon.lines > 0) {
      return {
        releasedProductLines: recon.lines,
        releasedQty: recon.unreserveAdded,
        reserveAdded: recon.reserveAdded,
        skipped: false
      };
    }

    const direct = await this._directUnreserveExcessJournal(idNum, {
      profileId,
      warehouseId: whFilter,
      maxQty: orphanQty
    });
    return {
      releasedProductLines: direct.releasedProductLines,
      releasedQty: direct.releasedQty,
      skipped: direct.skipped
    };
  }

  /**
   * Снять весь нетто-резерв, если нет ни заказов, ни FBO (ручная очистка со страницы остатков).
   */
  async releaseOrphanNetReserveForProduct(productId, { profileId = null, warehouseId = null } = {}) {
    const idNum = typeof productId === 'string' ? parseInt(productId, 10) : Number(productId);
    if (!idNum || Number.isNaN(idNum) || idNum < 1) {
      const error = new Error('Некорректный ID товара');
      error.statusCode = 400;
      throw error;
    }

    const whFilter =
      warehouseId != null && String(warehouseId).trim() !== ''
        ? await this.productsRepository.resolveOwnWarehouseId(warehouseId, profileId)
        : null;

    const summary = await this.getReserveSummaryForProduct(idNum, {
      profileId,
      warehouseId: whFilter
    });
    if (Number(summary.orphanJournalReserve) > 0) {
      return this.releaseUnattributedJournalReserve(idNum, { profileId, warehouseId: whFilter });
    }

    const orders = await this.listReservedOrdersForProduct(idNum, {
      profileId,
      warehouseId: whFilter,
      _skipStaleCleanup: true
    });
    const fbo = await this.listFboReservedSuppliesForProduct(idNum, {
      profileId,
      warehouseId: whFilter
    });
    if (orders.length > 0 || fbo.length > 0) {
      return { releasedProductLines: 0, skipped: true };
    }

    const movementOpts = whFilter != null ? { warehouseId: whFilter } : {};
    const { getReservedQuantityFromMovements } = await import('./sellableQuantity.service.js');
    const productIds = await this._productIdsForReserveRelease(idNum);
    let releasedProductLines = 0;
    let releasedQty = 0;

    for (const pid of productIds) {
      const net = await getReservedQuantityFromMovements(pid, movementOpts);
      if (net <= 0) continue;
      const meta = { manual_unreserve: true, orphan_cleanup: true, source_product_id: idNum };
      if (whFilter != null) meta.warehouse_id = whFilter;
      await this.applyChange(pid, {
        delta: net,
        type: 'unreserve',
        reason: 'Снятие резерва без активного заказа',
        meta
      });
      releasedProductLines += 1;
      releasedQty += net;
    }

    return { releasedProductLines, releasedQty, skipped: releasedProductLines === 0 };
  }

  async _netReservedForOrderProduct(orderDbId, productId, { marketplaceOrderId = null } = {}) {
    const oid = Number(orderDbId);
    const pid = Number(productId);
    const mpLabel =
      marketplaceOrderId != null && String(marketplaceOrderId).trim() !== ''
        ? String(marketplaceOrderId).trim()
        : null;
    if (!Number.isFinite(pid) || pid < 1) return 0;
    if ((!Number.isFinite(oid) || oid < 1) && !mpLabel) return 0;
    const r = await query(
      `SELECT ${NET_RESERVED_SUM_EXPR_SQL}::int AS rv
       FROM stock_movements
       WHERE product_id = $1
         AND type IN ('reserve', 'unreserve')
         AND ${orderReserveMovementMatchSql('', 2, 3)}`,
      [pid, Number.isFinite(oid) && oid >= 1 ? oid : 0, mpLabel]
    );
    return Number(r.rows?.[0]?.rv ?? 0) || 0;
  }

  /**
   * Порции резерва под заказ для снятия: сначала глобальный нетто, иначе — остатки по складам
   * (когда reserve на одном складе, а unreserve при инвентаризации — на другом).
   */
  async _orderReserveReleaseChunks(orderDbId, productId, { marketplaceOrderId = null } = {}) {
    const oid = Number(orderDbId);
    const pid = Number(productId);
    const mpLabel =
      marketplaceOrderId != null && String(marketplaceOrderId).trim() !== ''
        ? String(marketplaceOrderId).trim()
        : null;
    if (!Number.isFinite(pid) || pid < 1) return [];
    if ((!Number.isFinite(oid) || oid < 1) && !mpLabel) return [];

    const globalNet = await this._netReservedForOrderProduct(oid, pid, { marketplaceOrderId: mpLabel });
    if (globalNet > 0) {
      return [{ productId: pid, warehouseId: null, net: globalNet }];
    }

    const r = await query(
      `SELECT warehouse_id,
              ${NET_RESERVED_SUM_EXPR_SQL}::int AS rv
       FROM stock_movements
       WHERE product_id = $1
         AND type IN ('reserve', 'unreserve')
         AND ${orderReserveMovementMatchSql('', 2, 3)}
       GROUP BY warehouse_id
       HAVING ${NET_RESERVED_SUM_EXPR_SQL} > 0`,
      [pid, Number.isFinite(oid) && oid >= 1 ? oid : 0, mpLabel]
    );
    return (r.rows || [])
      .map((row) => ({
        productId: pid,
        warehouseId: row.warehouse_id != null ? Number(row.warehouse_id) : null,
        net: Number(row.rv) || 0
      }))
      .filter((chunk) => chunk.net > 0);
  }

  async _applyOrderReserveReleaseChunks(chunks, { orderDbId, label, sourceProductId, reasonPrefix, extraMeta = {} }) {
    let releasedProductLines = 0;
    for (const chunk of chunks || []) {
      const meta = {
        order_id: orderDbId,
        orderId: label,
        manual_unreserve: true,
        skip_auto_reserve: true,
        source_product_id: sourceProductId,
        ...extraMeta
      };
      if (chunk.warehouseId != null && Number.isFinite(chunk.warehouseId) && chunk.warehouseId > 0) {
        meta.warehouse_id = chunk.warehouseId;
        meta.warehouse_split_cleanup = true;
      }
      await this.applyChange(chunk.productId, {
        delta: chunk.net,
        type: 'unreserve',
        reason: `${reasonPrefix} ${label}`.trim(),
        meta
      });
      releasedProductLines += 1;
    }
    return releasedProductLines;
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

  /** Согласование резерва комплекта перед модалкой / ручным снятием. */
  async _reconcileKitReserveForProductModal(productId) {
    const { reconcileAllMixedKitReservesForProduct } = await import('./kitStock.service.js');
    return reconcileAllMixedKitReservesForProduct(productId, {
      unreserveProduct: (unreservePid, net, orderLabel, m) =>
        this.applyChange(unreservePid, {
          delta: net,
          type: 'unreserve',
          reason: `Снятие дублирующего резерва комплекта (заказ ${orderLabel})`.trim(),
          meta: m
        }),
      reserveWholeKit: (kitId, units, orderLabel, m) =>
        this.applyChange(kitId, {
          delta: -Math.max(1, Math.floor(Number(units) || 0)),
          type: 'reserve',
          reason: `Перенос резерва на SKU комплекта (заказ ${orderLabel})`.trim(),
          meta: m
        })
    });
  }

  /**
   * Снять весь нетто-резерв по товару (комплект + комплектующие) по всем заказам из журнала.
   * Не блокируется статусом заказа — ручная очистка со страницы остатков.
   */
  async releaseAllReservesForProduct(productId, { profileId = null, warehouseId = null } = {}) {
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
      const orphan = await this.releaseOrphanNetReserveForProduct(idNum, { profileId, warehouseId });
      const lines = orphan.releasedProductLines || 0;
      const qty = orphan.releasedQty || 0;
      if (lines === 0 && qty === 0) {
        const error = new Error(
          'Не удалось снять резерв: по товару не найдено записей в журнале для снятия'
        );
        error.statusCode = 400;
        throw error;
      }
      return {
        releasedOrders: 0,
        releasedProductLines: lines,
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
        const chunks = await this._orderReserveReleaseChunks(orderDbId, pid, {
          marketplaceOrderId: label
        });
        if (!chunks.length) continue;
        const lines = await this._applyOrderReserveReleaseChunks(chunks, {
          orderDbId,
          label,
          sourceProductId: idNum,
          reasonPrefix: 'Снятие резерва: очистка по товару, заказ',
          extraMeta: { bulk_product_release: true }
        });
        releasedProductLines += lines;
        if (lines > 0) touched = true;
      }
      if (touched) releasedOrders += 1;
    }

    if (releasedProductLines === 0) {
      const error = new Error(
        'Не удалось снять резерв: по товару не найдено записей в журнале для снятия'
      );
      error.statusCode = 400;
      throw error;
    }

    return {
      releasedOrders,
      releasedProductLines,
      ordersChecked: list.length
    };
  }

  /** Снять резерв по одному заказу (устаревший / терминальный статус). */
  async releaseAllStaleReserveForOrder(orderDbId, orderIdLabel, { profileId = null } = {}) {
    const oid = Number(orderDbId);
    if (!Number.isFinite(oid) || oid < 1) return { releasedProductLines: 0 };

    const { default: ordersService } = await import('./orders.service.js');
    const { releasedProductLines } = await ordersService.releaseReserveForOrderDbId(oid, {
      reasonSuffix: 'устаревший резерв',
      reallocate: true
    });
    return { releasedProductLines, orderDbId: oid };
  }

  async releaseOrderReserveForProduct(productId, orderDbId, { profileId = null } = {}) {
    const idNum = typeof productId === 'string' ? parseInt(productId, 10) : Number(productId);
    const oid = Number(orderDbId);
    if (!Number.isFinite(idNum) || idNum < 1 || !Number.isFinite(oid) || oid < 1) {
      const error = new Error('Некорректные параметры');
      error.statusCode = 400;
      throw error;
    }

    await this._reconcileKitReserveForProductModal(idNum).catch(() => {});

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
    const label = orderRow
      ? String(orderRow.order_id ?? '')
      : String(oid);

    const productIds = await this._productIdsForReserveRelease(idNum);
    let releasedProductLines = 0;
    for (const pid of productIds) {
      const chunks = await this._orderReserveReleaseChunks(oid, pid, { marketplaceOrderId: label });
      if (!chunks.length) continue;
      try {
        releasedProductLines += await this._applyOrderReserveReleaseChunks(chunks, {
          orderDbId: oid,
          label,
          sourceProductId: idNum,
          reasonPrefix: 'Снятие резерва: заказ'
        });
      } catch (e) {
        if (e?.statusCode !== 400) throw e;
      }
    }

    if (releasedProductLines === 0) {
      const error = new Error(
        `Не удалось снять резерв по заказу ${label || oid}: в журнале нет записей для снятия`
      );
      error.statusCode = 400;
      throw error;
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

      const insertMovement = async ({ delta, warehouseId, direction, whBefore, whAfter }) => {
        const metaMove = {
          ...metaObj,
          direction,
          warehouse_balance_before: whBefore,
          warehouse_balance_after: whAfter,
        };
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

      const movementOut = await insertMovement({
        delta: -q,
        warehouseId: fromId,
        direction: 'out',
        whBefore: fromQty,
        whAfter: nextFrom,
      });
      const movementIn = await insertMovement({
        delta: q,
        warehouseId: toId,
        direction: 'in',
        whBefore: toQty,
        whAfter: nextTo,
      });

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
    const { isKitProductId } = await import('./kitStock.service.js');
    const isKit =
      pt === 'kit' || product.is_kit_catalog === true || (await isKitProductId(pid));

    const whId = await this.productsRepository.resolveOwnWarehouseId(warehouseId, productProfileId);
    if (!whId) {
      const error = new Error('Укажите склад для установки наличия');
      error.statusCode = 400;
      throw error;
    }

    const incomingN = Math.max(0, Math.floor(Number(incoming) || 0));
    const onHandN = Math.max(0, Math.floor(Number(onHand) || 0));
    const reservedN = Math.max(0, Math.floor(Number(reserved) || 0));
    const resetReason = reason || 'Сброс истории остатков администратором аккаунта';

    return this._executeStockHistoryReset(pid, {
      product,
      profileId: productProfileId,
      incomingN,
      reservedN,
      resetReason,
      warehouseStocks: [{ warehouseId: whId, quantity: onHandN }],
      isKit,
    });
  }

  /**
   * Сброс истории с сохранением текущих остатков (в пути, наличие по складам, резерв).
   */
  async resetProductStockHistoryPreserveCurrent(productId, { profileId, reason = null } = {}) {
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
    const { isKitProductId } = await import('./kitStock.service.js');
    const isKit =
      pt === 'kit' || product.is_kit_catalog === true || (await isKitProductId(pid));

    const pwsRes = await query(
      `SELECT warehouse_id, COALESCE(quantity, 0)::int AS quantity
       FROM product_warehouse_stock
       WHERE product_id = $1::bigint
       ORDER BY quantity DESC, warehouse_id ASC`,
      [pid]
    );

    const reservedRes = await query(
      `SELECT COALESCE((
         SELECT ${NET_RESERVED_SUM_EXPR_SQL}::int
         FROM stock_movements sm
         WHERE sm.product_id = p.id AND sm.type IN ('reserve', 'unreserve')
       ), COALESCE(p.reserved_quantity, 0), 0)::int AS reserved,
       COALESCE(p.incoming_quantity, 0)::int AS incoming,
       COALESCE(p.quantity, 0)::int AS quantity
       FROM products p
       WHERE p.id = $1::bigint`,
      [pid]
    );
    const metrics = reservedRes.rows[0] || {};
    const incomingN = Math.max(0, Number(metrics.incoming) || 0);
    const reservedN = Math.max(0, Number(metrics.reserved) || 0);

    let warehouseStocks = (pwsRes.rows || [])
      .map((row) => ({
        warehouseId: row.warehouse_id,
        quantity: Math.max(0, Math.floor(Number(row.quantity) || 0)),
      }))
      .filter((row) => row.warehouseId != null);

    const totalPws = warehouseStocks.reduce((sum, row) => sum + row.quantity, 0);
    const productQty = Math.max(0, Number(metrics.quantity) || 0);
    if (warehouseStocks.length === 0 && productQty > 0) {
      const whId = await this.productsRepository.resolveOwnWarehouseId(null, productProfileId);
      if (whId) {
        warehouseStocks = [{ warehouseId: whId, quantity: productQty }];
      }
    } else if (totalPws <= 0 && productQty > 0 && warehouseStocks.length > 0) {
      warehouseStocks[0] = { ...warehouseStocks[0], quantity: productQty };
    }

    const resetReason = reason || 'Сброс истории остатков администратором аккаунта';

    return this._executeStockHistoryReset(pid, {
      product,
      profileId: productProfileId,
      incomingN,
      reservedN,
      resetReason,
      warehouseStocks,
      isKit,
    });
  }

  /** Массовый сброс истории остатков по всем товарам аккаунта. */
  async resetAllStockHistoryForProfile(profileId) {
    await this.assertStockHistoryResetAllowed(profileId);

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

    const productsRes = await query(
      `SELECT p.id
       FROM products p
       WHERE p.profile_id = $1::bigint
       ORDER BY p.id ASC`,
      [pid]
    );

    const reason = 'Массовый сброс истории остатков (настройки аккаунта)';
    const result = {
      productsTotal: productsRes.rows.length,
      productsProcessed: 0,
      productsSkipped: 0,
      errors: [],
    };

    for (const row of productsRes.rows) {
      const productId = Number(row.id);
      if (!Number.isFinite(productId) || productId < 1) {
        result.productsSkipped += 1;
        continue;
      }
      try {
        await this.resetProductStockHistoryPreserveCurrent(productId, { profileId: pid, reason });
        result.productsProcessed += 1;
      } catch (e) {
        result.errors.push({
          productId,
          message: e?.message || 'Ошибка сброса',
        });
      }
    }

    return result;
  }

  async _executeStockHistoryReset(
    pid,
    { product, profileId: profId, incomingN, reservedN, resetReason, warehouseStocks = [], isKit = false } = {}
  ) {
    const stocks = Array.isArray(warehouseStocks) ? warehouseStocks : [];
    const onHandN = stocks.reduce((sum, row) => sum + Math.max(0, Math.floor(Number(row.quantity) || 0)), 0);
    const orgId = product.organization_id ?? product.organizationId ?? null;

    const primaryWarehouseId =
      stocks.length > 0
        ? stocks.reduce((best, row) =>
            Math.max(0, Math.floor(Number(row.quantity) || 0)) >
            Math.max(0, Math.floor(Number(best.quantity) || 0))
              ? row
              : best
          ).warehouseId
        : await this.productsRepository.resolveOwnWarehouseId(null, profId ?? product?.profile_id ?? product?.profileId ?? null);

    const metaBase = {
      stock_history_reset: true,
      admin_set: { incoming: incomingN, onHand: onHandN, reserved: reservedN },
    };

    return runWithProductStockLock(pid, async () => {
      const client = await getClient();
      try {
        await client.query('BEGIN');
        await client.query('SELECT id FROM products WHERE id = $1 FOR UPDATE', [pid]);

        if (isKit) {
          const compRes = await client.query(
            `SELECT component_product_id FROM kit_components WHERE kit_product_id = $1::bigint`,
            [pid]
          );
          const compIds = (compRes.rows || [])
            .map((row) => Number(row.component_product_id))
            .filter((id) => Number.isFinite(id) && id > 0);

          await client.query(
            `DELETE FROM stock_movements
             WHERE type IN ('reserve', 'unreserve')
               AND (
                 meta->>'kit_product_id' = $1
                 OR product_id = ANY($2::bigint[])
               )`,
            [String(pid), compIds.length > 0 ? compIds : [0]]
          );
          if (compIds.length > 0) {
            await client.query(
              `DELETE FROM stock_movements
               WHERE product_id = ANY($1::bigint[])
                 AND LOWER(TRIM(type::text)) = 'return_to_supplier'`,
              [compIds]
            );
          }
        }

        await client.query('DELETE FROM stock_movements WHERE product_id = $1', [pid]);
        await client.query('DELETE FROM product_warehouse_stock WHERE product_id = $1', [pid]);

        for (const row of stocks) {
          const wh = row.warehouseId;
          const qty = Math.max(0, Math.floor(Number(row.quantity) || 0));
          if (wh == null || qty <= 0) continue;
          await client.query(
            `INSERT INTO product_warehouse_stock (product_id, warehouse_id, quantity)
             VALUES ($1, $2, $3)
             ON CONFLICT (product_id, warehouse_id) DO UPDATE SET quantity = EXCLUDED.quantity`,
            [pid, wh, qty]
          );
        }

        await client.query(
          `UPDATE products
           SET quantity = $1,
               incoming_quantity = $2,
               reserved_quantity = 0,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $3`,
          [onHandN, incomingN, pid]
        );

        for (const row of stocks) {
          const wh = row.warehouseId;
          const qty = Math.max(0, Math.floor(Number(row.quantity) || 0));
          if (wh == null || qty <= 0) continue;
          await this.repository.insertSnapshotAfterProduct(client, {
            productId: pid,
            type: 'opening_balance',
            quantityChange: qty,
            reason: resetReason,
            meta: { ...metaBase, warehouse_id: wh },
            warehouseId: wh,
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
          const reserveWarehouseId = primaryWarehouseId;
          const reserveMovement = await this.repository.insertSnapshotAfterProduct(client, {
            productId: pid,
            type: 'reserve',
            quantityChange: -reservedN,
            reason: `${resetReason}: резерв`,
            meta: { ...metaBase, journal_reconcile: true },
            warehouseId: reserveWarehouseId,
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

        if (isKit) {
          const compRes = await query(
            `SELECT component_product_id FROM kit_components WHERE kit_product_id = $1::bigint`,
            [pid]
          );
          for (const row of compRes.rows || []) {
            const cid = Number(row.component_product_id);
            if (!Number.isFinite(cid) || cid < 1) continue;
            await syncProductReservedQuantityFromJournal(cid).catch(() => {});
          }
        }

        scheduleStockMovementMarketplaceSync(pid, {
          source: 'stock_history_reset',
          warehouseId: primaryWarehouseId,
          organizationId: orgId,
        });

        const available = Math.max(0, onHandN + incomingN - (netReserved || reservedN));

        return {
          productId: pid,
          warehouseId: primaryWarehouseId,
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

  /**
   * Отгрузка по заказу: снятие резерва и списание on-hand в одной транзакции.
   * Без достаточного резерва отгрузка не выполняется.
   */
  async applyOrderAssemblyShipment(
    productId,
    {
      shipQty: shipQtyRaw,
      unreserveReason,
      shipmentReason,
      meta = {},
      requireReserve = true
    } = {}
  ) {
    const idNum = typeof productId === 'string' ? parseInt(productId, 10) : Number(productId);
    const shipQty = Math.max(0, Math.floor(Number(shipQtyRaw) || 0));
    if (!idNum || Number.isNaN(idNum) || shipQty <= 0) {
      return { skipped: true, shipQty: 0, release: 0 };
    }

    const product = await this.productsRepository.findById(idNum);
    if (!product) {
      const error = new Error('Товар не найден');
      error.statusCode = 404;
      throw error;
    }

    const metaObj = meta && typeof meta === 'object' && !Array.isArray(meta) ? { ...meta } : {};
    const whRaw = metaObj.warehouse_id ?? metaObj.warehouseId;
    const productProfileId = product.profile_id ?? product.profileId ?? null;
    const warehouseId = await this.productsRepository.resolveOwnWarehouseId(whRaw, productProfileId);
    if (!warehouseId) {
      const error = new Error('Не найден склад для отгрузки по заказу');
      error.statusCode = 400;
      throw error;
    }

    const profId = productProfileId;
    const orgId = product.organization_id ?? product.organizationId ?? null;
    const totalBefore = product.quantity != null ? Number(product.quantity) : 0;

    const client = await getClient();
    let result;
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM products WHERE id = $1 FOR UPDATE', [idNum]);
      // Одна транзакция + xact_lock (как резерв); без runWithProductStockLock — иначе deadlock
      // при вызове из _withKitAssemblyStockLocks (два соединения, один product_id).
      await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [idNum]);

      const orderDbIdNum = metaObj.order_id != null ? Number(metaObj.order_id) : NaN;
      const mpOrderId =
        metaObj.orderId != null && String(metaObj.orderId).trim() !== ''
          ? String(metaObj.orderId).trim()
          : null;

      const { getNetReservedForOrderProduct } = await import('./kitStock.service.js');
      const { getRawReservedQuantityFromMovementsWithClient } = await import(
        './sellableQuantity.service.js'
      );

      let netForOrder = 0;
      if ((Number.isFinite(orderDbIdNum) && orderDbIdNum >= 1) || mpOrderId) {
        netForOrder = await getNetReservedForOrderProduct(
          Number.isFinite(orderDbIdNum) && orderDbIdNum >= 1 ? orderDbIdNum : 0,
          idNum,
          mpOrderId,
          warehouseId
        );
      }
      netForOrder = Math.max(0, Math.floor(Number(netForOrder) || 0));

      if (requireReserve && netForOrder < shipQty) {
        const err = new Error(
          `Недостаточно резерва для отгрузки: зарезервировано ${netForOrder}, к отгрузке ${shipQty}`
        );
        err.statusCode = 409;
        throw err;
      }

      const pwsR = await client.query(
        `SELECT quantity FROM product_warehouse_stock
         WHERE product_id = $1 AND warehouse_id = $2
         FOR UPDATE`,
        [idNum, warehouseId]
      );
      let currentWh =
        pwsR.rows?.length && pwsR.rows[0].quantity != null
          ? Math.max(0, parseInt(pwsR.rows[0].quantity, 10) || 0)
          : 0;
      if (!pwsR.rows?.length) {
        const pr = await client.query(`SELECT COALESCE(quantity, 0)::int AS q FROM products WHERE id = $1`, [
          idNum
        ]);
        currentWh = Math.max(0, Number(pr.rows[0]?.q ?? 0) || 0);
        await client.query(
          `INSERT INTO product_warehouse_stock (product_id, warehouse_id, quantity)
           VALUES ($1, $2, $3)
           ON CONFLICT (product_id, warehouse_id) DO NOTHING`,
          [idNum, warehouseId, currentWh]
        );
      }

      if (currentWh < shipQty) {
        const err = new Error(
          `Недостаточно наличия на складе для отгрузки: на складе ${currentWh}, к отгрузке ${shipQty}`
        );
        err.statusCode = 409;
        throw err;
      }

      const metaOut = { ...metaObj, warehouse_id: warehouseId };
      const release = Math.min(shipQty, netForOrder);
      let unreserveMovement = null;

      if (release > 0) {
        const journalBeforeRaw = await getRawReservedQuantityFromMovementsWithClient(client, idNum);
        const journalAfter = Math.max(0, journalBeforeRaw - release);
        await client.query(
          'UPDATE products SET reserved_quantity = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
          [journalAfter, idNum]
        );
        await this._ensureUnreserveReserveFromMeta(metaOut, {
          productId: idNum,
          releaseQty: release,
          netReserved: netForOrder,
          warehouseId,
          orderDbId: Number.isFinite(orderDbIdNum) && orderDbIdNum >= 1 ? orderDbIdNum : null,
          orderIdLabel: mpOrderId,
        });
        unreserveMovement = await this.repository.insertSnapshotAfterProduct(client, {
          productId: idNum,
          type: 'unreserve',
          quantityChange: release,
          reason: unreserveReason || null,
          meta: metaOut,
          warehouseId,
          profileId: profId
        });
      } else if (requireReserve) {
        const err = new Error('Нет резерва для снятия перед отгрузкой');
        err.statusCode = 409;
        throw err;
      }

      const newWh = currentWh - shipQty;
      await client.query(
        `INSERT INTO product_warehouse_stock (product_id, warehouse_id, quantity)
         VALUES ($1, $2, $3)
         ON CONFLICT (product_id, warehouse_id) DO UPDATE SET quantity = EXCLUDED.quantity`,
        [idNum, warehouseId, newWh]
      );
      await client.query(
        `UPDATE products
         SET quantity = COALESCE(
           (SELECT SUM(quantity)::int FROM product_warehouse_stock WHERE product_id = $1),
           0
         ),
         updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [idNum]
      );

      const shipMeta = {
        ...metaOut,
        warehouse_balance_before: currentWh,
        warehouse_balance_after: newWh,
        order_assembly_shipment: true
      };
      const shipmentMovement = await this.repository.insertSnapshotAfterProduct(client, {
        productId: idNum,
        type: 'shipment',
        quantityChange: -shipQty,
        reason: shipmentReason || null,
        meta: shipMeta,
        warehouseId,
        profileId: profId
      });

      await client.query('COMMIT');
      result = { release, unreserveMovement, shipmentMovement, warehouseId, newWh };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    try {
      await syncProductQuantityFromWarehouseStock(idNum);
      const { syncProductReservedQuantityFromJournal } = await import('./sellableQuantity.service.js');
      await syncProductReservedQuantityFromJournal(idNum);
    } catch {
      /* ignore */
    }

    try {
      const { default: ordersService } = await import('./orders.service.js');
      await ordersService.trimExcessReservesForProduct(idNum, {
        reason: shipmentReason || undefined,
        meta: { from_stock_movement_type: 'shipment' }
      });
    } catch {
      /* ignore */
    }

    scheduleStockMovementMarketplaceSync(idNum, {
      source: 'order_assembly_shipment',
      warehouseId: result.warehouseId,
      organizationId: orgId
    });

    const productAfter = await this.productsRepository.findById(idNum);
    const totalAfter = productAfter?.quantity != null ? Number(productAfter.quantity) : 0;

    return {
      productId: idNum,
      shipQty,
      release: result.release,
      quantityBefore: totalBefore,
      quantityAfter: totalAfter,
      warehouseId: result.warehouseId,
      unreserveMovement: result.unreserveMovement,
      shipmentMovement: result.shipmentMovement
    };
  }
}

export default new StockMovementsService();
