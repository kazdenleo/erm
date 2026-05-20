/**
 * Orders Service
 * Бизнес-логика для работы с заказами
 */

import fetch from 'node-fetch';
import { query } from '../config/database.js';
import repositoryFactory from '../config/repository-factory.js';
import stockMovementsService from './stockMovements.service.js';
import {
  isKitProductId,
  applyKitOrderReserve,
  computeMaxKitUnitsReservable,
  computeKitReservableBreakdown,
  allocateKitReservePriority,
  getReservedKitUnitsForOrder,
  releaseAllReservesForOrder,
  findKitProductIdForMarketplaceOrder,
  getKitComponents,
  readKitPhysicalOnHandFromDb,
  sumKitComponentQtyPerKit,
  buildKitComponentQtyMap,
  getComponentAssemblableUnits
} from './kitStock.service.js';
import integrationsService from './integrations.service.js';
import { getYandexBusinessAndCampaigns, normalizeYandexApiKey } from './orders.sync.service.js';
import { getYandexHttpsAgent } from '../utils/yandex-https-agent.js';
import { ozonPostingNumberFromOrderId } from '../utils/ozonPosting.js';

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

/** Статусы, при которых резерв по товарам недопустим (синхронизация МП, отмена, отгрузка). */
export const ORDER_TERMINAL_NO_RESERVE_STATUSES = new Set([
  'cancelled',
  'canceled',
  'shipped',
  'delivered',
  'in_transit'
]);

export function isOrderTerminalNoReserve(status) {
  return ORDER_TERMINAL_NO_RESERVE_STATUSES.has(String(status || '').trim().toLowerCase());
}

function marketplaceFromOrdersDb(dbMarketplace) {
  const m = String(dbMarketplace || '').toLowerCase();
  if (m === 'wb') return 'wildberries';
  if (m === 'ym') return 'yandex';
  return m === 'ozon' ? 'ozon' : m;
}

/** Перевод в «В закупке»: не только strict `new` — у WB допускаем pending/unknown до резолва статуса. */
export function orderEligibleForProcurement(order) {
  if (!order) return false;
  const sNorm = String(order.status ?? '').trim().toLowerCase();
  if (sNorm === 'new') return true;
  const sRaw = String(order.status ?? '').trim();
  const mp = String(order.marketplace ?? '').toLowerCase();
  if (mp === 'wildberries' || mp === 'wb') {
    return sRaw === '__wb_status_pending__' || sNorm === 'wb_status_unknown';
  }
  return false;
}

/** Числовой orders.id для meta.order_id; Pg отдаёт bigint как string/BigInt — иначе резерв не попадает в выборку списка заказов. */
function orderRowDbId(row) {
  const rid = row?.id;
  if (rid == null) return null;
  if (typeof rid === 'bigint') {
    const n = Number(rid);
    return Number.isSafeInteger(n) && n >= 1 ? n : null;
  }
  const n = typeof rid === 'number' ? rid : parseInt(String(rid), 10);
  if (!Number.isFinite(n) || n < 1) return null;
  return n;
}

class OrdersService {
  constructor() {
    this.repository = repositoryFactory.getOrdersRepository();
  }

  _marketplaceToOrdersDb(marketplace) {
    return marketplaceToOrdersDb(marketplace);
  }

  /**
   * Проверка перед «На сборку»: можно ли собирать заказ по правилу "есть фактически зарезервированный товар".
   *
   * Требование интерпретируем строго:
   * - по заказу должен быть резерв в stock_movements (reserved_qty >= quantity)
   * - общий резерв товара должен быть покрыт фактическим остатком (products.quantity >= products.reserved_quantity),
   *   т.е. резерв не опирается на incoming_quantity.
   *
   * @param {Array<{ marketplace: string, orderId: string }>} orderIds
   * @returns {Promise<{ ok: Array, blocked: Array<{ marketplace: string, orderId: string, reason: string }> }>}
   */
  async validateReservedStockForAssembly(orderIds, { profileId = null } = {}) {
    const refs = Array.isArray(orderIds) ? orderIds : [];
    if (!repositoryFactory.isUsingPostgreSQL()) {
      return { ok: refs, blocked: [] };
    }
    if (refs.length === 0) return { ok: [], blocked: [] };

    const values = [];
    const params = [];
    let i = 1;
    for (const o of refs) {
      const mp = this._marketplaceToOrdersDb(o?.marketplace);
      const oid = o?.orderId != null ? String(o.orderId) : '';
      if (!mp || !oid.trim()) continue;
      values.push(`($${i++}, $${i++})`);
      params.push(mp, oid.trim());
    }
    if (values.length === 0) return { ok: [], blocked: [] };

    const pid = profileId != null && String(profileId).trim() !== '' ? Number(profileId) : null;
    const profileFilterSql = pid && Number.isFinite(pid) ? `AND o.profile_id = ${pid}` : '';

    const q = await query(
      `
      WITH refs(marketplace, order_id) AS (
        VALUES ${values.join(',\n')}
      ),
      ord AS (
        SELECT o.id,
               o.marketplace,
               o.order_id,
               o.quantity,
               o.product_id,
               o.offer_id,
               o.marketplace_sku,
               o.product_name
        FROM refs r
        JOIN orders o
          ON o.marketplace = r.marketplace
         AND o.order_id = r.order_id
        ${profileFilterSql}
      ),
      res AS (
        SELECT (sm.meta->>'order_id')::bigint AS oid,
          GREATEST(
            0,
            COALESCE(SUM(CASE WHEN sm.type = 'reserve' THEN -sm.quantity_change ELSE 0 END), 0)
            - COALESCE(SUM(CASE WHEN sm.type = 'unreserve' THEN sm.quantity_change ELSE 0 END), 0)
          )::int AS reserved_qty
        FROM stock_movements sm
        WHERE (sm.type = 'reserve' OR sm.type = 'unreserve')
          AND sm.meta ? 'order_id'
        GROUP BY (sm.meta->>'order_id')::bigint
      )
      SELECT
        o.id AS order_db_id,
        o.marketplace,
        o.order_id,
        COALESCE(o.quantity, 1)::int AS order_qty,
        COALESCE(r.reserved_qty, 0)::int AS reserved_qty,
        o.product_id,
        o.offer_id,
        o.marketplace_sku,
        o.product_name,
        p.id AS joined_product_id,
        p.product_type,
        COALESCE(p.quantity, 0)::int AS product_qty,
        COALESCE(p.reserved_quantity, 0)::int AS product_reserved_qty
      FROM ord o
      LEFT JOIN res r ON r.oid = o.id::bigint
      LEFT JOIN products p ON p.id = o.product_id
      `,
      params
    );

    const byKey = new Map();
    for (const row of q.rows || []) {
      byKey.set(`${row.marketplace}|${row.order_id}`, row);
    }

    const ok = [];
    const blocked = [];
    const productCache = new Map(); // productId -> { qty, reserved }
    for (const o of refs) {
      const mp = this._marketplaceToOrdersDb(o?.marketplace);
      const oid = o?.orderId != null ? String(o.orderId).trim() : '';
      if (!mp || !oid) continue;
      const row = byKey.get(`${mp}|${oid}`);
      if (!row) {
        blocked.push({ marketplace: o.marketplace, orderId: oid, reason: 'заказ не найден' });
        continue;
      }
      const need = Number(row.order_qty) || 1;
      const resQty = Number(row.reserved_qty) || 0;
      const orderDbId = row.order_db_id != null ? Number(row.order_db_id) : null;
      let prodId = row.product_id != null ? Number(row.product_id) : null;
      let prodQty = Number(row.product_qty) || 0;
      let prodRes = Number(row.product_reserved_qty) || 0;

      // Если product_id в orders ещё не заполнен, пытаемся сопоставить через product_skus (как в UI).
      if (!prodId || !Number.isFinite(prodId) || prodId < 1) {
        try {
          const resolved = await this._resolveProductIdForOrderStock({
            marketplace: row.marketplace,
            offerId: row.offer_id,
            offer_id: row.offer_id,
            sku: row.marketplace_sku,
            marketplace_sku: row.marketplace_sku,
            productName: row.product_name,
            product_name: row.product_name,
            productId: row.product_id
          });
          const rid = resolved != null ? Number(resolved) : null;
          if (rid && Number.isFinite(rid) && rid > 0) {
            prodId = rid;
            if (productCache.has(prodId)) {
              const c = productCache.get(prodId);
              prodQty = c.qty;
              prodRes = c.reserved;
            } else {
              const pr = await query(
                `SELECT COALESCE(quantity, 0)::int AS quantity,
                        COALESCE(reserved_quantity, 0)::int AS reserved_quantity
                 FROM products
                 WHERE id = $1
                 LIMIT 1`,
                [prodId]
              );
              const prow = pr.rows?.[0] || {};
              prodQty = Number(prow.quantity) || 0;
              prodRes = Number(prow.reserved_quantity) || 0;
              productCache.set(prodId, { qty: prodQty, reserved: prodRes });
            }
          }
        } catch {
          // ignore
        }
      }

      if (!prodId || !Number.isFinite(prodId) || prodId < 1) {
        blocked.push({ marketplace: o.marketplace, orderId: oid, reason: 'не определён товар (product_id)' });
        continue;
      }
      const reservedForLine =
        orderDbId && Number.isFinite(orderDbId) && (await isKitProductId(prodId))
          ? await getReservedKitUnitsForOrder(prodId, orderDbId)
          : resQty;
      if (reservedForLine < need) {
        blocked.push({
          marketplace: o.marketplace,
          orderId: oid,
          reason: `нет резерва под заказ (зарезервировано: ${reservedForLine}, нужно: ${need})`
        });
        continue;
      }
      if (!(await isKitProductId(prodId)) && prodQty < prodRes) {
        blocked.push({
          marketplace: o.marketplace,
          orderId: oid,
          reason: `резерв товара не покрыт фактическим остатком (факт: ${prodQty}, общий резерв: ${prodRes})`
        });
        continue;
      }
      ok.push(o);
    }

    return { ok, blocked };
  }

  async setAssemblyStickerNumber(marketplace, orderId, stickerNumber, profileId = null) {
    if (!repositoryFactory.isUsingPostgreSQL()) return null;
    if (!marketplace || orderId == null) return null;
    if (typeof this.repository.setAssemblyStickerNumberByMarketplaceAndOrderId !== 'function') return null;
    return await this.repository.setAssemblyStickerNumberByMarketplaceAndOrderId(
      marketplace,
      String(orderId),
      stickerNumber,
      profileId
    );
  }

  /**
   * Если зарезервировано больше, чем покрывает остаток + «в пути», снимаем лишнее с заказов
   * (сначала с самых новых по created_at).
   * Вызывается: из stockMovements.applyChange (списание, отгрузка, приёмка, ручные движения и т.д.),
   * после инвентаризации; для отката приёмки/удаления закупки в purchases.service — отдельно (там прямой SQL в БД).
   */
  async trimExcessReservesForProduct(productId, { reason = null, meta = {} } = {}) {
    if (!repositoryFactory.isUsingPostgreSQL()) return { released: 0, ordersTouched: 0 };
    const pid = Number(productId);
    if (!Number.isFinite(pid) || pid < 1) return { released: 0, ordersTouched: 0 };

    const pr = await query(
      `SELECT COALESCE(quantity, 0)::bigint AS quantity,
              COALESCE(incoming_quantity, 0)::bigint AS incoming_quantity,
              COALESCE(reserved_quantity, 0)::bigint AS reserved_quantity
       FROM products WHERE id = $1`,
      [pid]
    );
    const row = pr.rows?.[0];
    if (!row) return { released: 0, ordersTouched: 0 };
    const qty = Number(row.quantity) || 0;
    const incoming = Number(row.incoming_quantity) || 0;
    const reserved = Number(row.reserved_quantity) || 0;
    const supplyCap = qty + incoming;
    let excess = reserved - supplyCap;
    if (excess <= 0) return { released: 0, ordersTouched: 0 };

    const ordRes = await query(
      `WITH nets AS (
         SELECT (sm.meta->>'order_id')::bigint AS oid,
           GREATEST(0,
             COALESCE(SUM(CASE WHEN sm.type = 'reserve' THEN -sm.quantity_change ELSE 0 END), 0) -
             COALESCE(SUM(CASE WHEN sm.type = 'unreserve' THEN sm.quantity_change ELSE 0 END), 0)
           )::int AS net_r
         FROM stock_movements sm
         WHERE sm.product_id = $1
           AND (sm.type = 'reserve' OR sm.type = 'unreserve')
           AND sm.meta ? 'order_id'
         GROUP BY (sm.meta->>'order_id')::bigint
       )
       SELECT o.id AS order_row_id, o.order_id, o.marketplace, n.net_r
       FROM nets n
       JOIN orders o ON o.id = n.oid
       WHERE n.net_r > 0
       ORDER BY o.created_at DESC NULLS LAST, o.id DESC`,
      [pid]
    );

    let released = 0;
    let ordersTouched = 0;
    const baseReason = reason || 'Снятие избыточного резерва (недостаточно остатка и «в пути»)';
    for (const orow of ordRes.rows || []) {
      if (excess <= 0) break;
      const orderDbId = Number(orow.order_row_id);
      const netForOrder = Number(orow.net_r) || 0;
      if (netForOrder <= 0 || !Number.isFinite(orderDbId)) continue;
      const unreserveQty = Math.min(netForOrder, excess);
      const orderIdStr = String(orow.order_id ?? '');
      await stockMovementsService.applyChange(pid, {
        delta: unreserveQty,
        type: 'unreserve',
        reason: baseReason,
        meta: {
          order_id: orderDbId,
          orderId: orderIdStr,
          trim_excess: true,
          marketplace: orow.marketplace ?? null,
          ...meta
        }
      });
      released += unreserveQty;
      excess -= unreserveQty;
      ordersTouched++;
    }
    return { released, ordersTouched };
  }

  /**
   * Обеспечить резерв по заказу (если заказ существует и в статусе in_procurement).
   * Используется, когда закупка уже создана/переведена в ordered и incoming должен быть "в резерве" под заказы.
   */
  async ensureReserveForOrderIfInProcurement(marketplace, orderId, { profileId = null } = {}) {
    if (!repositoryFactory.isUsingPostgreSQL()) return;
    if (!marketplace || orderId == null) return;
    const order = await this.repository.findByMarketplaceAndOrderId(
      marketplace,
      String(orderId),
      profileId
    );
    if (!order) return;
    if (String(order.status || '').toLowerCase() !== 'in_procurement') return;
    await this._reapplyReserveForOrderRows([order]);
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

  /**
   * Попытка резерва при появлении/синхронизации заказа или остатка.
   * Раньше: при любом уже существующем резерве или при maxKits < qty для комплекта выходили без дозаполнения.
   */
  async _reserveForOrderIfStockAvailable(orderRow) {
    if (!repositoryFactory.isUsingPostgreSQL() || !orderRow) return;
    await this._applyReserveForOrderIfAbsent(orderRow);
  }

  /**
   * Установить резерв по заказу: уменьшить доступный остаток и записать движение в историю.
   * Для комплекта: целые — резерв на SKU комплекта; из деталей — на комплектующие.
   */
  async _applyReserveForOrder(productId, quantity, orderId, meta = {}) {
    if (!productId || quantity < 1) return;
    const qtyWanted = Math.max(1, parseInt(quantity, 10) || 1);

    if (await isKitProductId(productId)) {
      await applyKitOrderReserve(
        productId,
        qtyWanted,
        orderId,
        meta,
        (compId, compQty, oid, m) =>
          this._applyReserveForOrderComponent(compId, compQty, oid, m)
      );
      return;
    }

    await this._applyReserveForOrderComponent(productId, qtyWanted, orderId, meta);
  }

  /** Резерв одной позиции: PWS + в пути − резерв (без остатков поставщиков); у комплекта — + собираемость из комплектующих. */
  async _applyReserveForOrderComponent(productId, quantity, orderId, meta = {}) {
    if (!productId || quantity < 1) return;
    const qtyWanted = Math.max(1, parseInt(quantity, 10) || 1);

    let availableSupply;
    let qty;
    if (await isKitProductId(productId)) {
      const pre = meta?.kit_reserve_preallocated;
      if (pre != null && Number(pre) > 0) {
        qty = Math.min(qtyWanted, Math.floor(Number(pre)));
      } else {
        const breakdown = await computeKitReservableBreakdown(productId, {
          warehouseId: meta?.warehouse_id ?? meta?.warehouseId ?? null
        });
        const alloc = allocateKitReservePriority(qtyWanted, breakdown);
        qty = alloc.kitsToReserve;
      }
    } else if (meta?.kit_product_id) {
      // Уже проверено в applyKitOrderReserve (собираемость из комплектующих).
      qty = qtyWanted;
    } else {
      const wh = meta?.warehouse_id ?? meta?.warehouseId ?? null;
      availableSupply = await getComponentAssemblableUnits(productId, { warehouseId: wh });
      qty = Math.min(qtyWanted, Math.floor(availableSupply));
    }
    if (qty <= 0) return;

    const orderDbIdRaw = meta?.order_id ?? meta?.orderId;
    const orderDbId =
      orderDbIdRaw != null && String(orderDbIdRaw).trim() !== ''
        ? Number(orderDbIdRaw)
        : null;
    if (Number.isFinite(orderDbId) && orderDbId > 0) {
      const alreadyForOrder = await this._getReservedQtyForOrderProduct(orderDbId, productId);
      if (alreadyForOrder >= qtyWanted) return;
      qty = Math.min(qty, qtyWanted - alreadyForOrder);
      if (qty <= 0) return;
    }

    const reasonBase = `Резерв по заказу ${orderId || ''}`.trim() || 'Резерв';
    const fromWhole = Number(meta?.kit_reserve_from_whole) || 0;
    const fromComp = Number(meta?.kit_reserve_from_components) || 0;
    const kitUnits = Number(meta?.kit_units) || fromComp || 0;
    let reason = reasonBase;
    if (fromWhole > 0 && fromComp > 0) {
      reason = `${reasonBase} (${fromWhole} целым SKU, ${fromComp} из комплектующих)`;
    } else if (fromWhole > 0) {
      reason = `${reasonBase} (целым SKU: ${fromWhole})`;
    } else if (meta?.kit_product_id && kitUnits > 0) {
      reason = `${reasonBase} (комплектующие, ${kitUnits} компл.)`;
    }

    await stockMovementsService.applyChange(productId, {
      delta: -qty,
      type: 'reserve',
      reason,
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

  /** Нетто-резерв под заказ по конкретному товару (для комплектующих). */
  async _getReservedQtyForOrderProduct(orderDbId, productId) {
    if (!orderDbId || !productId || !repositoryFactory.isUsingPostgreSQL()) return 0;
    const oid = Number(orderDbId);
    const pid = Number(productId);
    if (!Number.isFinite(oid) || !Number.isFinite(pid)) return 0;
    const r = await query(
      `SELECT
         COALESCE(SUM(CASE WHEN type = 'reserve' THEN -quantity_change ELSE 0 END), 0)::int AS reserved,
         COALESCE(SUM(CASE WHEN type = 'unreserve' THEN quantity_change ELSE 0 END), 0)::int AS unreserved
       FROM stock_movements
       WHERE product_id = $2
         AND (type = 'reserve' OR type = 'unreserve')
         AND (meta->>'order_id')::bigint = $1::bigint`,
      [oid, pid]
    );
    const row = r.rows?.[0];
    const reserved = row?.reserved != null ? Number(row.reserved) : 0;
    const unreserved = row?.unreserved != null ? Number(row.unreserved) : 0;
    return Math.max(0, reserved - unreserved);
  }

  /** Уже списано по заказу и товару (для идемпотентности отгрузки). */
  async _getShippedQtyForOrderProduct(orderDbId, productId) {
    if (!orderDbId || !productId || !repositoryFactory.isUsingPostgreSQL()) return 0;
    const oid = Number(orderDbId);
    const pid = Number(productId);
    if (!Number.isFinite(oid) || !Number.isFinite(pid)) return 0;
    const r = await query(
      `SELECT COALESCE(SUM(CASE WHEN type = 'shipment' THEN -quantity_change ELSE 0 END), 0)::int AS shipped
       FROM stock_movements
       WHERE product_id = $2
         AND type = 'shipment'
         AND (meta->>'order_id')::bigint = $1::bigint`,
      [oid, pid]
    );
    return Math.max(0, Number(r.rows?.[0]?.shipped) || 0);
  }

  /** Найти заказ с учётом profile_id (как при закрытии поставки). */
  async _findOrderByMarketplaceAndOrderId(marketplace, orderId, profileId = null) {
    let order = await this.repository.findByMarketplaceAndOrderId(
      marketplace,
      String(orderId),
      profileId
    );
    if (!order && profileId != null) {
      order = await this.repository.findByMarketplaceAndOrderId(marketplace, String(orderId), null);
    }
    return order;
  }

  /** product_id с ненулевым резервом по строке заказа (orders.id). */
  async _getReservedProductIdsForOrder(orderDbId) {
    if (!orderDbId || !repositoryFactory.isUsingPostgreSQL()) return [];
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
    return (r.rows || [])
      .map((row) => Number(row.product_id))
      .filter((n) => Number.isFinite(n) && n > 0);
  }

  async _assemblyMetaForOrderRow(orderRow) {
    const orderDbId = orderRowDbId(orderRow);
    const orderIdStr = String(orderRow.orderId ?? orderRow.order_id ?? '').trim();
    const warehouseId = await this._resolveOwnWarehouseIdForOrder(orderRow);
    return {
      order_id: orderDbId,
      orderId: orderIdStr,
      assembled: true,
      warehouse_id: warehouseId || null
    };
  }

  /**
   * Сколько списать/снять с резерва по product_id (комплектующие — qty × perKit, иначе max(orderQty, net)).
   */
  async _resolveShipmentQtyForOrderProduct(orderRow, productId) {
    const pid = Number(productId);
    const orderQty = Math.max(1, parseInt(orderRow.quantity, 10) || 1);
    if (!Number.isFinite(pid) || pid < 1) return orderQty;

    let kitId = await this._resolveProductIdForOrderStock(orderRow);
    if (kitId != null && !(await isKitProductId(kitId))) kitId = null;
    if (kitId == null) {
      const bySku = await findKitProductIdForMarketplaceOrder(0, orderRow);
      if (bySku != null && (await isKitProductId(bySku))) kitId = bySku;
    }
    if (kitId == null) {
      const byLine = await findKitProductIdForMarketplaceOrder(pid, orderRow);
      if (byLine != null && (await isKitProductId(byLine))) kitId = byLine;
    }

    if (kitId != null) {
      const components = await getKitComponents(kitId);
      const perKitTotal = sumKitComponentQtyPerKit(components, pid);
      if (perKitTotal > 0) {
        return orderQty * perKitTotal;
      }
    }

    const orderDbId = orderRowDbId(orderRow);
    if (orderDbId) {
      const net = await this._getReservedQtyForOrderProduct(orderDbId, pid);
      if (net > 0) return Math.max(orderQty, net);
    }
    return orderQty;
  }

  /**
   * Снять резерв и списать наличие по одному product_id (строка заказа).
   * @param {number|null} targetQty — сколько списать; по умолчанию — из состава комплекта или резерва.
   */
  async _applyAssemblyStockForOrderProduct(orderRow, productId, targetQty = null) {
    if (!repositoryFactory.isUsingPostgreSQL() || !orderRow || !productId) return;
    const orderDbId = orderRowDbId(orderRow);
    if (!orderDbId) return;

    const pid = Number(productId);
    if (!Number.isFinite(pid) || pid < 1) return;

    const metaBase = await this._assemblyMetaForOrderRow(orderRow);
    const orderIdStr = metaBase.orderId || '';
    const lineQty =
      targetQty != null
        ? Math.max(0, parseInt(targetQty, 10) || 0)
        : await this._resolveShipmentQtyForOrderProduct(orderRow, pid);
    if (lineQty <= 0) return;

    const net = await this._getReservedQtyForOrderProduct(orderDbId, pid);
    const alreadyShipped = await this._getShippedQtyForOrderProduct(orderDbId, pid);
    const shipQty = Math.max(0, lineQty - alreadyShipped);

    if (net > 0 && shipQty > 0) {
      const release = Math.min(shipQty, net);
      await stockMovementsService.applyChange(pid, {
        delta: release,
        type: 'unreserve',
        reason: `Отгрузка: снятие резерва по заказу ${orderIdStr}`.trim(),
        meta: metaBase
      });
    }

    if (shipQty > 0) {
      await stockMovementsService.applyChange(pid, {
        delta: -shipQty,
        type: 'shipment',
        reason: `Отгрузка: списание наличия по заказу ${orderIdStr}`.trim(),
        meta: metaBase
      });
    }
  }

  /**
   * Комплект: снять резерв с SKU комплекта (если был), списать целые комплекты со склада
   * и списать комплектующие по составу.
   */
  async _applyAssemblyStockForKitOrder(orderRow, kitProductId) {
    const kitId = Number(kitProductId);
    if (!Number.isFinite(kitId) || kitId < 1) return;

    const orderDbId = orderRowDbId(orderRow);
    if (!orderDbId) return;

    const kitQty = Math.max(1, parseInt(orderRow.quantity, 10) || 1);
    const metaBase = await this._assemblyMetaForOrderRow(orderRow);
    const warehouseId = metaBase.warehouse_id ?? null;

    const kitNet = await this._getReservedQtyForOrderProduct(orderDbId, kitId);
    const kitShipped = await this._getShippedQtyForOrderProduct(orderDbId, kitId);
    const kitsToFulfill = Math.max(0, kitQty - kitShipped);

    if (kitNet > 0) {
      const release = kitsToFulfill > 0 ? Math.min(kitsToFulfill, kitNet) : kitNet;
      await stockMovementsService.applyChange(kitId, {
        delta: release,
        type: 'unreserve',
        reason: `Отгрузка: снятие резерва комплекта по заказу ${metaBase.orderId}`.trim(),
        meta: metaBase
      });
    }

    const physicalWhole = await readKitPhysicalOnHandFromDb(kitId, null, {
      warehouseId
    });
    const wholeShipQty = Math.min(kitsToFulfill, physicalWhole);
    if (wholeShipQty > 0) {
      await stockMovementsService.applyChange(kitId, {
        delta: -wholeShipQty,
        type: 'shipment',
        reason: `Отгрузка: списание комплекта (1 SKU) по заказу ${metaBase.orderId}`.trim(),
        meta: metaBase
      });
    }

    const components = await getKitComponents(kitId);
    const compQtyMap = buildKitComponentQtyMap(components, kitQty);
    for (const [compId, compQty] of compQtyMap) {
      await this._applyAssemblyStockForOrderProduct(orderRow, compId, compQty);
    }
  }

  /**
   * Закрытие поставки / сборка: снять резерв и уменьшить наличие.
   * Комплект — резерв может быть на SKU комплекта и/или на комплектующих; списание — с комплектующих.
   */
  async _applyAssemblyStockForOrderRow(orderRow) {
    if (!repositoryFactory.isUsingPostgreSQL() || !orderRow) return;
    const orderDbId = orderRowDbId(orderRow);
    if (!orderDbId) return;

    const reservedProductIds = await this._getReservedProductIdsForOrder(orderDbId);
    if (reservedProductIds.length > 0) {
      const kitIds = [];
      const componentOnly = [];
      for (const pid of reservedProductIds) {
        if (await isKitProductId(pid)) kitIds.push(pid);
        else componentOnly.push(pid);
      }
      const skipComponentIds = new Set();
      for (const kitId of kitIds) {
        const comps = await getKitComponents(kitId);
        for (const c of comps) skipComponentIds.add(c.component_product_id);
      }
      for (const pid of componentOnly) {
        if (!skipComponentIds.has(pid)) {
          const shipQty = await this._resolveShipmentQtyForOrderProduct(orderRow, pid);
          await this._applyAssemblyStockForOrderProduct(orderRow, pid, shipQty);
        }
      }
      for (const kitId of kitIds) {
        await this._applyAssemblyStockForKitOrder(orderRow, kitId);
      }
      return;
    }

    const productId = await this._resolveProductIdForOrderStock(orderRow);
    if (!productId) return;

    if (await isKitProductId(productId)) {
      await this._applyAssemblyStockForKitOrder(orderRow, productId);
      return;
    }

    await this._applyAssemblyStockForOrderProduct(orderRow, productId);
  }

  /**
   * При закрытии поставки FBS: снять резерв и списать наличие по заказам «Собран» / «Отгружен».
   * Несобранные и отменённые обрабатываются до вызова (см. closeShipment).
   */
  async applyAssemblyStockForShipmentOrders(marketplace, orderIds, profileId = null) {
    if (!repositoryFactory.isUsingPostgreSQL() || !marketplace || !Array.isArray(orderIds)) {
      return { processed: 0, stockOnly: 0, skipped: 0, notFound: 0 };
    }
    const mp = String(marketplace).trim();
    let processed = 0;
    let stockOnly = 0;
    let skipped = 0;
    let notFound = 0;

    for (const rawOid of orderIds) {
      const orderId = String(rawOid).trim();
      if (!orderId) continue;
      try {
        const order = await this._findOrderByMarketplaceAndOrderId(mp, orderId, profileId);
        if (!order) {
          notFound += 1;
          continue;
        }
        const status = String(order.status || '').toLowerCase();
        if (status === 'cancelled') {
          skipped += 1;
          continue;
        }
        if (status !== 'assembled' && status !== 'shipped') {
          skipped += 1;
          continue;
        }

        const rows = order.orderGroupId
          ? await this.repository.findByOrderGroupId(order.orderGroupId, profileId)
          : [order];

        for (const r of rows) {
          await this._applyAssemblyStockForOrderRow(r);
        }
        processed += 1;
        stockOnly += 1;
      } catch (e) {
        console.warn('[Orders] applyAssemblyStockForShipmentOrders:', orderId, e?.message || e);
      }
    }

    return { processed, stockOnly, skipped, notFound };
  }

  /** Резерв для строки заказа из БД: частичный резерв и дозаполнение до qty при появлении остатка. */
  async _applyReserveForOrderIfAbsent(orderRow) {
    if (!repositoryFactory.isUsingPostgreSQL() || !orderRow) return;
    if (isOrderTerminalNoReserve(orderRow.status)) return;
    const id = orderRowDbId(orderRow);
    const orderIdStr = String(orderRow.orderId ?? orderRow.order_id ?? '').trim();
    const qty = Math.max(1, parseInt(orderRow.quantity, 10) || 1);
    if (!id) return;
    const productId = await this._resolveProductIdForOrderStock(orderRow);
    if (!productId) return;
    const warehouseId = await this._resolveOwnWarehouseIdForOrder(orderRow);

    // Частичный резерв:
    // - резервируем только то, что уже есть (факт + ожидается - уже зарезервировано)
    // - если пришла часть товара, резервируем эту часть, даже если до количества заказа не хватает
    if (await isKitProductId(productId)) {
      const alreadyReservedKits = await getReservedKitUnitsForOrder(productId, id);
      const need = Math.max(0, qty - alreadyReservedKits);
      if (need <= 0) return;
      const maxKits = await this._computeMaxKitUnitsReservableForOrder(productId, warehouseId);
      const reserveKits = Math.min(need, maxKits);
      if (reserveKits <= 0) return;
      await applyKitOrderReserve(
        productId,
        reserveKits,
        orderIdStr || String(id),
        {
          order_id: id,
          orderId: orderIdStr,
          warehouse_id: warehouseId,
          partial: reserveKits < need
        },
        (compId, compQty, oid, m) =>
          this._applyReserveForOrderComponent(compId, compQty, oid, m)
      );
      return;
    }

    const alreadyReservedForOrder = await this._getReservedQtyForOrderProduct(id, productId);
    const need = Math.max(0, qty - alreadyReservedForOrder);
    if (need <= 0) return;

    const availableSupply = await getComponentAssemblableUnits(productId, { warehouseId });
    const reserveNow = Math.min(need, Math.floor(availableSupply));
    if (reserveNow <= 0) return;

    await this._applyReserveForOrder(productId, reserveNow, orderIdStr || String(id), {
      order_id: id,
      orderId: orderIdStr,
      warehouse_id: warehouseId,
      partial: reserveNow < need
    });
  }

  /**
   * Снять резерв по всем заказам в терминальных статусах (отменён / отгружен / …), где в журнале ещё есть нетто-резерв.
   */
  async releaseReservesForTerminalStatusOrders({ profileId = null } = {}) {
    if (!repositoryFactory.isUsingPostgreSQL()) return { released: 0 };
    const statuses = [...ORDER_TERMINAL_NO_RESERVE_STATUSES];
    const params = [statuses];
    let sql = `
      SELECT o.id, o.marketplace, o.order_id
      FROM orders o
      WHERE LOWER(TRIM(COALESCE(o.status, ''))) = ANY($1::text[])`;
    if (profileId != null && profileId !== '') {
      const pid = typeof profileId === 'string' ? parseInt(profileId, 10) : Number(profileId);
      if (Number.isFinite(pid) && pid > 0) {
        sql += ` AND o.profile_id = $2::bigint`;
        params.push(pid);
      }
    }
    const r = await query(sql, params);
    let released = 0;
    for (const row of r.rows || []) {
      const orderDbId = typeof row.id === 'bigint' ? Number(row.id) : Number(row.id);
      if (!Number.isFinite(orderDbId) || orderDbId < 1) continue;
      if ((await this._getReservedQtyForOrder(orderDbId)) <= 0) continue;
      const clientMp = marketplaceFromOrdersDb(row.marketplace);
      await this.releaseReserveIfExistsForOrder(clientMp, row.order_id);
      released += 1;
    }
    return { released };
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
    const oid = String(order.orderId ?? order.order_id ?? orderId);
    const orderRowDbId = typeof id === 'bigint' ? Number(id) : Number(id);
    const metaOrderId = Number.isFinite(orderRowDbId) ? orderRowDbId : id;

    const affected = await releaseAllReservesForOrder(
      metaOrderId,
      oid,
      async (pid, net, orderIdLabel, meta) => {
        await stockMovementsService.applyChange(pid, {
          delta: net,
          type: 'unreserve',
          reason: `Снятие резерва: возврат заказа ${orderIdLabel} из закупки`,
          meta
        });
      }
    );

    const productIds = new Set(
      (affected || []).map((p) => Number(p)).filter((p) => Number.isFinite(p) && p > 0)
    );
    let kitId = order.productId ?? order.product_id;
    if (!kitId) kitId = await this.resolveProductIdForAssemblyLine(order);
    if (kitId) productIds.add(Number(kitId));

    const excludeIds = metaOrderId != null ? [metaOrderId] : [];
    for (const pid of productIds) {
      await this.ensureReservesForProductIfSupplyAvailable(pid, {
        excludeOrderDbIds: excludeIds
      }).catch(() => {});
    }
  }

  /**
   * После освобождения резерва (cancel/delete/изменения закупки) — попытаться
   * зарезервировать освободившийся supply (actual+incoming-reserved) под другие заказы этого товара.
   * Важно: не делаем глобальную "пересборку" (которая пишет unreserve+reserve пачкой),
   * а только ДОрезервируем тем, кому не хватает.
   */
  async ensureReservesForProductIfSupplyAvailable(productId, { excludeOrderDbIds = null } = {}) {
    if (!repositoryFactory.isUsingPostgreSQL()) return;
    const pid = Number(productId);
    if (!Number.isFinite(pid) || pid < 1) return;
    const exclude = new Set(
      (excludeOrderDbIds || [])
        .map((id) => Number(id))
        .filter((n) => Number.isFinite(n) && n > 0)
    );
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
    const isKit = await isKitProductId(pid);
    // У комплекта в products.quantity часто 0 — резерв идёт по комплектующим, очередь всё равно обрабатываем.
    if (!isKit && availableSupply <= 0) return;

    const runQueueForProduct = async (forPid) => {
      const fp = Number(forPid);
      if (!Number.isFinite(fp) || fp < 1) return;
      const q =
        typeof this.repository.findReserveQueueOrdersByProductId === 'function'
          ? await this.repository.findReserveQueueOrdersByProductId(fp, 500)
          : [];
      for (const o of q) {
        const oid = orderRowDbId(o);
        if (oid && exclude.has(oid)) continue;
        await this._applyReserveForOrderIfAbsent(o).catch(() => {});
      }
    };

    await runQueueForProduct(pid);

    if (!isKit) {
      // Заказы на комплект (product_id = kit) не попадают в выборку по component id — дозаполняем резерв по родительским комплектам.
      const kitParents = await query(
        `SELECT DISTINCT kit_product_id FROM kit_components WHERE component_product_id = $1`,
        [pid]
      );
      for (const kr of kitParents.rows || []) {
        const kid = Number(kr.kit_product_id);
        await runQueueForProduct(kid);
      }
    }
  }

  async getAll(options = {}) {
    if (repositoryFactory.isUsingPostgreSQL()) {
      const items = await this.repository.findAll(options);
      await this.enrichOrdersReserveMetrics(items);
      return items;
    } else {
      // Старое хранилище
      return await this.repository.findAll();
    }
  }

  /**
   * reservedQty / hasReserve из журнала (как на «Остатках»).
   * Комплект — целые единицы; обычный товар — нетто по product_id и order_id.
   */
  async enrichOrdersReserveMetrics(orders) {
    if (!repositoryFactory.isUsingPostgreSQL() || !Array.isArray(orders)) return orders;
    for (const o of orders) {
      try {
        const orderDbId = orderRowDbId(o);
        if (!orderDbId) continue;
        const productId = await this._resolveProductIdForOrderStock(o);
        const pid = Number(productId);
        let reserved = 0;
        if (Number.isFinite(pid) && pid > 0 && (await isKitProductId(pid))) {
          reserved = await getReservedKitUnitsForOrder(pid, orderDbId);
        } else if (Number.isFinite(pid) && pid > 0) {
          reserved = await this._getReservedQtyForOrderProduct(orderDbId, pid);
        } else {
          reserved = await this._getReservedQtyForOrder(orderDbId);
        }
        o.reservedQty = reserved;
        o.reserved_qty = reserved;
        o.hasReserve = reserved > 0;
      } catch {
        /* ignore */
      }
    }
    return orders;
  }

  async getPage(options = {}) {
    if (repositoryFactory.isUsingPostgreSQL()) {
      const items = await this.repository.findAll(options);
      await this.enrichOrdersReserveMetrics(items);
      const total =
        typeof this.repository.countAll === 'function'
          ? await this.repository.countAll(options)
          : items.length;
      return { items, total };
    }
    const items = await this.repository.findAll();
    return { items, total: items.length };
  }

  /**
   * Счётчики по статусам для кнопок фильтра.
   * Возвращает количества по "строкам списка" (группам заказов), а не по каждой позиции товара.
   */
  async getStatusCounts(options = {}) {
    if (repositoryFactory.isUsingPostgreSQL()) {
      if (typeof this.repository.countGroupsByStatus === 'function') {
        const rows = await this.repository.countGroupsByStatus(options);
        const out = {};
        for (const r of rows || []) {
          if (!r || !r.status) continue;
          out[String(r.status)] = Number(r.count) || 0;
        }
        out.all = Object.values(out).reduce((a, b) => a + (Number(b) || 0), 0);
        return out;
      }
    }

    // Fallback для старого хранилища (без SQL агрегации)
    const items = await this.getAll(options);
    const groupToStatus = new Map();
    for (const o of items || []) {
      const mp = String(o.marketplace || 'unknown');
      const gid = String(o.orderGroupId ?? o.order_group_id ?? '').trim();
      const ok = gid ? `${mp}|g|${gid}` : `${mp}|o|${String(o.orderId ?? o.order_id ?? '').trim()}`;
      if (groupToStatus.has(ok)) continue;
      const mpLower = mp.toLowerCase();
      const raw = o.status ?? 'unknown';
      const sNorm = String(raw ?? '').trim().toLowerCase();
      const status =
        (mpLower === 'wildberries' || mpLower === 'wb') &&
        (sNorm === 'wb_status_unknown' || String(raw) === '__wb_status_pending__')
          ? 'new'
          : String(raw || 'unknown');
      groupToStatus.set(ok, status);
    }
    const out = { all: groupToStatus.size };
    for (const st of groupToStatus.values()) {
      out[st] = (out[st] || 0) + 1;
    }
    return out;
  }

  async getById(id) {
    if (!repositoryFactory.isUsingPostgreSQL()) {
      const orders = await this.getAll();
      return orders.find(o => String(o.id) === String(id)) || null;
    }
    return await this.repository.findById(id);
  }

  async getByMarketplaceAndOrderId(marketplace, orderId, { profileId = null } = {}) {
    if (repositoryFactory.isUsingPostgreSQL()) {
      return await this.repository.findByMarketplaceAndOrderId(marketplace, orderId, profileId);
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
    const oid = orderRowDbId(created);
    const productId = created?.productId ?? created?.product_id ?? orderData.product_id;
    if (oid && productId) {
      await this._reserveForOrderIfStockAvailable({
        id: oid,
        orderId: created?.orderId ?? orderData.order_id,
        order_id: created?.orderId ?? orderData.order_id,
        productId,
        product_id: productId,
        quantity: created?.quantity ?? orderData.quantity ?? 1,
        status: created?.status ?? orderData.status ?? 'new',
        marketplace: created?.marketplace ?? orderData.marketplace,
        deliveryAddress: created?.deliveryAddress ?? orderData.delivery_address
      });
    }
    return created;
  }

  /**
   * Создать ручной заказ с несколькими товарами (одна группа).
   * @param {Array<{ productId: number, quantity: number, price?: number }>} items — price за единицу (если не передана, берётся из карточки товара)
   * @param {{ profileId?: number|null, customerName?: string|null, customerPhone?: string|null }} [meta]
   * @returns {Promise<object>} { orderGroupId, orders: [...] }
   */
  async createManualWithItems(items, meta = {}) {
    if (!repositoryFactory.isUsingPostgreSQL()) {
      const error = new Error('Ручное добавление заказов поддерживается только при использовании PostgreSQL');
      error.statusCode = 501;
      throw error;
    }
    if (!Array.isArray(items) || items.length === 0) {
      const error = new Error('Укажите хотя бы одну позицию (items: [{ productId, quantity, price }, ...])');
      error.statusCode = 400;
      throw error;
    }
    const profileId = meta.profileId != null ? Number(meta.profileId) : null;
    const customerName =
      meta.customerName != null && String(meta.customerName).trim() !== '' ? String(meta.customerName).trim() : null;
    const customerPhone =
      meta.customerPhone != null && String(meta.customerPhone).trim() !== ''
        ? String(meta.customerPhone).trim()
        : null;
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
      let price =
        item.price != null && item.price !== '' ? Number(item.price) : NaN;
      if (!Number.isFinite(price) || price < 0) {
        price = productObj.cost != null ? Number(productObj.cost) : (productObj.price != null ? Number(productObj.price) : 0);
      }
      const orderId = i === 0 ? orderGroupId : `${orderGroupId}-${i + 1}`;
      const orderData = {
        profile_id: Number.isFinite(profileId) && profileId > 0 ? profileId : null,
        marketplace: 'manual',
        order_id: orderId,
        order_group_id: orderGroupId,
        product_id: productId,
        product_name: productObj.name ?? productObj.product_name ?? null,
        offer_id: null,
        marketplace_sku: null,
        quantity,
        price,
        status: 'new',
        customer_name: customerName,
        customer_phone: customerPhone,
      };
      const row = await this.repository.create(orderData);
      const oid = orderRowDbId(row);
      if (oid) {
        await this._reserveForOrderIfStockAvailable({
          id: oid,
          orderId,
          order_id: orderId,
          productId,
          product_id: productId,
          quantity,
          status: 'new',
          marketplace: 'manual',
          deliveryAddress: null,
          orderGroupId: orderGroupId
        });
      }
      created.push(row);
    }
    if (created.length === 0) {
      const error = new Error('Не удалось создать заказ: проверьте товары и цены.');
      error.statusCode = 400;
      throw error;
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
  /** Товар для резерва/отгрузки: комплект, если заказ по SKU комплекта, даже при product_id комплектующей. */
  async _resolveProductIdForOrderStock(orderRow) {
    if (!orderRow || !repositoryFactory.isUsingPostgreSQL()) {
      const raw = orderRow?.productId ?? orderRow?.product_id;
      const n = Number(raw);
      return Number.isFinite(n) && n > 0 ? n : null;
    }
    const byOrderSku = await findKitProductIdForMarketplaceOrder(0, orderRow);
    if (byOrderSku != null && (await isKitProductId(byOrderSku))) {
      return byOrderSku;
    }
    let productId = orderRow?.productId ?? orderRow?.product_id;
    if (productId == null) {
      productId = await this.resolveProductIdForAssemblyLine(orderRow);
    }
    productId = Number(productId);
    if (!Number.isFinite(productId) || productId < 1) {
      return byOrderSku != null ? byOrderSku : null;
    }
    const resolved = await findKitProductIdForMarketplaceOrder(productId, orderRow);
    if (resolved != null && (await isKitProductId(resolved))) {
      return resolved;
    }
    return productId;
  }

  /** Сколько комплектов можно зарезервировать: сначала по складу заказа, при 0 — по всем складам. */
  async _computeMaxKitUnitsReservableForOrder(kitProductId, warehouseId) {
    const kitId = Number(kitProductId);
    if (!Number.isFinite(kitId) || kitId < 1) return 0;
    const wh =
      warehouseId != null && String(warehouseId).trim() !== '' ? warehouseId : null;
    if (wh != null) {
      const scoped = await computeMaxKitUnitsReservable(kitId, { warehouseId: wh });
      if (scoped > 0) return scoped;
    }
    return computeMaxKitUnitsReservable(kitId, { warehouseId: null });
  }

  /** Повторная попытка резерва (новый / закупка / после поступления остатка). */
  async _reapplyReserveForOrderRows(rows) {
    const list = Array.isArray(rows) ? rows : [];
    const excludeIds = list.map((r) => orderRowDbId(r)).filter((id) => id != null);
    const touchedKitIds = new Set();
    for (const row of list) {
      if (!row) continue;
      await this._applyReserveForOrderIfAbsent(row).catch(() => {});
      try {
        const kitId = await this._resolveProductIdForOrderStock(row);
        if (kitId != null && (await isKitProductId(kitId))) {
          const kid = Number(kitId);
          if (Number.isFinite(kid) && kid > 0 && !touchedKitIds.has(kid)) {
            touchedKitIds.add(kid);
            await this.ensureReservesForProductIfSupplyAvailable(kid, {
              excludeOrderDbIds: excludeIds
            }).catch(() => {});
            const components = await getKitComponents(kid);
            for (const c of components) {
              const cpid = Number(c.component_product_id);
              if (Number.isFinite(cpid) && cpid > 0) {
                await this.ensureReservesForProductIfSupplyAvailable(cpid, {
                  excludeOrderDbIds: excludeIds
                }).catch(() => {});
              }
            }
          }
        }
      } catch {
        /* ignore */
      }
    }
  }

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
      let order = await this.repository.findFirstAssembledByProductIdOrSku(productId);
      if (order) return order;
      const pid = Number(productId);
      if (Number.isFinite(pid) && pid > 0) {
        const kitsRes = await query(
          `SELECT DISTINCT kit_product_id FROM kit_components WHERE component_product_id = $1`,
          [pid]
        );
        for (const row of kitsRes.rows || []) {
          const kitId = row.kit_product_id;
          if (kitId == null) continue;
          order = await this.repository.findFirstAssembledByProductIdOrSku(kitId);
          if (order) return order;
        }
      }
      return null;
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
  async sendToAssembly(orderIds, profileId = null) {
    if (!Array.isArray(orderIds) || orderIds.length === 0) {
      return { sent: 0, updated: 0 };
    }
    let updated = 0;
    const touchedProductIds = new Set();
    if (repositoryFactory.isUsingPostgreSQL()) {
      for (const { marketplace, orderId } of orderIds) {
        if (!marketplace || orderId == null) continue;
        const row = await this.repository.updateByMarketplaceAndOrderId(
          marketplace,
          String(orderId),
          { status: 'in_assembly' },
          profileId
        );
        if (row) {
          updated++;
          await this._applyReserveForOrderIfAbsent(row).catch(() => {});
          let pid = await this._resolveProductIdForOrderStock(row).catch(() => null);
          if (!pid) {
            pid = row.productId ?? row.product_id;
          }
          const pn = Number(pid);
          if (Number.isFinite(pn) && pn > 0) touchedProductIds.add(pn);
        }
      }
      for (const pid of touchedProductIds) {
        await this.ensureReservesForProductIfSupplyAvailable(pid).catch(() => {});
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
   * Списание остатков — только при закрытии поставки (applyAssemblyStockForShipmentOrders).
   * Если у заказа есть orderGroupId — обновляются все заказы группы.
   */
  async markOrderAsAssembled(marketplace, orderId, assembledByUserId = null, profileId = null, stickerNumber = null) {
    if (!marketplace || orderId == null) return null;
    if (repositoryFactory.isUsingPostgreSQL()) {
      const order = await this._findOrderByMarketplaceAndOrderId(marketplace, orderId, profileId);
      if (!order) return null;

      if (order.orderGroupId) {
        await this.repository.markAssembledByOrderGroupId(
          order.orderGroupId,
          assembledByUserId,
          profileId,
          stickerNumber
        );
      } else {
        await this.repository.markAssembledByMarketplaceAndOrderId(
          marketplace,
          String(orderId),
          assembledByUserId,
          profileId,
          stickerNumber
        );
      }

      return this.repository.findByMarketplaceAndOrderId(marketplace, String(orderId), profileId);
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
    order.assemblyStickerNumber =
      stickerNumber != null && String(stickerNumber).trim() !== '' ? String(stickerNumber).trim() : null;
    await writeData('orders', { ...data, orders, lastSync: new Date().toISOString() });
    return order;
  }

  /**
   * Вернуть заказ в статус «Новый» (со сборки или «Собран»).
   * Если у заказа есть orderGroupId — обновляются все заказы группы.
   */
  async returnOrderToNew(marketplace, orderId, profileId = null) {
    if (!marketplace || orderId == null) return null;
    if (repositoryFactory.isUsingPostgreSQL()) {
      const order = await this.repository.findByMarketplaceAndOrderId(marketplace, String(orderId), profileId);
      if (!order) return null;
      if (order.orderGroupId) {
        const n = await this.repository.updateStatusByOrderGroupId(order.orderGroupId, 'new', profileId);
        if (n === 0) {
          await this.repository.updateByMarketplaceAndOrderId(
            marketplace,
            String(order.orderId ?? order.order_id),
            { status: 'new' },
            profileId
          );
        }
        const groupRows = await this.repository.findByOrderGroupId(order.orderGroupId, profileId);
        const toReserve = (groupRows || []).filter(
          (row) => String(row.status || '').toLowerCase() === 'new'
        );
        await this._reapplyReserveForOrderRows(toReserve);
        return order;
      }
      await this.repository.updateByMarketplaceAndOrderId(marketplace, String(orderId), { status: 'new' }, profileId);
      const refreshed = await this.repository.findByMarketplaceAndOrderId(marketplace, String(orderId), profileId);
      if (refreshed) await this._reapplyReserveForOrderRows([refreshed]);
      return refreshed ?? order;
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
  async setOrderToProcurement(marketplace, orderId, profileId = null) {
    if (!marketplace || orderId == null) return null;
    if (repositoryFactory.isUsingPostgreSQL()) {
      const order = await this.repository.findByMarketplaceAndOrderId(marketplace, String(orderId), profileId);
      if (!order) return null;
      const stNorm = String(order.status ?? '').trim().toLowerCase();
      if (stNorm === 'in_procurement') return order;
      if (!orderEligibleForProcurement(order)) return null;
      let rows = [order];
      if (order.orderGroupId) {
        rows = await this.repository.findByOrderGroupId(order.orderGroupId, profileId);
      }
      if (order.orderGroupId) {
        await this.repository.updateStatusByOrderGroupId(order.orderGroupId, 'in_procurement', profileId);
      } else {
        await this.repository.updateByMarketplaceAndOrderId(
          marketplace,
          String(orderId),
          { status: 'in_procurement' },
          profileId
        );
      }
      await this._reapplyReserveForOrderRows(rows);
      return order;
    }
    const { readData, writeData } = await import('../utils/storage.js');
    const data = await readData('orders');
    const orders = (data?.orders && [...data.orders]) || [];
    const key = `${marketplace}|${orderId}`;
    const order = orders.find(o => `${o.marketplace}|${o.orderId}` === key);
    if (!order) return null;
    if (String(order.status ?? '').trim().toLowerCase() === 'in_procurement') return order;
    if (!orderEligibleForProcurement(order)) return null;
    order.status = 'in_procurement';
    order.returnedToNewAt = null;
    await writeData('orders', { ...data, orders, lastSync: new Date().toISOString() });
    return order;
  }

  /**
   * Отметить заказ как отгруженный: статус 'shipped' (ручные заказы без поставки FBS).
   * Для FBS списание — при закрытии поставки; здесь движения только для ручного сценария.
   */
  async markOrderAsShipped(marketplace, orderId, profileId = null) {
    if (!marketplace || orderId == null) return null;
    if (repositoryFactory.isUsingPostgreSQL()) {
      const order = await this.repository.findByMarketplaceAndOrderId(marketplace, String(orderId), profileId);
      if (!order) return null;
      const rows = order.orderGroupId
        ? await this.repository.findByOrderGroupId(order.orderGroupId, profileId)
        : [order];
      for (const r of rows) {
        await this._applyAssemblyStockForOrderRow(r);
      }
      if (order.orderGroupId) {
        await this.repository.updateStatusByOrderGroupId(order.orderGroupId, 'shipped', profileId);
        return order;
      }
      return await this.repository.updateByMarketplaceAndOrderId(
        marketplace,
        String(orderId),
        { status: 'shipped' },
        profileId
      );
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

  /** Сколько уже возвращено на склад при отмене (receipt с meta.cancel_restore). */
  async _getCancelRestoreQtyForOrderProduct(orderDbId, productId) {
    if (!orderDbId || !productId || !repositoryFactory.isUsingPostgreSQL()) return 0;
    const r = await query(
      `SELECT COALESCE(SUM(quantity_change), 0)::int AS restored
       FROM stock_movements
       WHERE product_id = $2
         AND type = 'receipt'
         AND (meta->>'order_id')::bigint = $1::bigint
         AND COALESCE(meta->>'cancel_restore', '') = 'true'`,
      [orderDbId, productId]
    );
    return Math.max(0, Number(r.rows?.[0]?.restored) || 0);
  }

  /**
   * Если при сборке уже списали со склада — вернуть остаток при отмене (идемпотентно).
   */
  async _restoreShippedStockOnCancel(orderRow, productId, label) {
    if (!repositoryFactory.isUsingPostgreSQL() || !orderRow || !productId) return;
    const orderDbId = orderRowDbId(orderRow);
    if (!orderDbId) return;

    const shipped = await this._getShippedQtyForOrderProduct(orderDbId, productId);
    const already = await this._getCancelRestoreQtyForOrderProduct(orderDbId, productId);
    const toRestore = Math.max(0, shipped - already);
    if (toRestore <= 0) return;

    const orderIdStr = String(orderRow.orderId ?? orderRow.order_id ?? '').trim();
    const warehouseId = await this._resolveOwnWarehouseIdForOrder(orderRow);
    await stockMovementsService.applyChange(productId, {
      delta: toRestore,
      type: 'receipt',
      reason: `Отмена заказа: возврат на склад ${label} ${orderIdStr}`.trim(),
      meta: {
        order_id: orderDbId,
        orderId: orderIdStr,
        marketplace: label,
        cancel_restore: true,
        warehouse_id: warehouseId || null
      }
    });
  }

  /**
   * Снять остаточный резерв и вернуть списанное при сборке (если было).
   * @returns {Promise<number[]>} product_id, затронутые движениями
   */
  async _releaseStockEffectsForCancelledOrderRow(orderRow, label) {
    if (!repositoryFactory.isUsingPostgreSQL() || !orderRow) return [];
    const orderDbId = orderRowDbId(orderRow);
    if (!orderDbId) return [];

    const orderIdStr = String(orderRow.orderId ?? orderRow.order_id ?? '').trim();
    const warehouseId = await this._resolveOwnWarehouseIdForOrder(orderRow);
    const touched = new Set();

    const reservedPids = await releaseAllReservesForOrder(
      orderDbId,
      orderIdStr,
      async (pid, net, oidLabel, meta) => {
        await stockMovementsService.applyChange(pid, {
          delta: net,
          type: 'unreserve',
          reason: `Снятие резерва: отмена заказа ${label} ${oidLabel}`,
          meta: { ...meta, marketplace: label, warehouse_id: warehouseId || null }
        });
        touched.add(Number(pid));
      }
    );
    for (const pid of reservedPids || []) {
      if (Number.isFinite(pid) && pid > 0) touched.add(pid);
    }

    const productId = await this._resolveProductIdForOrderStock(orderRow);
    if (productId) {
      await this._restoreShippedStockOnCancel(orderRow, productId, label);
      touched.add(Number(productId));
    }

    return [...touched];
  }

  async _removeCancelledOrdersFromOpenShipments(mpForRepo, orderRows, options = {}) {
    const { profileId = null, organizationId = null } = options;
    if (!Array.isArray(orderRows) || orderRows.length === 0) return [];
    const shipmentsService = (await import('./shipments.service.js')).default;
    const shipmentIds = [];
    const seen = new Set();
    for (const row of orderRows) {
      const oid = String(row.orderId ?? row.order_id ?? '').trim();
      if (!oid || seen.has(oid)) continue;
      seen.add(oid);
      try {
        const ids = await shipmentsService.removeOrderFromOpenShipments(mpForRepo, oid, {
          profileId: profileId ?? row.profile_id ?? row.profileId ?? null,
          organizationId: organizationId ?? row.organization_id ?? row.organizationId ?? null
        });
        shipmentIds.push(...ids);
      } catch (e) {
        console.warn('[Orders] remove from shipment on cancel:', oid, e?.message || e);
      }
    }
    return [...new Set(shipmentIds)];
  }

  /**
   * После отмены: статус cancelled, снятие резерва, возврат списанного при сборке, удаление из открытых поставок.
   * @param {string} mpForRepo — marketplace как в БД (wildberries, ozon, …)
   * @param {string} oid — orderId строки, с которой вызывали отмену
   * @param {string} marketplaceStockLabel — подпись в движении остатков
   * @param {{ profileId?: number|string|null, organizationId?: number|string|null }} [options]
   */
  async _finalizeMarketplaceCancellation(mpForRepo, oid, order, marketplaceStockLabel, options = {}) {
    const label = marketplaceStockLabel || mpForRepo;
    const { profileId = null, organizationId = null } = options;
    if (repositoryFactory.isUsingPostgreSQL()) {
      const touchedProducts = new Set();
      const rows = order.orderGroupId
        ? await this.repository.findByOrderGroupId(order.orderGroupId, profileId)
        : [order];

      await this._removeCancelledOrdersFromOpenShipments(mpForRepo, rows, { profileId, organizationId });

      if (order.orderGroupId) {
        await this.repository.updateStatusByOrderGroupId(order.orderGroupId, 'cancelled');
      } else {
        await this.repository.updateByMarketplaceAndOrderId(mpForRepo, oid, { status: 'cancelled' });
      }

      if (Array.isArray(rows)) {
        for (const row of rows) {
          const pids = await this._releaseStockEffectsForCancelledOrderRow(row, label);
          for (const p of pids) touchedProducts.add(p);
        }
      }

      for (const p of touchedProducts) {
        await this.ensureReservesForProductIfSupplyAvailable(p).catch(() => {});
      }
      return await this.repository.findByMarketplaceAndOrderId(mpForRepo, oid, profileId);
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
    return this._finalizeMarketplaceCancellation('manual', oid, order, 'manual', {
      profileId: order.profile_id ?? order.profileId ?? null,
      organizationId: order.organization_id ?? order.organizationId ?? null
    });
  }

  async _cancelOzonOrder(orderId) {
    const oid = String(orderId).trim();
    const postingApi = ozonPostingNumberFromOrderId(oid) || oid;
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
      { related_posting_numbers: [postingApi] },
      { posting_number: postingApi }
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
          postings.find(p => String(p.posting_number ?? p.postingNumber) === postingApi) || postings[0];
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
        posting_number: postingApi,
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
    return this._finalizeMarketplaceCancellation('ozon', oid, order, 'ozon', {
      profileId: order.profile_id ?? order.profileId ?? null,
      organizationId: order.organization_id ?? order.organizationId ?? null
    });
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
        return this._finalizeMarketplaceCancellation('yandex', oid, order, 'yandex', {
          profileId: order.profile_id ?? order.profileId ?? null,
          organizationId: order.organization_id ?? order.organizationId ?? null
        });
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

    return this._finalizeMarketplaceCancellation(mpForRepo, oid, order, 'wildberries', {
      profileId: order.profile_id ?? order.profileId ?? null,
      organizationId: order.organization_id ?? order.organizationId ?? null
    });
  }

  /**
   * Удалить заказ. Если у заказа есть orderGroupId — удаляются все заказы группы.
   * @returns {Promise<number>} количество удалённых записей (0 если не найден)
   */
  async deleteOrder(marketplace, orderId, { profileId = null } = {}) {
    if (!marketplace || orderId == null) return 0;
    if (repositoryFactory.isUsingPostgreSQL()) {
      const order = await this.repository.findByMarketplaceAndOrderId(marketplace, String(orderId), profileId);
      if (!order) return 0;
      if (order.orderGroupId) {
        // Важно: при удалении ручного заказа снимаем резерв по каждой строке группы,
        // иначе reserved_quantity и свободный остаток останутся "залипшими".
        try {
          const rows = await this.repository.findByOrderGroupId(order.orderGroupId, profileId);
          for (const r of rows || []) {
            await this.releaseReserveIfExistsForOrder(r.marketplace, r.orderId ?? r.order_id);
          }
        } catch {
          // ignore reserve rollback errors
        }
        return await this.repository.deleteByOrderGroupId(order.orderGroupId, profileId);
      }
      try {
        await this.releaseReserveIfExistsForOrder(marketplace, String(orderId));
      } catch {
        // ignore
      }
      const deleted = await this.repository.deleteByMarketplaceAndOrderId(marketplace, String(orderId), profileId);
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
   * Строки для ручного резерва в карточке заказа: только этот order_id (и подстроки),
   * без соседних заказов с тем же order_group_id.
   */
  async _findOrderRowsForReserve(marketplace, orderId, { profileId = null } = {}) {
    const oid = String(orderId ?? '').trim();
    if (!oid || !marketplace) return [];

    if (repositoryFactory.isUsingPostgreSQL()) {
      const rows = await this.repository.findRowsForReserveByOrderKey(marketplace, oid, profileId);
      if (rows.length > 0) return rows;
      const one = await this.repository.findByMarketplaceAndOrderId(marketplace, oid, profileId);
      return one ? [one] : [];
    }

    const all = await this.getAll();
    const mpUi = String(marketplace).toLowerCase();
    const sameMp = (oMp) => {
      const m = String(oMp || '').toLowerCase();
      if (mpUi === 'wildberries' || mpUi === 'wb') return m === 'wildberries' || m === 'wb';
      if (mpUi === 'yandex' || mpUi === 'ym' || mpUi === 'yandexmarket') {
        return m === 'yandex' || m === 'ym' || m === 'yandexmarket';
      }
      if (mpUi === 'ozon') return m === 'ozon';
      if (mpUi === 'manual') return m === 'manual';
      return m === mpUi;
    };
    return all.filter((o) => {
      if (!sameMp(o.marketplace)) return false;
      const oId = String(o.orderId ?? o.order_id ?? '').trim();
      return oId === oid || oId.startsWith(`${oid}~`) || oId.startsWith(`${oid}:`);
    });
  }

  /** Все строки заказа в БД (включая позиции группы). */
  async _findOrderGroupRows(marketplace, orderId, { profileId = null } = {}) {
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
      if (mpUi === 'manual') return m === 'manual';
      return m === mpUi;
    };

    if (repositoryFactory.isUsingPostgreSQL()) {
      let row = await this.repository.findByMarketplaceAndOrderId(marketplace, oid, profileId);
      if (!row) {
        const any = await this.repository.findAnyByOrderId(oid);
        if (any && sameMp(any.marketplace)) row = any;
      }
      if (!row) return [];
      const gid = row.orderGroupId ?? row.order_group_id;
      return gid ? await this.repository.findByOrderGroupId(gid, profileId) : [row];
    }

    const all = await this.getAll();
    const orders = all.filter((o) => sameMp(o.marketplace));
    let row =
      orders.find((o) => String(o.orderId) === oid) ||
      orders.find((o) => String(o.orderGroupId || '') === oid) ||
      orders.find((o) => String(o.orderId || '').startsWith(`${oid}~`));
    if (!row) return [];
    const gid = row.orderGroupId || row.order_group_id;
    return gid ? orders.filter((o) => String(o.orderGroupId || '') === String(gid)) : [row];
  }

  async _summarizeReserveForRows(rows) {
    let reservedQty = 0;
    let needQty = 0;
    const lines = [];
    for (const row of rows || []) {
      const id = orderRowDbId(row);
      const qty = Math.max(1, parseInt(row.quantity, 10) || 1);
      let reserved = 0;
      if (id) {
        const productId = await this._resolveProductIdForOrderStock(row).catch(() => null);
        const pid = Number(productId);
        if (Number.isFinite(pid) && pid > 0 && (await isKitProductId(pid))) {
          reserved = await getReservedKitUnitsForOrder(pid, id);
        } else if (Number.isFinite(pid) && pid > 0) {
          reserved = await this._getReservedQtyForOrderProduct(id, pid);
        } else {
          reserved = await this._getReservedQtyForOrder(id);
        }
      }
      reservedQty += reserved;
      needQty += qty;
      lines.push({
        orderLineId: row.orderId ?? row.order_id,
        productId: row.productId ?? row.product_id ?? null,
        reservedQty: reserved,
        needQty: qty
      });
    }
    return {
      hasReserve: reservedQty > 0,
      reservedQty,
      needQty,
      fullyReserved: needQty > 0 && reservedQty >= needQty,
      lines
    };
  }

  async getOrderReserveSummary(marketplace, orderId, { profileId = null } = {}) {
    const rows = await this._findOrderRowsForReserve(marketplace, orderId, { profileId });
    if (!rows.length) {
      const err = new Error('Заказ не найден в системе');
      err.statusCode = 404;
      throw err;
    }
    return this._summarizeReserveForRows(rows);
  }

  /**
   * Поставить / снять резерв по строкам выбранного заказа (не по всему order_group_id).
   * @param {'toggle'|'reserve'|'unreserve'} action
   */
  async setOrderReserve(marketplace, orderId, { profileId = null, action = 'toggle' } = {}) {
    if (!repositoryFactory.isUsingPostgreSQL()) {
      const err = new Error('Резерв по заказам доступен только при использовании PostgreSQL');
      err.statusCode = 501;
      throw err;
    }

    const rows = await this._findOrderRowsForReserve(marketplace, orderId, { profileId });
    if (!rows.length) {
      const err = new Error('Заказ не найден в системе');
      err.statusCode = 404;
      throw err;
    }

    for (const row of rows) {
      if (isOrderTerminalNoReserve(row.status)) {
        const err = new Error('Нельзя менять резерв для отгруженного или отменённого заказа');
        err.statusCode = 400;
        throw err;
      }
    }

    const before = await this._summarizeReserveForRows(rows);
    const act = String(action || 'toggle').toLowerCase();
    const doUnreserve = act === 'unreserve' || (act === 'toggle' && before.hasReserve);

    if (doUnreserve) {
      const excludedDbIds = rows.map((r) => orderRowDbId(r)).filter((id) => id != null);
      const productIds = new Set();
      for (const row of rows) {
        const id = orderRowDbId(row);
        if (!id) continue;
        const oid = String(row.orderId ?? row.order_id ?? orderId);
        const affected = await releaseAllReservesForOrder(id, oid, async (pid, net, orderIdLabel, meta) => {
          await stockMovementsService.applyChange(pid, {
            delta: net,
            type: 'unreserve',
            reason: `Снятие резерва по заказу ${orderIdLabel} (вручную)`.trim(),
            meta: { ...meta, manual_unreserve: true }
          });
        });
        for (const pid of affected || []) productIds.add(Number(pid));
      }
      // Не перераспределяем освободившийся остаток сразу на те же заказы (иначе «двойной» резерв при повторной постановке).
      for (const pid of productIds) {
        if (Number.isFinite(pid) && pid > 0) {
          await this.ensureReservesForProductIfSupplyAvailable(pid, {
            excludeOrderDbIds: excludedDbIds
          }).catch(() => {});
        }
      }
    } else {
      for (const row of rows) {
        const productId = await this._resolveProductIdForOrderStock(row);
        if (!productId) {
          const err = new Error(
            'Не удалось сопоставить товар заказа с каталогом. Укажите SKU в карточке товара или сопоставление маркетплейса.'
          );
          err.statusCode = 400;
          throw err;
        }
        try {
          await this._applyReserveForOrderIfAbsent(row);
        } catch (e) {
          if (e?.statusCode === 400) throw e;
          /* ignore */
        }
      }
    }

    const after = await this._summarizeReserveForRows(rows);
    let message;
    if (doUnreserve) {
      message = after.hasReserve
        ? `Резерв частично снят: ${after.reservedQty} из ${after.needQty}`
        : 'Резерв снят';
    } else if (after.reservedQty <= before.reservedQty) {
      message =
        after.needQty > 0
          ? `Недостаточно остатка для резерва (сейчас ${after.reservedQty} из ${after.needQty})`
          : 'Резерв не изменён';
    } else if (after.fullyReserved) {
      message = `Резерв установлен: ${after.reservedQty} из ${after.needQty}`;
    } else {
      message = `Резерв частично установлен: ${after.reservedQty} из ${after.needQty}`;
    }

    return {
      action: doUnreserve ? 'unreserve' : 'reserve',
      ...after,
      message
    };
  }

  /**
   * Строки заказа из локальной БД для карточки заказа (product_id → ссылка на каталог).
   */
  async getLocalLinesForOrderDetail(marketplace, orderId, { profileId = null } = {}) {
    const rows = await this._findOrderGroupRows(marketplace, orderId, { profileId });
    const mapRow = (o) => ({
      orderLineId: o.orderId ?? o.order_id,
      productId: o.productId ?? o.product_id ?? null,
      offerId: o.offerId ?? o.offer_id ?? null,
      marketplaceSku: o.marketplaceSku ?? o.marketplace_sku ?? o.sku ?? null,
      productName: o.productName ?? o.product_name ?? null
    });
    const mapped = (rows || []).map(mapRow);
    for (let i = 0; i < mapped.length; i++) {
      const p = mapped[i].productId;
      if (p != null && String(p).trim() !== '') continue;
      const resolved = await this.resolveProductIdForAssemblyLine(rows[i]);
      if (resolved != null) mapped[i].productId = resolved;
    }
    return mapped;
  }
}

export default new OrdersService();


