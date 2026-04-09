/**
 * Orders Service
 * Бизнес-логика для работы с заказами
 */

import fetch from 'node-fetch';
import { query } from '../config/database.js';
import repositoryFactory from '../config/repository-factory.js';
import stockMovementsService from './stockMovements.service.js';
import integrationsService from './integrations.service.js';
import { getYandexBusinessAndCampaigns, normalizeYandexApiKey } from './orders.sync.service.js';
import { getYandexHttpsAgent } from '../utils/yandex-https-agent.js';

/** marketplace как в product_skus: ozon | wb | ym */
function marketplaceForProductSkus(marketplace) {
  const m = String(marketplace || '').toLowerCase();
  if (m === 'wildberries' || m === 'wb') return 'wb';
  if (m === 'yandex' || m === 'ym' || m === 'yandexmarket') return 'ym';
  return m === 'ozon' ? 'ozon' : m;
}

function marketplaceToOrdersDb(marketplace) {
  const m = String(marketplace || '').toLowerCase();
  if (m === 'wildberries' || m === 'wb') return 'wb';
  if (m === 'yandex' || m === 'ym' || m === 'yandexmarket' || m === 'yandex market') return 'ym';
  if (m === 'manual') return 'manual';
  return m === 'ozon' ? 'ozon' : m;
}

class OrdersService {
  constructor() {
    this.repository = repositoryFactory.getOrdersRepository();
  }

  /**
   * Исправление резервов: снять все резервы по заказам «В закупке» и поставить заново по текущим правилам.
   * Нужна для очистки "старых" резервов, которые могли ставиться до появления incoming/остатка.
   */
  async rebuildProcurementReserves() {
    if (!repositoryFactory.isUsingPostgreSQL()) {
      const err = new Error('Операция доступна только для PostgreSQL');
      err.statusCode = 400;
      throw err;
    }
    const r = await query(
      `SELECT id
       FROM orders
       WHERE status = 'in_procurement'
       ORDER BY id ASC
       LIMIT 5000`
    );
    const ids = (r.rows || []).map((x) => Number(x.id)).filter((n) => Number.isFinite(n) && n > 0);
    let cleared = 0;
    let reapplied = 0;
    for (const id of ids) {
      const reservedQty = await this._getReservedQtyForOrder(id);
      if (reservedQty <= 0) continue;
      const mv = await query(
        `SELECT product_id FROM stock_movements
         WHERE type = 'reserve' AND quantity_change < 0
           AND (meta->>'order_id')::bigint = $1::bigint
         ORDER BY id DESC LIMIT 1`,
        [id]
      );
      const productId = mv.rows?.[0]?.product_id != null ? Number(mv.rows[0].product_id) : null;
      if (!productId) continue;
      await stockMovementsService.applyChange(productId, {
        delta: reservedQty,
        type: 'unreserve',
        reason: `Исправление резерва (пересборка)`,
        meta: { order_id: id, rebuild: true }
      });
      cleared++;
    }
    for (const id of ids) {
      const full = await this.repository.findById(id);
      const before = await this._getReservedQtyForOrder(id);
      await this._applyReserveForOrderIfAbsent(full);
      const after = await this._getReservedQtyForOrder(id);
      if (after > before) reapplied++;
    }
    return { ok: true, ordersProcessed: ids.length, clearedOrders: cleared, reappliedOrders: reapplied };
  }

  /**
   * Обеспечить резерв по заказу (если заказ существует и в статусе in_procurement).
   * Используется, когда закупка уже создана/переведена в ordered и incoming должен быть "в резерве" под заказы.
   */
  async ensureReserveForOrderIfInProcurement(marketplace, orderId) {
    if (!repositoryFactory.isUsingPostgreSQL()) return;
    if (!marketplace || orderId == null) return;
    const mp = marketplaceToOrdersDb(marketplace);
    const order = await this.repository.findByMarketplaceAndOrderId(mp, String(orderId));
    if (!order) return;
    if (String(order.status || '').toLowerCase() !== 'in_procurement') return;
    await this._applyReserveForOrderIfAbsent(order);
  }

  async _resolveOwnWarehouseIdForOrder(orderRow) {
    if (!repositoryFactory.isUsingPostgreSQL() || !orderRow) return null;
    const mpRaw = String(orderRow.marketplace || '').toLowerCase();
    const mp = mpRaw === 'wildberries' ? 'wb' : (mpRaw === 'yandex' ? 'ym' : mpRaw);
    const mpWarehouseId = String(orderRow.deliveryAddress ?? orderRow.delivery_address ?? '').trim();
    if (mp && mpWarehouseId) {
      try {
        const repo = repositoryFactory.getRepository('warehouse_mappings');
        const wid = await repo?.findOwnWarehouseIdByMarketplaceWarehouseId?.(mp, mpWarehouseId);
        if (wid) return wid;
      } catch {
        // ignore
      }
    }
    return await stockMovementsService.productsRepository.resolveOwnWarehouseId(null);
  }

  async _reserveForOrderIfStockAvailable(orderRow) {
    if (!repositoryFactory.isUsingPostgreSQL() || !orderRow) return;
    const id = orderRow.id;
    if (!id) return;
    if (await this._hasDbReserveForOrder(id)) return;

    let productId = orderRow.productId ?? orderRow.product_id;
    if (!productId) productId = await this.resolveProductIdForAssemblyLine(orderRow);
    productId = Number(productId);
    if (!Number.isFinite(productId) || productId < 1) return;

    const qty = Math.max(1, parseInt(orderRow.quantity, 10) || 1);
    const metaOrderId = Number.isFinite(Number(id)) ? Number(id) : id;

    // Для "Новый": автозакрепляем ТОЛЬКО фактический остаток (quantity - reserved).
    // incoming предназначен для заказов в "В закупке", иначе "Новые" начинают видеть "товар есть",
    // хотя он уже в пути и закреплён под другие закупочные заказы.
    //
    // Для "В закупке": можно резервировать и из incoming (quantity + incoming - reserved).
    const pr = await query(
      `SELECT COALESCE(quantity, 0) AS quantity,
              COALESCE(incoming_quantity, 0) AS incoming_quantity,
              COALESCE(reserved_quantity, 0) AS reserved_quantity
       FROM products
       WHERE id = $1
       LIMIT 1`,
      [productId]
    );
    const row = pr.rows?.[0];
    const actual = row?.quantity != null ? Number(row.quantity) : 0;
    const incoming = row?.incoming_quantity != null ? Number(row.incoming_quantity) : 0;
    const reserved = row?.reserved_quantity != null ? Number(row.reserved_quantity) : 0;
    const st = String(orderRow.status ?? orderRow.order_status ?? '').toLowerCase();
    const supply = st === 'in_procurement' ? (actual + incoming) : actual;
    const availableSupply = Math.max(0, supply - reserved);
    if (availableSupply < qty) return;

    const warehouseId = await this._resolveOwnWarehouseIdForOrder(orderRow);

    const orderIdStr = String(orderRow.orderId ?? orderRow.order_id ?? '').trim();
    await this._applyReserveForOrder(productId, qty, orderIdStr || String(id), {
      order_id: metaOrderId,
      orderId: orderIdStr,
      warehouse_id: warehouseId
    });
  }

  /**
   * Установить резерв по заказу: уменьшить доступный остаток и записать движение в историю.
   * @param {number} productId
   * @param {number} quantity
   * @param {string} orderId - номер заказа для отображения в истории
   * @param {object} [meta] - order id, order_group_id и т.д.
   */
  async _applyReserveForOrder(productId, quantity, orderId, meta = {}) {
    if (!productId || quantity < 1) return;
    const qtyWanted = Math.max(1, parseInt(quantity, 10) || 1);

    // Жёсткая защита: нельзя создавать резерв без покрытия (факт + ожидается - уже зарезервировано).
    // Это предотвращает ситуацию, когда резерв появляется до закупки/поступления.
    const pr = await query(
      `SELECT COALESCE(quantity, 0) AS quantity,
              COALESCE(incoming_quantity, 0) AS incoming_quantity,
              COALESCE(reserved_quantity, 0) AS reserved_quantity
       FROM products
       WHERE id = $1
       LIMIT 1`,
      [productId]
    );
    const row = pr.rows?.[0];
    const actual = row?.quantity != null ? Number(row.quantity) : 0;
    const incoming = row?.incoming_quantity != null ? Number(row.incoming_quantity) : 0;
    const reserved = row?.reserved_quantity != null ? Number(row.reserved_quantity) : 0;
    const availableSupply = Math.max(0, actual + incoming - reserved);
    const qty = Math.min(qtyWanted, Math.floor(availableSupply));
    if (qty <= 0) return;

    await stockMovementsService.applyChange(productId, {
      delta: -qty,
      type: 'reserve',
      reason: `Резерв по заказу ${orderId || ''}`.trim() || 'Резерв',
      meta: { ...meta }
    });
  }

  /** Есть ли движение резерва, привязанное к строке заказа (orders.id) в meta.order_id */
  async _hasDbReserveForOrder(orderDbId) {
    if (!orderDbId || !repositoryFactory.isUsingPostgreSQL()) return false;
    const r = await query(
      `SELECT 1 FROM stock_movements
       WHERE type = 'reserve' AND quantity_change < 0
         AND (meta->>'order_id')::bigint = $1::bigint
       LIMIT 1`,
      [orderDbId]
    );
    return !!r.rows?.length;
  }

  /** Сколько уже зарезервировано под строку заказа (orders.id) по движениям reserve/unreserve. */
  async _getReservedQtyForOrder(orderDbId) {
    if (!orderDbId || !repositoryFactory.isUsingPostgreSQL()) return 0;
    const r = await query(
      `SELECT
         COALESCE(SUM(CASE WHEN type = 'reserve' THEN -quantity_change ELSE 0 END), 0)::int AS reserved,
         COALESCE(SUM(CASE WHEN type = 'unreserve' THEN quantity_change ELSE 0 END), 0)::int AS unreserved
       FROM stock_movements
       WHERE (type = 'reserve' OR type = 'unreserve')
         AND (meta->>'order_id')::bigint = $1::bigint`,
      [orderDbId]
    );
    const row = r.rows?.[0];
    const reserved = row?.reserved != null ? Number(row.reserved) : 0;
    const unreserved = row?.unreserved != null ? Number(row.unreserved) : 0;
    return Math.max(0, reserved - unreserved);
  }

  /** Резерв для строки заказа из БД, если ещё нет резерва с тем же orders.id (идемпотентно). */
  async _applyReserveForOrderIfAbsent(orderRow) {
    if (!repositoryFactory.isUsingPostgreSQL() || !orderRow) return;
    const id = orderRow.id;
    const orderIdStr = String(orderRow.orderId ?? orderRow.order_id ?? '').trim();
    const qty = Math.max(1, parseInt(orderRow.quantity, 10) || 1);
    if (!id) return;
    let productId = orderRow.productId ?? orderRow.product_id;
    if (!productId) {
      productId = await this.resolveProductIdForAssemblyLine(orderRow);
    }
    if (!productId) return;
    productId = Number(productId);
    if (!Number.isFinite(productId) || productId < 1) return;

    // Частичный резерв:
    // - резервируем только то, что уже есть (факт + ожидается - уже зарезервировано)
    // - если пришла часть товара, резервируем эту часть, даже если до количества заказа не хватает
    const alreadyReservedForOrder = await this._getReservedQtyForOrder(id);
    const need = Math.max(0, qty - alreadyReservedForOrder);
    if (need <= 0) return;

    const pr = await query(
      `SELECT COALESCE(quantity, 0) AS quantity,
              COALESCE(incoming_quantity, 0) AS incoming_quantity,
              COALESCE(reserved_quantity, 0) AS reserved_quantity
       FROM products
       WHERE id = $1
       LIMIT 1`,
      [productId]
    );
    const row = pr.rows?.[0];
    const actual = row?.quantity != null ? Number(row.quantity) : 0;
    const incoming = row?.incoming_quantity != null ? Number(row.incoming_quantity) : 0;
    const reserved = row?.reserved_quantity != null ? Number(row.reserved_quantity) : 0;
    const availableSupply = Math.max(0, actual + incoming - reserved);
    const reserveNow = Math.min(need, Math.floor(availableSupply));
    if (reserveNow <= 0) return;

    const orderRowDbId = typeof id === 'bigint' ? Number(id) : Number(id);
    const metaOrderId = Number.isFinite(orderRowDbId) ? orderRowDbId : id;
    await this._applyReserveForOrder(productId, reserveNow, orderIdStr || String(id), {
      order_id: metaOrderId,
      orderId: orderIdStr,
      partial: reserveNow < need
    });
  }

  /**
   * Снять резерв по заказу, если он был оформлен с привязкой meta.order_id (например после «В закупку»).
   */
  async releaseReserveIfExistsForOrder(marketplace, orderId) {
    if (!marketplace || orderId == null || !repositoryFactory.isUsingPostgreSQL()) return;
    const order = await this.repository.findByMarketplaceAndOrderId(marketplace, String(orderId));
    if (!order) return;
    const id = order.id;
    if (!id || !(await this._hasDbReserveForOrder(id))) return;
    let productId = order.productId ?? order.product_id;
    if (!productId) {
      const mv = await query(
        `SELECT product_id FROM stock_movements
         WHERE type = 'reserve' AND quantity_change < 0
           AND (meta->>'order_id')::bigint = $1::bigint
         ORDER BY id DESC LIMIT 1`,
        [id]
      );
      productId = mv.rows?.[0]?.product_id;
    }
    if (!productId) {
      productId = await this.resolveProductIdForAssemblyLine(order);
    }
    if (!productId) return;
    productId = Number(productId);
    if (!Number.isFinite(productId) || productId < 1) return;
    const qty = Math.max(1, parseInt(order.quantity, 10) || 1);
    const oid = String(order.orderId ?? order.order_id ?? orderId);
    const orderRowDbId = typeof id === 'bigint' ? Number(id) : Number(id);
    const metaOrderId = Number.isFinite(orderRowDbId) ? orderRowDbId : id;
    await stockMovementsService.applyChange(productId, {
      delta: qty,
      type: 'unreserve',
      reason: `Снятие резерва: возврат заказа ${oid} из закупки`,
      meta: { order_id: metaOrderId, orderId: oid }
    });

    // Освободили supply (факт/в пути) — попробуем сразу отдать его следующему нуждающемуся заказу в «В закупке».
    await this.ensureReservesForProductIfSupplyAvailable(productId);
  }

  /**
   * После освобождения резерва (cancel/delete/изменения закупки) — попытаться
   * зарезервировать освободившийся supply (actual+incoming-reserved) под другие заказы этого товара.
   * Важно: не делаем глобальную "пересборку" (которая пишет unreserve+reserve пачкой),
   * а только ДОрезервируем тем, кому не хватает.
   */
  async ensureReservesForProductIfSupplyAvailable(productId) {
    if (!repositoryFactory.isUsingPostgreSQL()) return;
    const pid = Number(productId);
    if (!Number.isFinite(pid) || pid < 1) return;
    const pr = await query(
      `SELECT COALESCE(quantity, 0) AS quantity,
              COALESCE(incoming_quantity, 0) AS incoming_quantity,
              COALESCE(reserved_quantity, 0) AS reserved_quantity
       FROM products
       WHERE id = $1
       LIMIT 1`,
      [pid]
    );
    const row = pr.rows?.[0];
    const actual = row?.quantity != null ? Number(row.quantity) : 0;
    const incoming = row?.incoming_quantity != null ? Number(row.incoming_quantity) : 0;
    const reserved = row?.reserved_quantity != null ? Number(row.reserved_quantity) : 0;
    const availableSupply = Math.max(0, actual + incoming - reserved);
    if (availableSupply <= 0) return;

    // FIFO по времени создания заказа: более ранние заказы в «В закупке» должны получить резерв раньше.
    const orders = await query(
      `SELECT *
       FROM orders
       WHERE status = 'in_procurement'
         AND product_id = $1
       ORDER BY created_at ASC, id ASC
       LIMIT 500`,
      [pid]
    );
    for (const o of orders.rows || []) {
      // _applyReserveForOrderIfAbsent внутри сам ограничит резерв доступностью и сделает частичный резерв при необходимости.
      await this._applyReserveForOrderIfAbsent(o).catch(() => {});
    }
  }

  async getAll(options = {}) {
    if (repositoryFactory.isUsingPostgreSQL()) {
      return await this.repository.findAll(options);
    } else {
      // Старое хранилище
      return await this.repository.findAll();
    }
  }

  async getById(id) {
    if (!repositoryFactory.isUsingPostgreSQL()) {
      const orders = await this.getAll();
      return orders.find(o => String(o.id) === String(id)) || null;
    }
    return await this.repository.findById(id);
  }

  async getByMarketplaceAndOrderId(marketplace, orderId) {
    if (repositoryFactory.isUsingPostgreSQL()) {
      return await this.repository.findByMarketplaceAndOrderId(marketplace, orderId);
    } else {
      const orders = await this.getAll();
      return orders.find(o => o.marketplace === marketplace && o.orderId === orderId) || null;
    }
  }

  /** Найти заказ по order_id (posting number) в любом маркетплейсе — для этикеток и роутов по :orderId */
  async getByOrderId(orderId) {
    if (repositoryFactory.isUsingPostgreSQL()) {
      return await this.repository.findAnyByOrderId(orderId);
    } else {
      const orders = await this.getAll();
      const id = String(orderId ?? '').trim();
      if (!id) return null;
      return (
        orders.find((o) => String(o.orderId) === id) ||
        orders.find((o) => String(o.orderGroupId || o.order_group_id || '') === id) ||
        orders.find((o) => String(o.orderId || '').startsWith(`${id}~`)) ||
        null
      );
    }
  }

  async count(options = {}) {
    if (repositoryFactory.isUsingPostgreSQL()) {
      return await this.repository.count(options);
    } else {
      const orders = await this.getAll();
      return orders.length;
    }
  }

  async getStatistics(options = {}) {
    if (repositoryFactory.isUsingPostgreSQL()) {
      return await this.repository.getStatistics(options);
    } else {
      // Простая статистика для старого хранилища
      const orders = await this.getAll();
      const stats = {};
      orders.forEach(order => {
        const key = `${order.marketplace || 'unknown'}_${order.status || 'unknown'}`;
        if (!stats[key]) {
          stats[key] = {
            marketplace: order.marketplace || 'unknown',
            status: order.status || 'unknown',
            count: 0,
            total_quantity: 0,
            total_amount: 0
          };
        }
        stats[key].count++;
        stats[key].total_quantity += parseInt(order.quantity) || 0;
        stats[key].total_amount += parseFloat(order.price || 0) * (parseInt(order.quantity) || 0);
      });
      return Object.values(stats);
    }
  }

  /**
   * Создать заказ (ручное добавление или иное). Только PostgreSQL.
   * При создании устанавливается резерв по товару и запись в истории остатков.
   */
  async create(orderData) {
    if (!repositoryFactory.isUsingPostgreSQL()) {
      const error = new Error('Ручное добавление заказов поддерживается только при использовании PostgreSQL');
      error.statusCode = 501;
      throw error;
    }
    const created = await this.repository.create(orderData);
    const productId = created?.productId ?? created?.product_id ?? orderData.product_id;
    const quantity = created?.quantity ?? orderData.quantity ?? 1;
    const orderId = created?.orderId ?? created?.order_id ?? orderData.order_id;
    if (productId) {
      const rid = created?.id;
      const metaOid = rid != null && Number.isFinite(Number(rid)) ? Number(rid) : rid;
      await this._applyReserveForOrder(productId, quantity, orderId, {
        order_id: metaOid,
        orderId: orderId
      });
    }
    return created;
  }

  /**
   * Создать ручной заказ с несколькими товарами (одна группа).
   * @param {Array<{ productId: number, quantity: number }>} items
   * @returns {Promise<object>} { orderGroupId, orders: [...] }
   */
  async createManualWithItems(items) {
    if (!repositoryFactory.isUsingPostgreSQL()) {
      const error = new Error('Ручное добавление заказов поддерживается только при использовании PostgreSQL');
      error.statusCode = 501;
      throw error;
    }
    if (!Array.isArray(items) || items.length === 0) {
      const error = new Error('Укажите хотя бы одну позицию (items: [{ productId, quantity }, ...])');
      error.statusCode = 400;
      throw error;
    }
    const productsService = (await import('./products.service.js')).default;
    const orderGroupId = `manual-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const created = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const productId = item.productId != null ? Number(item.productId) : null;
      const quantity = Math.max(1, parseInt(item.quantity, 10) || 1);
      if (!productId || !Number.isInteger(productId) || productId < 1) continue;
      const productObj = await productsService.getById(productId);
      if (!productObj) continue;
      const price = productObj.cost != null ? Number(productObj.cost) : (productObj.price != null ? Number(productObj.price) : 0);
      const orderId = i === 0 ? orderGroupId : `${orderGroupId}-${i + 1}`;
      const orderData = {
        marketplace: 'manual',
        order_id: orderId,
        order_group_id: orderGroupId,
        product_id: productId,
        product_name: productObj.name ?? productObj.product_name ?? null,
        offer_id: null,
        marketplace_sku: null,
        quantity,
        price,
        status: 'new'
      };
      const row = await this.repository.create(orderData);
      const rid = row?.id;
      const metaOid = rid != null && Number.isFinite(Number(rid)) ? Number(rid) : rid;
      await this._applyReserveForOrder(productId, quantity, orderId, {
        order_id: metaOid,
        orderId,
        order_group_id: orderGroupId
      });
      created.push(row);
    }
    return { orderGroupId, orders: created };
  }

  /** Найти все заказы группы (для сборки) */
  async getByOrderGroupId(orderGroupId) {
    if (!repositoryFactory.isUsingPostgreSQL() || !orderGroupId) return [];
    return await this.repository.findByOrderGroupId(orderGroupId);
  }

  /**
   * Уточнить product_id строки заказа для UI сборки, если в orders.product_id пусто
   * (типично Yandex/WB до сопоставления): по offer_id / marketplace_sku и таблице product_skus.
   */
  async resolveProductIdForAssemblyLine(orderRow) {
    const raw = orderRow.productId ?? orderRow.product_id;
    if (raw != null && String(raw).trim() !== '') {
      const n = Number(raw);
      return Number.isNaN(n) ? raw : n;
    }
    if (!repositoryFactory.isUsingPostgreSQL()) return null;
    const mp = marketplaceForProductSkus(orderRow.marketplace);
    const offer = String(orderRow.offerId ?? orderRow.offer_id ?? '').trim();
    const msku = String(orderRow.sku ?? orderRow.marketplace_sku ?? '').trim();
    const trySku = async skuVal => {
      if (!skuVal) return null;
      try {
        const r = await query(
          `SELECT product_id FROM product_skus WHERE marketplace = $1 AND TRIM(sku) = TRIM($2) LIMIT 1`,
          [mp, skuVal]
        );
        return r.rows[0]?.product_id ?? null;
      } catch {
        return null;
      }
    };
    let found = await trySku(offer);
    if (found != null) return found;
    found = await trySku(msku);
    if (found != null) return found;
    if (mp === 'ozon' && msku && /^[0-9]+$/.test(msku)) {
      try {
        const r = await query(
          `SELECT product_id FROM product_skus WHERE marketplace = 'ozon' AND marketplace_product_id = $1::bigint LIMIT 1`,
          [msku]
        );
        if (r.rows[0]?.product_id != null) return r.rows[0].product_id;
      } catch {
        /* нет marketplace_product_id или другой тип */
      }
    }
    if (mp === 'wb' && offer) {
      const m = offer.match(/([0-9]{5,})$/);
      if (m) {
        found = await trySku(m[1]);
        if (found != null) return found;
      }
    }
    if (mp === 'wb') {
      const pn = String(orderRow.productName ?? orderRow.product_name ?? '').trim();
      if (pn) {
        const m = pn.match(/([0-9]{5,})$/);
        if (m) {
          found = await trySku(m[1]);
          if (found != null) return found;
        }
      }
    }
    /** Артикулы МП в БД — в product_skus; основной артикул — products.sku */
    const tryProductTable = async (skuVal) => {
      if (!skuVal) return null;
      const v = String(skuVal).trim();
      if (!v) return null;
      try {
        const r = await query(
          `SELECT id FROM (
             SELECT id FROM products WHERE TRIM(COALESCE(sku, '')) = TRIM($1)
             UNION ALL
             SELECT product_id AS id FROM product_skus WHERE TRIM(COALESCE(sku, '')) = TRIM($1)
           ) t
           ORDER BY id ASC
           LIMIT 1`,
          [v]
        );
        return r.rows[0]?.id ?? null;
      } catch {
        return null;
      }
    };
    found = await tryProductTable(offer);
    if (found != null) return found;
    found = await tryProductTable(msku);
    if (found != null) return found;
    return null;
  }

  /**
   * Найти первый по списку заказ на сборке (status in_assembly), содержащий товар с productId.
   * При PostgreSQL учитывает и совпадение по product_skus (для заказов WB без product_id — по nmId/offer_id/product_name).
   * @param {number|string} productId
   * @returns {Promise<object|null>} заказ или null
   */
  async findFirstAssembledByProductId(productId) {
    if (productId == null) return null;
    if (repositoryFactory.isUsingPostgreSQL()) {
      const order = await this.repository.findFirstAssembledByProductIdOrSku(productId);
      return order || null;
    }
    const orders = await this.getAll();
    const found = orders.find(
      o => o.status === 'in_assembly' && String(o.productId) === String(productId)
    );
    return found || null;
  }

  /**
   * Найти первый заказ на сборке по названию товара (fallback для случаев,
   * когда orders.product_id не заполнен и нет совпадения по offer_id/sku).
   * @param {string} productName
   */
  async findFirstAssembledByProductName(productName) {
    const name = (productName || '').trim();
    if (!name) return null;
    if (repositoryFactory.isUsingPostgreSQL()) {
      const list = await this.repository.findAll({ status: 'in_assembly', search: name, limit: 25 });
      if (!Array.isArray(list) || list.length === 0) return null;
      const norm = (s) => String(s || '').trim().toLowerCase();
      const exact = list.find(o => norm(o.productName || o.product_name) === norm(name));
      return exact || list[0] || null;
    }
    const orders = await this.getAll();
    const norm = (s) => String(s || '').trim().toLowerCase();
    return orders.find(o => o.status === 'in_assembly' && norm(o.productName || o.product_name) === norm(name)) || null;
  }

  /**
   * Отправить выбранные заказы на сборку: обновить статус на 'in_assembly'.
   * @param {Array<{ marketplace: string, orderId: string }>} orderIds
   * @returns {{ sent: number, updated: number }}
   */
  async sendToAssembly(orderIds) {
    if (!Array.isArray(orderIds) || orderIds.length === 0) {
      return { sent: 0, updated: 0 };
    }
    let updated = 0;
    if (repositoryFactory.isUsingPostgreSQL()) {
      for (const { marketplace, orderId } of orderIds) {
        if (!marketplace || orderId == null) continue;
        const row = await this.repository.updateByMarketplaceAndOrderId(marketplace, String(orderId), { status: 'in_assembly' });
        if (row) updated++;
      }
    } else {
      const { readData, writeData } = await import('../utils/storage.js');
      const data = await readData('orders');
      const orders = (data?.orders && [...data.orders]) || [];
      const set = new Set(orderIds.map(o => `${o.marketplace}|${o.orderId}`));
      let changed = false;
      for (const order of orders) {
        const key = `${order.marketplace}|${order.orderId}`;
        if (set.has(key)) {
          order.status = 'in_assembly';
          order.returnedToNewAt = null;
          updated++;
          changed = true;
        }
      }
      if (changed) await writeData('orders', { ...data, orders, lastSync: new Date().toISOString() });
    }
    return { sent: orderIds.length, updated };
  }

  /**
   * Отметить заказ как собранный: статус 'assembled', убирается из списка сборки.
   * Если у заказа есть orderGroupId — обновляются все заказы группы.
   * @param {string} marketplace
   * @param {string} orderId
   * @returns {Promise<object|null>} обновлённый заказ или null
   */
  async markOrderAsAssembled(marketplace, orderId, assembledByUserId = null) {
    if (!marketplace || orderId == null) return null;
    if (repositoryFactory.isUsingPostgreSQL()) {
      const order = await this.repository.findByMarketplaceAndOrderId(marketplace, String(orderId));
      if (!order) return null;
      const rows = order.orderGroupId ? await this.repository.findByOrderGroupId(order.orderGroupId) : [order];

      // 1) Ставим assembled (как раньше)
      if (order.orderGroupId) {
        await this.repository.markAssembledByOrderGroupId(order.orderGroupId, assembledByUserId);
      } else {
        await this.repository.markAssembledByMarketplaceAndOrderId(marketplace, String(orderId), assembledByUserId);
      }

      // 2) Фиксируем списание факта по собранным заказам в движениях остатков:
      // - снимаем резерв (unreserve) на зарезервированное количество
      // - делаем shipment (-qty) по складу заказа (если есть маппинг) или складу по умолчанию
      for (const r of rows) {
        const orderDbId = r?.id != null ? Number(r.id) : null;
        if (!orderDbId || !Number.isFinite(orderDbId)) continue;
        let productId = r.productId ?? r.product_id;
        if (!productId) productId = await this.resolveProductIdForAssemblyLine(r);
        productId = Number(productId);
        if (!Number.isFinite(productId) || productId < 1) continue;
        const qty = Math.max(1, parseInt(r.quantity, 10) || 1);
        const orderIdStr = String(r.orderId ?? r.order_id ?? orderId);

        const reservedForOrder = await this._getReservedQtyForOrder(orderDbId);
        const release = Math.min(qty, reservedForOrder);
        if (release > 0) {
          await stockMovementsService.applyChange(productId, {
            delta: release,
            type: 'unreserve',
            reason: `Сборка: снятие резерва по заказу ${orderIdStr}`.trim(),
            meta: { order_id: orderDbId, orderId: orderIdStr, assembled: true }
          });
        }

        const warehouseId = await this._resolveOwnWarehouseIdForOrder(r);
        await stockMovementsService.applyChange(productId, {
          delta: -qty,
          type: 'shipment',
          reason: `Сборка: отгрузка по заказу ${orderIdStr}`.trim(),
          meta: { order_id: orderDbId, orderId: orderIdStr, assembled: true, warehouse_id: warehouseId || null }
        });
      }

      return this.repository.findByMarketplaceAndOrderId(marketplace, String(orderId));
    }
    const { readData, writeData } = await import('../utils/storage.js');
    const data = await readData('orders');
    const orders = (data?.orders && [...data.orders]) || [];
    const key = `${marketplace}|${orderId}`;
    const order = orders.find(o => `${o.marketplace}|${o.orderId}` === key);
    if (!order) return null;
    order.status = 'assembled';
    order.returnedToNewAt = null;
    order.assembledAt = new Date().toISOString();
    order.assembledByUserId = assembledByUserId ?? null;
    await writeData('orders', { ...data, orders, lastSync: new Date().toISOString() });
    return order;
  }

  /**
   * Вернуть заказ в статус «Новый» (со сборки или «Собран»).
   * Если у заказа есть orderGroupId — обновляются все заказы группы.
   */
  async returnOrderToNew(marketplace, orderId) {
    if (!marketplace || orderId == null) return null;
    if (repositoryFactory.isUsingPostgreSQL()) {
      const order = await this.repository.findByMarketplaceAndOrderId(marketplace, String(orderId));
      if (!order) return null;
      if (order.orderGroupId) {
        const n = await this.repository.updateStatusByOrderGroupId(order.orderGroupId, 'new');
        if (n === 0) {
          await this.repository.updateByMarketplaceAndOrderId(marketplace, String(order.orderId ?? order.order_id), {
            status: 'new'
          });
        }
        return order;
      }
      return await this.repository.updateByMarketplaceAndOrderId(marketplace, String(orderId), { status: 'new' });
    }
    const { readData, writeData } = await import('../utils/storage.js');
    const data = await readData('orders');
    const orders = (data?.orders && [...data.orders]) || [];
    const key = `${marketplace}|${orderId}`;
    const order = orders.find(o => `${o.marketplace}|${o.orderId}` === key);
    if (!order) return null;
    order.status = 'new';
    order.returnedToNewAt = new Date().toISOString();
    await writeData('orders', { ...data, orders, lastSync: new Date().toISOString() });
    return order;
  }

  /**
   * Перевести заказ в статус «В закупке» (in_procurement). Разрешено только для заказов в статусе «Новый».
   * Если у заказа есть orderGroupId — обновляются все заказы группы.
   */
  async setOrderToProcurement(marketplace, orderId) {
    if (!marketplace || orderId == null) return null;
    if (repositoryFactory.isUsingPostgreSQL()) {
      const order = await this.repository.findByMarketplaceAndOrderId(marketplace, String(orderId));
      if (!order) return null;
      if (order.status !== 'new') return null;
      let rows = [order];
      if (order.orderGroupId) {
        rows = await this.repository.findByOrderGroupId(order.orderGroupId);
      }
      if (order.orderGroupId) {
        await this.repository.updateStatusByOrderGroupId(order.orderGroupId, 'in_procurement');
      } else {
        await this.repository.updateByMarketplaceAndOrderId(marketplace, String(orderId), { status: 'in_procurement' });
      }
      for (const row of rows) {
        const full = row?.id != null ? await this.repository.findById(row.id) : null;
        await this._applyReserveForOrderIfAbsent(full || row);
      }
      return order;
    }
    const { readData, writeData } = await import('../utils/storage.js');
    const data = await readData('orders');
    const orders = (data?.orders && [...data.orders]) || [];
    const key = `${marketplace}|${orderId}`;
    const order = orders.find(o => `${o.marketplace}|${o.orderId}` === key);
    if (!order) return null;
    if (order.status !== 'new') return null;
    order.status = 'in_procurement';
    order.returnedToNewAt = null;
    await writeData('orders', { ...data, orders, lastSync: new Date().toISOString() });
    return order;
  }

  /**
   * Отметить заказ как отгруженный: статус 'shipped'.
   * Если у заказа есть orderGroupId — обновляются все заказы группы.
   */
  async markOrderAsShipped(marketplace, orderId) {
    if (!marketplace || orderId == null) return null;
    if (repositoryFactory.isUsingPostgreSQL()) {
      const order = await this.repository.findByMarketplaceAndOrderId(marketplace, String(orderId));
      if (!order) return null;
      if (order.orderGroupId) {
        await this.repository.updateStatusByOrderGroupId(order.orderGroupId, 'shipped');
        return order;
      }
      return await this.repository.updateByMarketplaceAndOrderId(marketplace, String(orderId), { status: 'shipped' });
    }
    const { readData, writeData } = await import('../utils/storage.js');
    const data = await readData('orders');
    const orders = (data?.orders && [...data.orders]) || [];
    const key = `${marketplace}|${orderId}`;
    const order = orders.find(o => `${o.marketplace}|${o.orderId}` === key);
    if (!order) return null;
    order.status = 'shipped';
    order.returnedToNewAt = null;
    await writeData('orders', { ...data, orders, lastSync: new Date().toISOString() });
    return order;
  }

  _normalizeMarketplaceForCancel(marketplace) {
    let x = String(marketplace || '').toLowerCase();
    if (x === 'wb') return 'wildberries';
    if (x === 'ym' || x === 'yandexmarket') return 'yandex';
    return x;
  }

  /**
   * После отмены на стороне МП или локально: статус cancelled и снятие резерва по строкам группы.
   * @param {string} mpForRepo — marketplace как в БД (wildberries, ozon, …)
   * @param {string} oid — orderId строки, с которой вызывали отмену
   * @param {string} marketplaceStockLabel — подпись в движении остатков
   */
  async _finalizeMarketplaceCancellation(mpForRepo, oid, order, marketplaceStockLabel) {
    const label = marketplaceStockLabel || mpForRepo;
    if (repositoryFactory.isUsingPostgreSQL()) {
      const touchedProducts = new Set();
      if (order.orderGroupId) {
        await this.repository.updateStatusByOrderGroupId(order.orderGroupId, 'cancelled');
        const group = await this.repository.findByOrderGroupId(order.orderGroupId);
        if (Array.isArray(group)) {
          for (const row of group) {
            const pid = row.productId ?? row.product_id;
            if (pid) {
              const q = Math.max(1, parseInt(row.quantity, 10) || 1);
              const orderRowDbId = row?.id != null ? Number(row.id) : null;
              const metaOrderId = Number.isFinite(orderRowDbId) ? orderRowDbId : undefined;
              await stockMovementsService.applyChange(pid, {
                delta: q,
                type: 'unreserve',
                reason: `Снятие резерва: отмена заказа ${label} ${row.orderId ?? row.order_id}`,
                meta: { order_id: metaOrderId, orderId: row.orderId ?? row.order_id, marketplace: label }
              });
              touchedProducts.add(Number(pid));
            }
          }
        }
        // После снятия резерва: попробуем отдать освобождённый supply другим заказам в «В закупке».
        for (const p of touchedProducts) {
          await this.ensureReservesForProductIfSupplyAvailable(p);
        }
        return await this.repository.findByMarketplaceAndOrderId(mpForRepo, oid);
      }
      await this.repository.updateByMarketplaceAndOrderId(mpForRepo, oid, { status: 'cancelled' });
      const productId = order.productId ?? order.product_id;
      const qty = Math.max(1, parseInt(order.quantity, 10) || 1);
      if (productId) {
        const orderRowDbId = order?.id != null ? Number(order.id) : null;
        const metaOrderId = Number.isFinite(orderRowDbId) ? orderRowDbId : undefined;
        await stockMovementsService.applyChange(productId, {
          delta: qty,
          type: 'unreserve',
          reason: `Снятие резерва: отмена заказа ${label} ${oid}`,
          meta: { order_id: metaOrderId, orderId: oid, marketplace: label }
        });
        await this.ensureReservesForProductIfSupplyAvailable(productId);
      }
      return await this.repository.findByMarketplaceAndOrderId(mpForRepo, oid);
    }

    const { readData, writeData } = await import('../utils/storage.js');
    const data = await readData('orders');
    const orders = (data?.orders && [...data.orders]) || [];
    const normFileMp = m => {
      const x = String(m || '').toLowerCase();
      if (x === 'wb') return 'wildberries';
      return x;
    };
    const wantMp = normFileMp(mpForRepo);
    const idx = orders.findIndex(
      o => normFileMp(o.marketplace) === wantMp && String(o.orderId) === oid
    );
    if (idx < 0) {
      const err = new Error('Заказ не найден');
      err.statusCode = 404;
      throw err;
    }
    const g = orders[idx].orderGroupId;
    if (g) {
      for (const o of orders) {
        if (o.orderGroupId === g) o.status = 'cancelled';
      }
    } else {
      orders[idx].status = 'cancelled';
    }
    await writeData('orders', { ...data, orders, lastSync: new Date().toISOString() });
    return orders[idx];
  }

  /**
   * Отмена заказа: вызов API маркетплейса (если есть) и локальный статус «Отменён».
   */
  async cancelOrderOnMarketplace(marketplace, orderId) {
    const mp = this._normalizeMarketplaceForCancel(marketplace);
    if (orderId == null || String(orderId).trim() === '') {
      const err = new Error('Не указан номер заказа');
      err.statusCode = 400;
      throw err;
    }
    if (mp === 'wildberries') return this.cancelWildberriesOrder(marketplace, orderId);
    if (mp === 'ozon') return this._cancelOzonOrder(orderId);
    if (mp === 'yandex') return this._cancelYandexOrder(orderId);
    if (mp === 'manual') return this._cancelManualOrder(orderId);
    const err = new Error('Отмена заказа для этого маркетплейса не поддерживается');
    err.statusCode = 400;
    throw err;
  }

  async _cancelManualOrder(orderId) {
    const oid = String(orderId).trim();
    const order = await this.getByMarketplaceAndOrderId('manual', oid);
    if (!order) {
      const err = new Error('Заказ не найден');
      err.statusCode = 404;
      throw err;
    }
    const noCancel = ['delivered', 'cancelled', 'in_transit', 'shipped'];
    if (noCancel.includes(order.status)) {
      const err = new Error('Заказ в текущем статусе нельзя отменить');
      err.statusCode = 400;
      throw err;
    }
    return this._finalizeMarketplaceCancellation('manual', oid, order, 'manual');
  }

  async _cancelOzonOrder(orderId) {
    const oid = String(orderId).trim();
    const order = await this.getByMarketplaceAndOrderId('ozon', oid);
    if (!order) {
      const err = new Error('Заказ не найден');
      err.statusCode = 404;
      throw err;
    }
    const noCancel = ['delivered', 'cancelled', 'in_transit', 'shipped'];
    if (noCancel.includes(order.status)) {
      const err = new Error('Заказ в текущем статусе нельзя отменить через API Ozon');
      err.statusCode = 400;
      throw err;
    }
    const { marketplaces } = await integrationsService.getAllConfigs();
    const ozon = marketplaces?.ozon || {};
    const client_id = ozon?.client_id;
    const api_key = ozon?.api_key;
    if (!client_id || !api_key) {
      const err = new Error('Ozon API не настроен (client_id / api_key)');
      err.statusCode = 400;
      throw err;
    }
    const headers = {
      'Client-Id': String(client_id),
      'Api-Key': String(api_key),
      'Content-Type': 'application/json'
    };
    let reasonId = null;
    const reasonBodies = [
      { related_posting_numbers: [oid] },
      { posting_number: oid }
    ];
    for (const rb of reasonBodies) {
      const reasonRes = await fetch('https://api-seller.ozon.ru/v2/posting/fbs/cancel-reason/list', {
        method: 'POST',
        headers,
        body: JSON.stringify(rb)
      });
      if (!reasonRes.ok) continue;
      const pBody = await reasonRes.json().catch(() => ({}));
      const result = pBody?.result ?? pBody;
      const postings = result?.postings ?? result?.cancellation_reason_list ?? [];
      let list = [];
      if (Array.isArray(postings) && postings.length > 0 && postings[0]?.reasons) {
        const hit =
          postings.find(p => String(p.posting_number ?? p.postingNumber) === oid) || postings[0];
        list = hit?.reasons ?? [];
      } else {
        list = result?.cancel_reasons ?? result?.reasons ?? [];
      }
      const typeSeller = r => {
        const t = String(r?.type_id ?? r?.type ?? '').toLowerCase();
        return t === 'seller' || t.includes('seller');
      };
      const seller = list.find(typeSeller);
      const pick = seller || list[0];
      reasonId = pick?.id != null ? Number(pick.id) : null;
      if (reasonId != null && !Number.isNaN(reasonId)) break;
    }
    if (reasonId == null || Number.isNaN(reasonId)) {
      reasonId = 402;
    }
    const cancelRes = await fetch('https://api-seller.ozon.ru/v2/posting/fbs/cancel', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        posting_number: oid,
        cancel_reason_id: reasonId,
        cancel_reason_message: 'Отмена из ERM'
      })
    });
    if (!cancelRes.ok) {
      const text = await cancelRes.text();
      const err = new Error(`Ozon: отмена не удалась (${cancelRes.status}): ${text.substring(0, 400)}`);
      err.statusCode = 502;
      throw err;
    }
    return this._finalizeMarketplaceCancellation('ozon', oid, order, 'ozon');
  }

  async _cancelYandexOrder(orderId) {
    const oid = String(orderId).trim();
    const order = await this.getByMarketplaceAndOrderId('yandex', oid);
    if (!order) {
      const err = new Error('Заказ не найден');
      err.statusCode = 404;
      throw err;
    }
    const noCancel = ['delivered', 'cancelled', 'in_transit', 'shipped'];
    if (noCancel.includes(order.status)) {
      const err = new Error('Заказ в текущем статусе нельзя отменить через API Яндекс.Маркета');
      err.statusCode = 400;
      throw err;
    }
    const ymOrderRaw = order.orderGroupId || String(order.orderId ?? '').split(':')[0];
    const ymOrderNum = parseInt(String(ymOrderRaw).trim(), 10);
    if (Number.isNaN(ymOrderNum) || ymOrderNum < 1) {
      const err = new Error('Некорректный номер заказа Яндекс.Маркета');
      err.statusCode = 400;
      throw err;
    }
    const { marketplaces } = await integrationsService.getAllConfigs();
    const ymConfig = marketplaces?.yandex || {};
    const api_key = normalizeYandexApiKey(ymConfig?.api_key ?? ymConfig?.apiKey);
    if (!api_key) {
      const err = new Error('Не задан API-ключ Яндекс.Маркета');
      err.statusCode = 400;
      throw err;
    }
    const { orderGroups, campaignIds } = await getYandexBusinessAndCampaigns(ymConfig);
    const campaignsFlat = [];
    if (Array.isArray(orderGroups) && orderGroups.length > 0) {
      for (const g of orderGroups) {
        for (const c of g.campaignIds || []) campaignsFlat.push(Number(c));
      }
    } else if (Array.isArray(campaignIds)) {
      for (const c of campaignIds) campaignsFlat.push(Number(c));
    }
    const unique = [...new Set(campaignsFlat.filter(n => !Number.isNaN(n) && n > 0))];
    if (unique.length === 0) {
      const err = new Error('Не удалось определить campaign_id для Яндекс.Маркета (настройте интеграцию)');
      err.statusCode = 400;
      throw err;
    }
    const agent = getYandexHttpsAgent();
    let lastErr = null;
    for (const campaignId of unique) {
      const url = `https://api.partner.market.yandex.ru/v2/campaigns/${campaignId}/orders/${ymOrderNum}/status`;
      const response = await fetch(url, {
        method: 'PUT',
        headers: {
          'Api-Key': api_key,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify({
          order: { status: 'CANCELLED', substatus: 'SHOP_FAILED' }
        }),
        ...(agent && { agent })
      });
      if (response.ok) {
        return this._finalizeMarketplaceCancellation('yandex', oid, order, 'yandex');
      }
      const text = await response.text();
      lastErr = { status: response.status, text };
      if (response.status !== 404) {
        const err = new Error(`Яндекс.Маркет: отмена не удалась (${response.status}): ${text.substring(0, 400)}`);
        err.statusCode = response.status === 400 || response.status === 403 ? 400 : 502;
        throw err;
      }
    }
    const err = new Error(
      lastErr
        ? `Яндекс.Маркет: заказ ${ymOrderNum} не найден в доступных кампаниях (${lastErr.status})`
        : 'Яндекс.Маркет: не удалось отменить заказ'
    );
    err.statusCode = 404;
    throw err;
  }

  /**
   * Отменить заказ Wildberries на стороне МП (PATCH …/orders/{id}/cancel) и локально перевести в cancelled.
   */
  async cancelWildberriesOrder(marketplace, orderId) {
    const mpLower = (marketplace || '').toLowerCase();
    if (mpLower !== 'wildberries' && mpLower !== 'wb') {
      const err = new Error('Отмена на стороне маркетплейса доступна только для Wildberries');
      err.statusCode = 400;
      throw err;
    }
    if (orderId == null || String(orderId).trim() === '') {
      const err = new Error('Не указан номер заказа');
      err.statusCode = 400;
      throw err;
    }
    const oid = String(orderId).trim();
    const mpForRepo = mpLower === 'wb' || mpLower === 'wildberries' ? 'wildberries' : mpLower;
    const order = await this.getByMarketplaceAndOrderId(mpForRepo, oid);
    if (!order) {
      const err = new Error('Заказ не найден');
      err.statusCode = 404;
      throw err;
    }
    const noCancel = ['delivered', 'cancelled', 'in_transit', 'shipped'];
    if (noCancel.includes(order.status)) {
      const err = new Error('Заказ в текущем статусе нельзя отменить через API WB');
      err.statusCode = 400;
      throw err;
    }
    const { marketplaces } = await integrationsService.getAllConfigs();
    const apiKey = marketplaces?.wildberries?.api_key;
    if (!apiKey || String(apiKey).trim() === '') {
      const err = new Error('Не задан API-ключ Wildberries');
      err.statusCode = 400;
      throw err;
    }
    const numericId = parseInt(oid, 10);
    if (Number.isNaN(numericId)) {
      const err = new Error('Некорректный ID заказа WB');
      err.statusCode = 400;
      throw err;
    }
    const url = `https://marketplace-api.wildberries.ru/api/v3/orders/${numericId}/cancel`;
    const response = await fetch(url, {
      method: 'PATCH',
      headers: {
        Authorization: String(apiKey),
        'Content-Type': 'application/json',
        Accept: 'application/json'
      }
    });
    if (!response.ok) {
      const text = await response.text();
      const err = new Error(`WB: отмена заказа не удалась (${response.status}): ${text.substring(0, 400)}`);
      err.statusCode = 502;
      throw err;
    }

    return this._finalizeMarketplaceCancellation(mpForRepo, oid, order, 'wildberries');
  }

  /**
   * Удалить заказ. Если у заказа есть orderGroupId — удаляются все заказы группы.
   * @returns {Promise<number>} количество удалённых записей (0 если не найден)
   */
  async deleteOrder(marketplace, orderId) {
    if (!marketplace || orderId == null) return 0;
    if (repositoryFactory.isUsingPostgreSQL()) {
      const order = await this.repository.findByMarketplaceAndOrderId(marketplace, String(orderId));
      if (!order) return 0;
      if (order.orderGroupId) {
        // Важно: при удалении ручного заказа снимаем резерв по каждой строке группы,
        // иначе reserved_quantity и свободный остаток останутся "залипшими".
        try {
          const rows = await this.repository.findByOrderGroupId(order.orderGroupId);
          for (const r of rows || []) {
            await this.releaseReserveIfExistsForOrder(r.marketplace, r.orderId ?? r.order_id);
          }
        } catch {
          // ignore reserve rollback errors
        }
        return await this.repository.deleteByOrderGroupId(order.orderGroupId);
      }
      try {
        await this.releaseReserveIfExistsForOrder(marketplace, String(orderId));
      } catch {
        // ignore
      }
      const deleted = await this.repository.deleteByMarketplaceAndOrderId(marketplace, String(orderId));
      return deleted ? 1 : 0;
    }
    const { readData, writeData } = await import('../utils/storage.js');
    const data = await readData('orders');
    const orders = (data?.orders || []).filter(
      o => !(String(o.marketplace) === String(marketplace) && String(o.orderId) === String(orderId))
    );
    if (orders.length === data?.orders?.length) return 0;
    await writeData('orders', { ...data, orders, lastSync: new Date().toISOString() });
    return data.orders.length - orders.length;
  }

  /**
   * Строки заказа из локальной БД для карточки заказа (product_id → ссылка на каталог).
   */
  async getLocalLinesForOrderDetail(marketplace, orderId) {
    const oid = String(orderId ?? '').trim();
    if (!oid || !marketplace) return [];

    const mpUi = String(marketplace).toLowerCase();
    const sameMp = (oMp) => {
      const m = String(oMp || '').toLowerCase();
      if (mpUi === 'wildberries' || mpUi === 'wb') return m === 'wildberries' || m === 'wb';
      if (mpUi === 'yandex' || mpUi === 'ym' || mpUi === 'yandexmarket') {
        return m === 'yandex' || m === 'ym' || m === 'yandexmarket';
      }
      if (mpUi === 'ozon') return m === 'ozon';
      return m === mpUi;
    };

    const mapRow = (o) => ({
      orderLineId: o.orderId ?? o.order_id,
      productId: o.productId ?? o.product_id ?? null,
      offerId: o.offerId ?? o.offer_id ?? null,
      /** В PG для WB nmId приходит в sku (см. rowToCamel orders.repository.pg) */
      marketplaceSku: o.marketplaceSku ?? o.marketplace_sku ?? o.sku ?? null,
      productName: o.productName ?? o.product_name ?? null
    });

    const withResolvedProductIds = async (rawRows) => {
      const mapped = (rawRows || []).map(mapRow);
      for (let i = 0; i < mapped.length; i++) {
        const p = mapped[i].productId;
        if (p != null && String(p).trim() !== '') continue;
        const resolved = await this.resolveProductIdForAssemblyLine(rawRows[i]);
        if (resolved != null) mapped[i].productId = resolved;
      }
      return mapped;
    };

    if (repositoryFactory.isUsingPostgreSQL()) {
      let row = await this.repository.findByMarketplaceAndOrderId(marketplace, oid);
      if (!row) {
        const any = await this.repository.findAnyByOrderId(oid);
        if (any && sameMp(any.marketplace)) row = any;
      }
      if (!row) return [];
      const gid = row.orderGroupId ?? row.order_group_id;
      const rows = gid ? await this.repository.findByOrderGroupId(gid) : [row];
      return withResolvedProductIds(rows);
    }

    const all = await this.getAll();
    const orders = all.filter((o) => sameMp(o.marketplace));
    let row =
      orders.find((o) => String(o.orderId) === oid) ||
      orders.find((o) => String(o.orderGroupId || '') === oid) ||
      orders.find((o) => String(o.orderId || '').startsWith(`${oid}~`));
    if (!row) return [];
    const gid = row.orderGroupId || row.order_group_id;
    const rows = gid ? orders.filter((o) => String(o.orderGroupId || '') === String(gid)) : [row];
    return withResolvedProductIds(rows);
  }
}

export default new OrdersService();


