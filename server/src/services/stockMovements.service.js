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

    let newReserved = currentReserved;
    if (type === 'reserve' && safeDelta < 0) {
      newReserved = currentReserved + Math.abs(safeDelta);
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
    return await this.repository.findByProduct(productId, { limit, profileId });
  }

  /**
   * Заказы, под которые сейчас числится ненулевой резерв товара (по журналу reserve/unreserve).
   */
  async listReservedOrdersForProduct(productId, { profileId = null } = {}) {
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
      `WITH net AS (
         SELECT (meta->>'order_id')::bigint AS order_row_id,
           SUM(
             CASE WHEN type = 'reserve' THEN -quantity_change
                  WHEN type = 'unreserve' THEN quantity_change
                  ELSE 0 END
           )::int AS qty
         FROM stock_movements
         WHERE product_id = $1
           AND (type = 'reserve' OR type = 'unreserve')
           AND (meta->>'order_id') ~ '^[0-9]+$'
         GROUP BY 1
       )
       SELECT o.id, o.marketplace, o.order_id, net.qty AS reserved_qty
       FROM net
       INNER JOIN orders o ON o.id = net.order_row_id
       WHERE net.qty > 0
       ORDER BY o.created_at DESC NULLS LAST, o.id DESC
       LIMIT 200`,
      [idNum]
    );
    return (res.rows || []).map((r) => ({
      orderDbId: Number(r.id),
      marketplace:
        r.marketplace === 'wb' ? 'wildberries' : r.marketplace === 'ym' ? 'yandex' : 'ozon',
      orderId: r.order_id,
      reservedQty: Number(r.reserved_qty) || 0,
    }));
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
