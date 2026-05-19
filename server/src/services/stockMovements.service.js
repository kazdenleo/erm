/**
 * Stock Movements Service
 * Бизнес-логика для журнала движений остатков
 */

import { query } from '../config/database.js';
import { getClient } from '../config/database.js';
import repositoryFactory from '../config/repository-factory.js';
import { scheduleWarehouseStockMarketplaceSync } from './marketplaceWarehouseStockSync.service.js';
import { scheduleMarketplaceSyncForParentKits } from './kitStock.service.js';

class StockMovementsService {
  constructor() {
    this.repository = repositoryFactory.getStockMovementsRepository();
    this.productsRepository = repositoryFactory.getProductsRepository();
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

    const currentWh = await this.productsRepository.getWarehouseFreeStock(idNum, warehouseId);
    let newWh = currentWh + safeDelta;
    if (newWh < 0) newWh = 0;

    const incomingQty = product.incoming_quantity != null ? Number(product.incoming_quantity) : 0;
    let availableForReserve = Math.max(0, totalBefore + incomingQty - currentReserved);

    let newReserved = currentReserved;
    if (type === 'reserve' && safeDelta < 0) {
      const reserveAdd = Math.abs(safeDelta);
      try {
        const { getComponentAssemblableUnits } = await import('./kitStock.service.js');
        const fromSupply = await getComponentAssemblableUnits(idNum, { warehouseId });
        availableForReserve = Math.max(availableForReserve, fromSupply);
      } catch {
        /* fallback: products.quantity + incoming − reserved_quantity */
      }
      if (reserveAdd > availableForReserve) {
        const err = new Error(
          `Недостаточно остатка для резерва (доступно: ${availableForReserve}, запрошено: ${reserveAdd})`
        );
        err.statusCode = 400;
        throw err;
      }
      newReserved = currentReserved + reserveAdd;
    } else if (type === 'unreserve' && safeDelta > 0) {
      newReserved = Math.max(0, currentReserved - safeDelta);
    }

    // ВАЖНО: резерв не должен менять фактический остаток.
    // products.quantity и product_warehouse_stock.quantity считаем "фактом" на складе,
    // а reserved_quantity — отдельное логическое поле "сколько закреплено под заказы".
    if (type !== 'reserve' && type !== 'unreserve') {
      await this.productsRepository.setWarehouseFreeStock(idNum, warehouseId, newWh);
    }

    if (type === 'reserve' || type === 'unreserve') {
      await query(
        'UPDATE products SET reserved_quantity = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [newReserved, idNum]
      );
    }

    const productAfter = await this.productsRepository.findById(idNum);
    const totalAfter = productAfter?.quantity != null ? Number(productAfter.quantity) : 0;

    const metaOut = { ...metaObj, warehouse_id: warehouseId };
    const profId = product.profile_id ?? product.profileId ?? null;
    const incAfter =
      productAfter?.incoming_quantity != null ? Number(productAfter.incoming_quantity) : 0;
    let resAfter =
      productAfter?.reserved_quantity != null ? Number(productAfter.reserved_quantity) : 0;
    if (type === 'reserve' && safeDelta < 0) {
      resAfter = newReserved;
    } else if (type === 'unreserve' && safeDelta > 0) {
      resAfter = newReserved;
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
    }

    // Резерв/снятие резерва меняет «доступно к продаже» на МП — отправляем обновлённый остаток.
    const orgId = product.organization_id ?? product.organizationId ?? null;
    scheduleWarehouseStockMarketplaceSync(idNum, {
      source: `stock_movement:${type}`,
      warehouseId,
      organizationId: orgId
    });
    scheduleMarketplaceSyncForParentKits(idNum, {
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
   * Получить историю движений по товару
   */
  async getHistory(productId, { limit = 100, profileId = null } = {}) {
    const rows = await this.repository.findByProduct(productId, { limit, profileId });
    const idNum = typeof productId === 'string' ? parseInt(productId, 10) : Number(productId);
    if (!idNum || Number.isNaN(idNum)) return rows;

    const { isKitProductId, isKitStockHistoryMovementType } = await import('./kitStock.service.js');
    if (!(await isKitProductId(idNum))) return rows;

    return rows.filter((m) => isKitStockHistoryMovementType(m?.type));
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
         SELECT DISTINCT (meta->>'order_id')::bigint AS order_row_id
         FROM stock_movements
         WHERE (${movementScopeSql})
           AND type IN ('reserve', 'unreserve')
           AND (meta->>'order_id') ~ '^[0-9]+$'
       ),
       sku_net AS (
         SELECT (meta->>'order_id')::bigint AS order_row_id,
           GREATEST(0, COALESCE(SUM(
             CASE
               WHEN type = 'reserve' THEN -(quantity_change::numeric)
               WHEN type = 'unreserve' THEN -(quantity_change::numeric)
               ELSE 0
             END
           ), 0))::int AS sku_net_qty
         FROM stock_movements
         WHERE product_id = $1
           AND type IN ('reserve', 'unreserve')
           AND (meta->>'order_id') ~ '^[0-9]+$'
         GROUP BY 1
       )
       SELECT o.id, o.marketplace, o.order_id, o.status,
              COALESCE(sku_net.sku_net_qty, 0) AS sku_net_qty
       FROM order_ids
       INNER JOIN orders o ON o.id = order_ids.order_row_id
       LEFT JOIN sku_net ON sku_net.order_row_id = order_ids.order_row_id
       ORDER BY o.created_at DESC NULLS LAST, o.id DESC
       LIMIT 200`,
      [idNum]
    );

    if (!_skipStaleCleanup && (res.rows?.length ?? 0) > 0) {
      const { default: ordersService, isOrderTerminalNoReserve } = await import('./orders.service.js');
      let cleaned = false;
      for (const r of res.rows || []) {
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
      const orderDbId = Number(r.id);
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

  async _netReservedForOrderProduct(orderDbId, productId) {
    const oid = Number(orderDbId);
    const pid = Number(productId);
    if (!Number.isFinite(oid) || oid < 1 || !Number.isFinite(pid) || pid < 1) return 0;
    const r = await query(
      `SELECT
         COALESCE(SUM(CASE WHEN type = 'reserve' THEN -quantity_change ELSE 0 END), 0)::int AS reserved,
         COALESCE(SUM(CASE WHEN type = 'unreserve' THEN quantity_change ELSE 0 END), 0)::int AS unreserved
       FROM stock_movements
       WHERE product_id = $1
         AND type IN ('reserve', 'unreserve')
         AND (meta->>'order_id')::bigint = $2::bigint`,
      [pid, oid]
    );
    const row = r.rows?.[0];
    const reserved = row?.reserved != null ? Number(row.reserved) : 0;
    const unreserved = row?.unreserved != null ? Number(row.unreserved) : 0;
    return Math.max(0, reserved - unreserved);
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
    if (!list.length) {
      return { releasedOrders: 0, releasedProductLines: 0, ordersChecked: 0 };
    }

    const productIds = await this._productIdsForReserveRelease(idNum);
    let releasedOrders = 0;
    let releasedProductLines = 0;

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
}

export default new StockMovementsService();
