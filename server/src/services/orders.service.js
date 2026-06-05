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
  batchPiecesPerKitUnitMap,
  batchKitIdByComponentMap,
  getNetReservedForOrderProduct,
  readKitPhysicalOnHandFromDb,
  sumKitComponentQtyPerKit,
  buildKitComponentQtyMap,
  getComponentAssemblableUnits
} from './kitStock.service.js';
import {
  NET_RESERVED_SUM_EXPR_SQL,
  RAW_RESERVED_SUM_EXPR_SQL,
  getProductSupplySnapshotWithClient
} from './sellableQuantity.service.js';
import { orderReserveMovementMatchSql } from '../constants/netReservedStockSql.js';
import integrationsService from './integrations.service.js';
import { getYandexBusinessAndCampaigns, normalizeYandexApiKey } from './orders.sync.service.js';
import { getYandexHttpsAgent } from '../utils/yandex-https-agent.js';
import { ozonPostingNumberFromOrderId } from '../utils/ozonPosting.js';

/**
 * Покрытие резерва по заказу: только со склада (on_hand) или с участием «в пути» (incoming).
 * @returns {'none'|'on_hand'|'incoming'}
 */
export function classifyOrderReserveCoverage({ onHand = 0, reservedRaw = 0, orderReserved = 0 } = {}) {
  const R = Math.max(0, Math.floor(Number(orderReserved) || 0));
  if (R <= 0) return 'none';
  const H = Math.max(0, Math.floor(Number(onHand) || 0));
  const raw = Math.max(0, Math.floor(Number(reservedRaw) || 0));
  const reservedOthers = Math.max(0, raw - R);
  const fromOnHand = Math.min(R, Math.max(0, H - reservedOthers));
  if (fromOnHand >= R) return 'on_hand';
  return 'incoming';
}

/** Сколько ещё можно покрыть резервом с фактического остатка (FIFO: сначала занят on_hand). */
export function onHandHeadroomBeforeReserve({ onHand = 0, reservedRaw = 0 } = {}) {
  const H = Math.max(0, Math.floor(Number(onHand) || 0));
  const R0 = Math.max(0, Math.floor(Number(reservedRaw) || 0));
  return Math.max(0, H - Math.min(R0, H));
}

/**
 * Покрытие резерва по заказам одного товара: FIFO по дате заказа (как при дозарезервировании).
 * @returns {Map<string, 'on_hand'|'incoming'>} ключ `${orderDbId}:${productId}`
 */
async function buildReserveCoverageFifoMap(productIds) {
  const ids = [...new Set((productIds || []).map((id) => Number(id)).filter((id) => id > 0))];
  const map = new Map();
  if (!ids.length || !repositoryFactory.isUsingPostgreSQL()) return map;

  const supplyMap = await batchProductReserveSupplyMap(ids);
  const r = await query(
    `SELECT o.id AS order_db_id,
            o.product_id,
            GREATEST(0, COALESCE((
              SELECT ${NET_RESERVED_SUM_EXPR_SQL}::bigint
              FROM stock_movements sm
              WHERE sm.product_id = o.product_id
                AND sm.type IN ('reserve', 'unreserve')
                AND sm.meta ? 'order_id'
                AND (sm.meta->>'order_id') ~ '^[0-9]+$'
                AND (sm.meta->>'order_id')::bigint = o.id
            ), 0))::int AS reserved_qty
     FROM orders o
     WHERE o.product_id = ANY($1::int[])
       AND o.status IN ('new', 'in_procurement', 'in_assembly')
     ORDER BY o.product_id ASC, o.created_at ASC NULLS LAST, o.id ASC`,
    [ids]
  );

  const byPid = new Map();
  for (const row of r.rows || []) {
    const reserved = Number(row.reserved_qty) || 0;
    if (reserved <= 0) continue;
    const pid = Number(row.product_id);
    const oid = Number(row.order_db_id);
    if (!Number.isFinite(pid) || pid < 1 || !Number.isFinite(oid) || oid < 1) continue;
    if (!byPid.has(pid)) byPid.set(pid, []);
    byPid.get(pid).push({ oid, reserved });
  }

  for (const [pid, list] of byPid) {
    const sup = supplyMap.get(pid);
    let onHandPool = sup ? Math.max(0, Math.floor(sup.onHand) || 0) : 0;
    for (const { oid, reserved } of list) {
      const R = Math.max(0, Math.floor(reserved));
      const fromOnHand = Math.min(R, onHandPool);
      onHandPool -= fromOnHand;
      map.set(`${oid}:${pid}`, fromOnHand >= R ? 'on_hand' : 'incoming');
    }
  }
  return map;
}

/**
 * Покрытие резерва по заказам: все product_id в движениях (в т.ч. комплектующие комплекта).
 * @returns {Map<number, 'on_hand'|'incoming'>}
 */
async function buildReserveCoverageByOrderIds(orderDbIds) {
  const ids = [...new Set((orderDbIds || []).map((id) => Number(id)).filter((id) => id > 0))];
  const map = new Map();
  if (!ids.length || !repositoryFactory.isUsingPostgreSQL()) return map;

  const r = await query(
    `SELECT (sm.meta->>'order_id')::bigint AS order_db_id,
            sm.product_id,
            ${NET_RESERVED_SUM_EXPR_SQL}::int AS reserved_qty
     FROM stock_movements sm
     WHERE sm.type IN ('reserve', 'unreserve')
       AND sm.meta ? 'order_id'
       AND (sm.meta->>'order_id') ~ '^[0-9]+$'
       AND (sm.meta->>'order_id')::bigint = ANY($1::bigint[])
     GROUP BY order_db_id, sm.product_id
     HAVING ${NET_RESERVED_SUM_EXPR_SQL} > 0`,
    [ids]
  );

  const movementPids = [];
  const byOrder = new Map();
  for (const row of r.rows || []) {
    const oid = Number(row.order_db_id);
    const pid = Number(row.product_id);
    const reserved = Number(row.reserved_qty) || 0;
    if (!Number.isFinite(oid) || oid < 1 || !Number.isFinite(pid) || pid < 1 || reserved <= 0) continue;
    movementPids.push(pid);
    if (!byOrder.has(oid)) byOrder.set(oid, []);
    byOrder.get(oid).push({ pid, reserved });
  }
  if (!byOrder.size) return map;

  const supplyMap = await batchProductReserveSupplyMap(movementPids);
  const fifoMap = await buildReserveCoverageFifoMap(movementPids);

  for (const [oid, lines] of byOrder) {
    let anyIncoming = false;
    let anyOnHand = false;
    for (const { pid, reserved } of lines) {
      const fifoKey = `${oid}:${pid}`;
      const kind = fifoMap.has(fifoKey)
        ? fifoMap.get(fifoKey)
        : (() => {
            const sup = supplyMap.get(pid);
            return sup ? classifyOrderReserveCoverage({ ...sup, orderReserved: reserved }) : 'incoming';
          })();
      if (kind === 'on_hand') anyOnHand = true;
      if (kind === 'incoming') anyIncoming = true;
    }
    map.set(oid, anyIncoming ? 'incoming' : anyOnHand ? 'on_hand' : 'incoming');
  }
  return map;
}

async function batchProductReserveSupplyMap(productIds) {
  const ids = [...new Set((productIds || []).map((id) => Number(id)).filter((id) => id > 0))];
  const map = new Map();
  if (!ids.length || !repositoryFactory.isUsingPostgreSQL()) return map;
  const r = await query(
    `SELECT p.id,
      COALESCE(p.incoming_quantity, 0)::int AS incoming,
      GREATEST(
        COALESCE(p.quantity, 0),
        COALESCE((
          SELECT SUM(COALESCE(pws.quantity, 0))::int
          FROM product_warehouse_stock pws
          WHERE pws.product_id = p.id
        ), 0)
      )::int AS on_hand,
      COALESCE((
        SELECT ${NET_RESERVED_SUM_EXPR_SQL}::int
        FROM stock_movements sm
        WHERE sm.product_id = p.id AND sm.type IN ('reserve', 'unreserve')
      ), 0)::int AS reserved_raw
     FROM products p
     WHERE p.id = ANY($1::int[])`,
    [ids]
  );
  for (const row of r.rows || []) {
    const id = Number(row.id);
    if (!Number.isFinite(id) || id < 1) continue;
    map.set(id, {
      onHand: Number(row.on_hand ?? 0) || 0,
      incoming: Number(row.incoming ?? 0) || 0,
      reservedRaw: Number(row.reserved_raw ?? 0) || 0
    });
  }
  return map;
}

function enrichReserveLinesCoverage(lines, supplyMap, coverageFifoMap = null) {
  if (!Array.isArray(lines)) return;
  for (const line of lines) {
    const r = Math.max(0, Number(line.reservedQty) || 0);
    const pid = Number(line.productId);
    if (r <= 0 || !Number.isFinite(pid) || pid < 1) {
      line.reserveCoverage = 'none';
      continue;
    }
    const oid = Number(line.orderRowDbId);
    const fifoKey = Number.isFinite(oid) && oid > 0 ? `${oid}:${pid}` : null;
    if (fifoKey && coverageFifoMap?.has(fifoKey)) {
      line.reserveCoverage = coverageFifoMap.get(fifoKey);
      continue;
    }
    const sup = supplyMap.get(pid);
    line.reserveCoverage = sup
      ? classifyOrderReserveCoverage({ ...sup, orderReserved: r })
      : 'incoming';
  }
}

function reserveCoverageFromLines(lines) {
  let anyIncoming = false;
  let anyOnHand = false;
  for (const line of lines || []) {
    const k = line.reserveCoverage;
    if (k === 'on_hand') anyOnHand = true;
    if (k === 'incoming') anyIncoming = true;
  }
  if (anyIncoming) return 'incoming';
  if (anyOnHand) return 'on_hand';
  return 'none';
}

async function enrichReserveSummaryCoverage(summary) {
  if (!summary || typeof summary !== 'object') return summary;
  const lines = Array.isArray(summary.lines) ? summary.lines : [];
  const pids = lines.map((l) => Number(l.productId)).filter((id) => id > 0);
  const supplyMap = await batchProductReserveSupplyMap(pids);
  const coverageFifoMap = await buildReserveCoverageFifoMap(pids);
  enrichReserveLinesCoverage(lines, supplyMap, coverageFifoMap);
  summary.reserveCoverage = reserveCoverageFromLines(lines);
  return summary;
}

async function applyReserveCoverageToOrderRow(orderRow, supplyMap, coverageFifoMap = null) {
  const reserved = Math.max(0, Number(orderRow.reservedQty ?? orderRow.reserved_qty) || 0);
  if (reserved <= 0) {
    orderRow.reserveCoverage = 'none';
    orderRow.reserve_coverage = 'none';
    return;
  }
  const oid = orderRowDbId(orderRow);
  if (Number.isFinite(oid) && oid > 0) {
    const byOrder = await buildReserveCoverageByOrderIds([oid]);
    if (byOrder.has(oid)) {
      orderRow.reserveCoverage = byOrder.get(oid);
      orderRow.reserve_coverage = orderRow.reserveCoverage;
      return;
    }
  }
  const pid = Number(orderRow.productId ?? orderRow.product_id);
  const fifoKey =
    Number.isFinite(pid) && pid > 0 && Number.isFinite(oid) && oid > 0 ? `${oid}:${pid}` : null;
  let kind = 'incoming';
  if (fifoKey && coverageFifoMap?.has(fifoKey)) {
    kind = coverageFifoMap.get(fifoKey);
  } else {
    const sup = Number.isFinite(pid) && pid > 0 ? supplyMap.get(pid) : null;
    kind = sup ? classifyOrderReserveCoverage({ ...sup, orderReserved: reserved }) : 'incoming';
  }
  orderRow.reserveCoverage = kind;
  orderRow.reserve_coverage = kind;
}

/** marketplace как в product_skus: ozon | wb | ym */
function marketplaceForProductSkus(marketplace) {
  const m = String(marketplace || '').toLowerCase();
  if (m === 'wildberries' || m === 'wb') return 'wb';
  if (m === 'yandex' || m === 'ym' || m === 'yandexmarket') return 'ym';
  return m === 'ozon' ? 'ozon' : m;
}

/** Базовый ключ заказа для поиска всех строк резерва в БД. */
function orderIdKeyForReserveLookup(marketplace, orderId) {
  let oid = String(orderId ?? '').trim();
  if (!oid) return oid;
  const mp = String(marketplace || '').toLowerCase();
  if (mp === 'yandex' || mp === 'ym' || mp === 'yandexmarket') {
    const i = oid.indexOf(':');
    if (i >= 0) oid = oid.slice(0, i);
  } else if (mp === 'ozon') {
    const t = oid.indexOf('~');
    if (t > 0) oid = oid.slice(0, t);
  } else if (mp === 'manual' && /^manual-\d+-[a-z0-9]+-\d+$/i.test(oid)) {
    oid = oid.replace(/-\d+$/i, '');
  }
  return oid;
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

/** Перевод в «В закупке»: «Новый», «На сборке»; у WB также pending/unknown до резолва статуса. */
export function orderEligibleForProcurement(order) {
  if (!order) return false;
  const sNorm = String(order.status ?? '').trim().toLowerCase();
  if (sNorm === 'new' || sNorm === 'in_assembly' || sNorm === 'wb_assembly') return true;
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

function normalizeProfileIdForOrders(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'string' ? parseInt(v, 10) : Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** marketplace в source_orders / API → как в orders.marketplace */
function orderMarketplaceForProcurementMatch(marketplace) {
  const m = String(marketplace || '').toLowerCase();
  if (m === 'wildberries' || m === 'wb') return 'wb';
  if (m === 'yandex' || m === 'ym' || m === 'yandexmarket') return 'ym';
  if (m === 'manual') return 'manual';
  return m === 'ozon' ? 'ozon' : m;
}

function procurementSupplierMapKey(marketplace, orderId, productId = null) {
  const mp = orderMarketplaceForProcurementMatch(marketplace);
  const oid = String(orderId ?? '').trim();
  if (!mp || !oid) return '';
  const pidNum = Number(productId);
  if (Number.isFinite(pidNum) && pidNum > 0) {
    return `${mp}|${oid}|${pidNum}`;
  }
  return `${mp}|${oid}|`;
}

async function fetchProcurementSupplierLookupMap(profileId) {
  const pid = normalizeProfileIdForOrders(profileId);
  if (pid == null) return new Map();
  const r = await query(
    `SELECT
       pi.product_id,
       s.name AS supplier_name,
       s.id AS supplier_id,
       p.id AS purchase_id,
       elem->>'marketplace' AS src_marketplace,
       elem->>'orderId' AS src_order_id
     FROM purchase_items pi
     INNER JOIN purchases p ON p.id = pi.purchase_id
     LEFT JOIN suppliers s ON s.id = p.supplier_id
     CROSS JOIN LATERAL jsonb_array_elements(COALESCE(pi.source_orders, '[]'::jsonb)) AS elem
     WHERE p.profile_id = $1
       AND p.status = 'open'`,
    [pid]
  );
  const map = new Map();
  for (const row of r.rows || []) {
    const supplierName = row.supplier_name != null ? String(row.supplier_name).trim() : '';
    if (!supplierName) continue;
    const info = {
      supplierName,
      supplierId: row.supplier_id != null ? Number(row.supplier_id) : null,
      purchaseId: row.purchase_id != null ? Number(row.purchase_id) : null,
    };
    const keyWithProduct = procurementSupplierMapKey(
      row.src_marketplace,
      row.src_order_id,
      row.product_id
    );
    if (keyWithProduct && !map.has(keyWithProduct)) {
      map.set(keyWithProduct, info);
    }
    const keyOrder = procurementSupplierMapKey(row.src_marketplace, row.src_order_id, null);
    if (keyOrder && !map.has(keyOrder)) {
      map.set(keyOrder, info);
    }
  }
  return map;
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
    const kitCache = new Map(); // productId -> boolean
    const fastBatch = refs.length > 50;
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
        if (fastBatch) {
          blocked.push({ marketplace: o.marketplace, orderId: oid, reason: 'не определён товар (product_id)' });
          continue;
        }
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
      let isKit = kitCache.get(prodId);
      if (isKit === undefined) {
        isKit = await isKitProductId(prodId);
        kitCache.set(prodId, isKit);
      }
      const reservedForLine =
        orderDbId && Number.isFinite(orderDbId) && isKit
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
      if (!isKit && prodQty < prodRes) {
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
    let row = await this.repository.setAssemblyStickerNumberByMarketplaceAndOrderId(
      marketplace,
      String(orderId),
      stickerNumber,
      profileId
    );
    if (!row) {
      const groupRows = await this._findOrderGroupRows(marketplace, orderId, { profileId });
      const withId = groupRows.find((r) => r?.orderId != null);
      if (withId) {
        row = await this.repository.setAssemblyStickerNumberByMarketplaceAndOrderId(
          marketplace,
          String(withId.orderId),
          stickerNumber,
          profileId
        );
      }
    }
    const gid = row?.orderGroupId ?? row?.order_group_id;
    if (
      gid &&
      typeof this.repository.setAssemblyStickerNumberByOrderGroupId === 'function'
    ) {
      await this.repository.setAssemblyStickerNumberByOrderGroupId(gid, stickerNumber, profileId);
    }
    return row;
  }

  /**
   * Сборка и номер стикера по всем строкам заказа (группа WB/Ozon/YM).
   */
  async getAssemblyInfoForOrder(marketplace, orderId, { profileId = null } = {}) {
    let rows = await this._findOrderGroupRows(marketplace, orderId, { profileId });
    if (!rows.length) {
      const one = await this.getByMarketplaceAndOrderId(marketplace, orderId, { profileId });
      if (one) rows = [one];
    }
    if (!rows.length) return null;

    const assemblyStatuses = new Set(['in_assembly', 'assembled', 'wb_assembly']);
    let assemblyStickerNumber = null;
    let assembledAt = null;
    let assembledByUserId = null;
    let assembledByEmail = null;
    let assembledByFullName = null;
    let onAssembly = false;

    for (const r of rows) {
      if (assemblyStatuses.has(String(r.status ?? '').trim())) onAssembly = true;
      const sn = String(r.assemblyStickerNumber ?? r.assembly_sticker_number ?? '').trim();
      if (sn && !assemblyStickerNumber) assemblyStickerNumber = sn;
      const at = r.assembledAt ?? r.assembled_at;
      if (at && (!assembledAt || new Date(at) > new Date(assembledAt))) {
        assembledAt = at;
        assembledByUserId = r.assembledByUserId ?? r.assembled_by_user_id ?? null;
        assembledByEmail = r.assembledByEmail ?? r.assembled_by_email ?? null;
        assembledByFullName = r.assembledByFullName ?? r.assembled_by_full_name ?? null;
      }
    }

    if (
      !onAssembly &&
      !assembledAt &&
      !assemblyStickerNumber &&
      !assembledByEmail &&
      !assembledByFullName
    ) {
      return null;
    }

    return {
      assembledAt,
      assembledByUserId,
      assembledByEmail,
      assembledByFullName,
      assemblyStickerNumber,
      onAssembly
    };
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

    const { getProductSupplySnapshotWithClient } = await import('./sellableQuantity.service.js');
    const snap = await getProductSupplySnapshotWithClient(null, pid);
    const supplyCap = snap.supplyCap;
    const journalReserved = snap.reserved;
    let excess = journalReserved - supplyCap;
    if (excess <= 0) return { released: 0, ordersTouched: 0 };

    const ordRes = await query(
      `WITH nets AS (
         SELECT (sm.meta->>'order_id')::bigint AS oid,
           ${NET_RESERVED_SUM_EXPR_SQL}::int AS net_r
         FROM stock_movements sm
         WHERE sm.product_id = $1
           AND sm.type IN ('reserve', 'unreserve')
           AND sm.meta ? 'order_id'
           AND (sm.meta->>'order_id') ~ '^[0-9]+$'
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
    // Резерв сериализуется транзакцией в applyChange (FOR UPDATE + pg_advisory_xact_lock).
    // Внешний runWithProductStockLock держал второе соединение из пула и увеличивал очередь HTTP.
    return this._applyReserveForOrderComponentCore(productId, quantity, orderId, meta);
  }

  async _applyReserveForOrderComponentCore(productId, quantity, orderId, meta = {}) {
    if (!productId || quantity < 1) return;
    const qtyWanted = Math.max(1, parseInt(quantity, 10) || 1);

    const reserveAsKitComponentEarly =
      meta?.kit_product_id != null && Number(meta.kit_product_id) > 0;
    const hasKitPrealloc =
      (await isKitProductId(productId)) &&
      !reserveAsKitComponentEarly &&
      meta?.kit_reserve_preallocated != null &&
      Number(meta.kit_reserve_preallocated) > 0;
    if (!hasKitPrealloc) {
      const snapGate = await getProductSupplySnapshotWithClient(null, productId);
      if (Math.floor(snapGate.available) <= 0) return;
    }

    let availableSupply;
    let qty;
    const reserveAsKitComponent =
      meta?.kit_product_id != null && Number(meta.kit_product_id) > 0;
    if (await isKitProductId(productId) && !reserveAsKitComponent) {
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
    } else {
      const wh = meta?.warehouse_id ?? meta?.warehouseId ?? null;
      const kitParentId = reserveAsKitComponent ? Number(meta.kit_product_id) : null;
      if (kitParentId > 0) {
        const orderRow =
          meta?.order_row && typeof meta.order_row === 'object' ? meta.order_row : null;
        availableSupply = await this._getAvailableUnitsForOrderReserveLine(productId, orderRow, {
          warehouseId: wh,
          kitProductId: kitParentId
        });
      } else {
        availableSupply = await getComponentAssemblableUnits(productId, { warehouseId: wh });
      }
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
      const partialLine = meta?.partial_line === true;
      if (partialLine) {
        qty = Math.min(qty, qtyWanted);
      } else {
        if (alreadyForOrder >= qtyWanted) return;
        qty = Math.min(qty, qtyWanted - alreadyForOrder);
      }
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

    const snapBeforeReserve = await getProductSupplySnapshotWithClient(null, productId);
    qty = Math.min(qty, Math.floor(snapBeforeReserve.available));
    if (qty <= 0) return;

    const reserveFromOnHand = Math.min(
      qty,
      onHandHeadroomBeforeReserve(snapBeforeReserve)
    );
    const reserveFromIncoming = Math.max(0, qty - reserveFromOnHand);

    await stockMovementsService.applyChange(productId, {
      delta: -qty,
      type: 'reserve',
      reason,
      meta: {
        ...meta,
        reserve_from_on_hand: reserveFromOnHand,
        reserve_from_incoming: reserveFromIncoming
      }
    });
  }

  /** Есть ли нетто-резерв по строке заказа (orders.id) в журнале. */
  async _hasDbReserveForOrder(orderDbId) {
    if (!orderDbId || !repositoryFactory.isUsingPostgreSQL()) return false;
    const oid = Number(orderDbId);
    if (!Number.isFinite(oid) || oid < 1) return false;
    const or = await query(`SELECT order_id FROM orders WHERE id = $1 LIMIT 1`, [oid]);
    const mpLabel =
      or.rows?.[0]?.order_id != null && String(or.rows[0].order_id).trim() !== ''
        ? String(or.rows[0].order_id).trim()
        : null;
    const r = await query(
      `SELECT ${NET_RESERVED_SUM_EXPR_SQL}::int AS rv
       FROM stock_movements
       WHERE type IN ('reserve', 'unreserve')
         AND ${orderReserveMovementMatchSql('', 1, 2)}`,
      [oid, mpLabel]
    );
    return (Number(r.rows?.[0]?.rv ?? 0) || 0) > 0;
  }

  /** Нетто-резерв под заказ (orders.id) — та же формула, что в kitStock / sellableQuantity. */
  async _getReservedQtyForOrder(orderDbId) {
    if (!orderDbId || !repositoryFactory.isUsingPostgreSQL()) return 0;
    const oid = Number(orderDbId);
    if (!Number.isFinite(oid) || oid < 1) return 0;
    const or = await query(`SELECT order_id FROM orders WHERE id = $1 LIMIT 1`, [oid]);
    const mpLabel =
      or.rows?.[0]?.order_id != null && String(or.rows[0].order_id).trim() !== ''
        ? String(or.rows[0].order_id).trim()
        : null;
    const r = await query(
      `SELECT ${NET_RESERVED_SUM_EXPR_SQL}::int AS rv
       FROM stock_movements
       WHERE type IN ('reserve', 'unreserve')
         AND ${orderReserveMovementMatchSql('', 1, 2)}`,
      [oid, mpLabel]
    );
    return Number(r.rows?.[0]?.rv ?? 0) || 0;
  }

  /** Нетто-резерв под заказ по товару (orders.id + product_id). */
  async _getReservedQtyForOrderProduct(orderDbId, productId) {
    const oid = Number(orderDbId);
    if (!Number.isFinite(oid) || oid < 1) return 0;
    const or = await query(`SELECT order_id FROM orders WHERE id = $1 LIMIT 1`, [oid]);
    const mpLabel =
      or.rows?.[0]?.order_id != null && String(or.rows[0].order_id).trim() !== ''
        ? String(or.rows[0].order_id).trim()
        : null;
    return getNetReservedForOrderProduct(oid, productId, mpLabel);
  }

  /**
   * Снять резервы только по указанным строкам заказа (orders.id в meta движений).
   */
  async _releaseReservesForOrderRows(rows, orderIdLabel, unreserveFn) {
    const affectedAll = [];
    const seenOrderDbId = new Set();

    for (const row of rows || []) {
      const orderDbId = orderRowDbId(row);
      if (!orderDbId || seenOrderDbId.has(orderDbId)) continue;
      seenOrderDbId.add(orderDbId);
      const oid = String(row.orderId ?? row.order_id ?? orderIdLabel);
      const affected = await releaseAllReservesForOrder(orderDbId, oid, unreserveFn);
      for (const p of affected || []) {
        const n = Number(p);
        if (Number.isFinite(n) && n > 0) affectedAll.push(n);
      }
    }

    return [...new Set(affectedAll)];
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
    const preferredWh = await this._resolveOwnWarehouseIdForOrder(orderRow);
    const productId = await this._resolveProductIdForOrderStock(orderRow);
    const warehouseId =
      productId != null
        ? await stockMovementsService.resolveWarehouseIdForProductStock(productId, preferredWh)
        : preferredWh;
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
    const mpForRepo = this._marketplaceToOrdersDb(marketplace);
    let processed = 0;
    let stockOnly = 0;
    let skipped = 0;
    let notFound = 0;

    for (const rawOid of orderIds) {
      const orderId = String(rawOid).trim();
      if (!orderId) continue;
      try {
        const order = await this._findOrderByMarketplaceAndOrderId(mpForRepo, orderId, profileId);
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

  /**
   * После закрытия поставки FBS: внутренний статус «Отгружен» для заказов, оставшихся в orderIds.
   * Дальше синк маркетплейса переводит в in_transit / delivered (не откатываем shipped → assembled).
   * Не трогаем: отменённые, уже «Отгружен», уже «В доставке»/«Доставлен» с МП.
   */
  async markShipmentOrdersAsShipped(marketplace, orderIds, profileId = null) {
    if (!repositoryFactory.isUsingPostgreSQL() || !marketplace || !Array.isArray(orderIds)) {
      return { updated: 0, skipped: 0, notFound: 0 };
    }
    const mpForRepo = this._marketplaceToOrdersDb(marketplace);
    const skipStatuses = new Set([
      'cancelled',
      'canceled',
      'shipped',
      'in_transit',
      'delivered'
    ]);
    let updated = 0;
    let skipped = 0;
    let notFound = 0;

    for (const rawOid of orderIds) {
      const orderId = String(rawOid).trim();
      if (!orderId) continue;
      try {
        const order = await this._findOrderByMarketplaceAndOrderId(mpForRepo, orderId, profileId);
        if (!order) {
          notFound += 1;
          continue;
        }
        const status = String(order.status || '').toLowerCase();
        if (skipStatuses.has(status)) {
          skipped += 1;
          continue;
        }
        if (order.orderGroupId) {
          await this.repository.updateStatusByOrderGroupId(order.orderGroupId, 'shipped', profileId);
        } else {
          await this.repository.updateByMarketplaceAndOrderId(
            mpForRepo,
            orderId,
            { status: 'shipped' },
            profileId
          );
        }
        updated += 1;
      } catch (e) {
        console.warn('[Orders] markShipmentOrdersAsShipped:', orderId, e?.message || e);
      }
    }
    return { updated, skipped, notFound };
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

    const preferredWh = await this._resolveOwnWarehouseIdForOrder(orderRow);
    const warehouseId = await stockMovementsService.resolveWarehouseIdForProductStock(
      productId,
      preferredWh
    );

    const { getProductSupplySnapshotWithClient } = await import('./sellableQuantity.service.js');
    if (!(await isKitProductId(productId))) {
      const snapGate = await getProductSupplySnapshotWithClient(null, productId);
      if (Math.floor(snapGate.available) <= 0) return;
    } else {
      const maxKitsGate = await this._computeMaxKitUnitsReservableForOrder(productId, warehouseId);
      if (maxKitsGate <= 0) return;
    }

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
      try {
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
      } catch (e) {
        if (e?.statusCode === 400) return;
        throw e;
      }
      return;
    }

    const alreadyReservedForOrder = await this._getReservedQtyForOrderProduct(id, productId);
    const need = Math.max(0, qty - alreadyReservedForOrder);
    if (need <= 0) return;

    const snapAvail = await getProductSupplySnapshotWithClient(null, productId);
    if (Math.floor(snapAvail.available) <= 0) return;

    const reserveNow = Math.min(need, Math.floor(snapAvail.available));
    if (reserveNow <= 0) return;

    const snapFinal = await getProductSupplySnapshotWithClient(null, productId);
    if (Math.floor(snapFinal.available) < reserveNow) return;

    try {
      await this._applyReserveForOrder(productId, reserveNow, orderIdStr || String(id), {
        order_id: id,
        orderId: orderIdStr,
        warehouse_id: warehouseId,
        partial: reserveNow < need
      });
    } catch (e) {
      if (e?.statusCode === 400) return;
      throw e;
    }
  }

  /** Подпись позиции заказа для UI резерва (название · артикул). */
  async _orderLineDisplayLabel(row) {
    if (!row) return null;
    const name = String(row.productName ?? row.product_name ?? '').trim();
    const offer = String(row.offerId ?? row.offer_id ?? '').trim();
    const mpSku = row.marketplaceSku ?? row.marketplace_sku;
    const extra =
      mpSku != null && String(mpSku).trim() !== '' && String(mpSku).trim() !== offer
        ? String(mpSku).trim()
        : '';
    const article = offer || extra;
    if (name && article) return `${name} · ${article}`;
    if (name) return name;
    if (article) return article;
    const pid = Number(row.productId ?? row.product_id);
    if (!Number.isFinite(pid) || pid < 1) return null;
    return this._productDisplayLabelById(pid);
  }

  async _productDisplayLabelById(productId) {
    const pid = Number(productId);
    if (!Number.isFinite(pid) || pid < 1) return null;
    try {
      const repo = repositoryFactory.getProductsRepository();
      const pr = repo && typeof repo.findById === 'function' ? await repo.findById(pid) : null;
      if (!pr) return null;
      const pn = String(pr.name ?? '').trim();
      const ps = String(pr.sku ?? '').trim();
      if (pn && ps) return `${pn} · ${ps}`;
      return pn || ps || null;
    } catch {
      return null;
    }
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
    const isKit = await isKitProductId(pid);
    const snapProduct = await getProductSupplySnapshotWithClient(null, pid);
    if (!isKit) {
      if (Math.floor(snapProduct.available) <= 0) return;
    } else {
      const maxKits = await computeMaxKitUnitsReservable(pid);
      if (maxKits <= 0 || Math.floor(snapProduct.available) <= 0) return;
    }

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
        const snapLoop = await getProductSupplySnapshotWithClient(null, fp);
        if (Math.floor(snapLoop.available) <= 0) break;
        if (isKit) {
          const maxK = await computeMaxKitUnitsReservable(fp);
          if (maxK <= 0) break;
        }
        try {
          await this._applyReserveForOrderIfAbsent(o);
        } catch (e) {
          if (e?.statusCode === 400) continue;
        }
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
      const light =
        options.lightReserveEnrich === true ||
        (options.limit != null && Number(options.limit) > 0);
      await this.enrichOrdersReserveMetrics(items, { light });
      await this.enrichOrdersProcurementSuppliers(items, options.profileId);
      return items;
    } else {
      // Старое хранилище
      return await this.repository.findAll();
    }
  }

  /**
   * reservedQty / needQty для списка заказов: сумма по SKU и комплектующим (не SQL по order_id).
   * reserveLines — разбивка для подсказки «артикул: зарезервировано/нужно».
   */
  /**
   * needQty для списка заказов: комплект по SKU заказа, если product_id не указывает на kit_components.
   */
  async _resolveOrderReserveNeedQtyForLight(orderRow, kitPiecesMap, componentKitMap) {
    const qty = Math.max(1, parseInt(orderRow.quantity, 10) || 1);
    const pid = Number(orderRow.productId ?? orderRow.product_id);

    const piecesFromMaps = () => {
      if (!Number.isFinite(pid) || pid < 1) return 0;
      let pieces = kitPiecesMap.get(pid) || 0;
      if (pieces < 1 && componentKitMap.has(pid)) {
        pieces = kitPiecesMap.get(componentKitMap.get(pid)) || 0;
      }
      return pieces;
    };

    let piecesPerKit = piecesFromMaps();
    if (piecesPerKit < 1) {
      const kitId = await findKitProductIdForMarketplaceOrder(
        Number.isFinite(pid) && pid > 0 ? pid : 0,
        orderRow
      );
      if (kitId) {
        if (!kitPiecesMap.has(kitId)) {
          const extra = await batchPiecesPerKitUnitMap([kitId]);
          for (const [kid, pieces] of extra) kitPiecesMap.set(kid, pieces);
        }
        piecesPerKit = kitPiecesMap.get(kitId) || 0;
      }
    }
    return piecesPerKit > 0 ? qty * piecesPerKit : qty;
  }

  /**
   * @param {{ light?: boolean }} enrichOpts — light=true: только reserved_qty из SQL (список заказов, без N+1).
   */
  async enrichOrdersReserveMetrics(orders, enrichOpts = {}) {
    if (!repositoryFactory.isUsingPostgreSQL() || !Array.isArray(orders)) return orders;
    const light = enrichOpts.light === true;
    const supplyPids = [];
    for (const o of orders) {
      const pid = Number(o.productId ?? o.product_id);
      const reserved = Number(o.reservedQty ?? o.reserved_qty) || 0;
      if (Number.isFinite(pid) && pid > 0 && reserved > 0) supplyPids.push(pid);
    }
    const supplyMap = await batchProductReserveSupplyMap(supplyPids);
    const coverageFifoMap = await buildReserveCoverageFifoMap(supplyPids);

    if (light) {
      const pids = orders
        .map((o) => Number(o.productId ?? o.product_id))
        .filter((id) => Number.isFinite(id) && id > 0);
      const kitPiecesMap = await batchPiecesPerKitUnitMap(pids);
      const componentOnlyPids = pids.filter((pid) => !kitPiecesMap.has(pid));
      const componentKitMap = await batchKitIdByComponentMap(componentOnlyPids);
      const extraKitIds = [...new Set(componentKitMap.values())].filter((kid) => !kitPiecesMap.has(kid));
      if (extraKitIds.length) {
        const extra = await batchPiecesPerKitUnitMap(extraKitIds);
        for (const [kid, pieces] of extra) kitPiecesMap.set(kid, pieces);
      }
      const orderReserveNeedQty = (row) => {
        const qty = Math.max(1, parseInt(row.quantity, 10) || 1);
        const pid = Number(row.productId ?? row.product_id);
        if (!Number.isFinite(pid) || pid < 1) return qty;
        let piecesPerKit = kitPiecesMap.get(pid) || 0;
        if (piecesPerKit < 1 && componentKitMap.has(pid)) {
          piecesPerKit = kitPiecesMap.get(componentKitMap.get(pid)) || 0;
        }
        return piecesPerKit > 0 ? qty * piecesPerKit : qty;
      };
      const orderIdsWithReserve = orders
        .map((row) => {
          const reserved = Number(row.reservedQty ?? row.reserved_qty) || 0;
          return reserved > 0 ? orderRowDbId(row) : null;
        })
        .filter(Boolean);
      const coverageByOrderId = await buildReserveCoverageByOrderIds(orderIdsWithReserve);
      for (const o of orders) {
        const reserved = Number(o.reservedQty ?? o.reserved_qty) || 0;
        let need = orderReserveNeedQty(o);
        if (reserved > need) {
          need = await this._resolveOrderReserveNeedQtyForLight(o, kitPiecesMap, componentKitMap);
        }
        o.reservedQty = reserved;
        o.reserved_qty = reserved;
        o.needQty = need;
        o.need_qty = need;
        o.hasReserve = o.hasReserve === true || o.has_reserve === true || reserved > 0;
        o.fullyReserved = need > 0 && reserved >= need;
        const oid = orderRowDbId(o);
        if (oid && coverageByOrderId.has(oid)) {
          o.reserveCoverage = coverageByOrderId.get(oid);
          o.reserve_coverage = o.reserveCoverage;
        } else {
          await applyReserveCoverageToOrderRow(o, supplyMap, coverageFifoMap);
        }
      }
      return orders;
    }
    for (const o of orders) {
      try {
        const orderDbId = orderRowDbId(o);
        if (!orderDbId) continue;
        const sum = await this._summarizeReserveForRows([o]);
        o.reservedQty = sum.reservedQty;
        o.reserved_qty = sum.reservedQty;
        o.needQty = sum.needQty;
        o.need_qty = sum.needQty;
        o.hasReserve = sum.hasReserve;
        o.fullyReserved = sum.fullyReserved;
        o.reserveLines = sum.lines;
        enrichReserveLinesCoverage(sum.lines, supplyMap, coverageFifoMap);
        o.reserveCoverage = reserveCoverageFromLines(sum.lines);
        o.reserve_coverage = o.reserveCoverage;
        if (o.reserveCoverage === 'none') {
          await applyReserveCoverageToOrderRow(o, supplyMap, coverageFifoMap);
        }
      } catch {
        /* ignore */
      }
    }
    return orders;
  }

  /**
   * Для заказов «В закупке» — поставщик из открытой закупки (purchase_items.source_orders).
   */
  async enrichOrdersProcurementSuppliers(orders, profileId = null) {
    if (!repositoryFactory.isUsingPostgreSQL() || !Array.isArray(orders) || !orders.length) {
      return orders;
    }
    const hasProcurement = orders.some(
      (o) => String(o.status || '').trim().toLowerCase() === 'in_procurement'
    );
    if (!hasProcurement) return orders;

    const lookup = await fetchProcurementSupplierLookupMap(profileId);
    if (!lookup.size) return orders;

    for (const o of orders) {
      if (String(o.status || '').trim().toLowerCase() !== 'in_procurement') continue;
      const mp = o.marketplace;
      const oid = o.orderId ?? o.order_id;
      const pid = o.productId ?? o.product_id;
      const info =
        lookup.get(procurementSupplierMapKey(mp, oid, pid)) ||
        lookup.get(procurementSupplierMapKey(mp, oid, null));
      if (!info) continue;
      o.procurementSupplierName = info.supplierName;
      o.procurement_supplier_name = info.supplierName;
      o.procurementSupplierId = info.supplierId;
      o.procurement_supplier_id = info.supplierId;
      o.procurementPurchaseId = info.purchaseId;
      o.procurement_purchase_id = info.purchaseId;
    }
    return orders;
  }

  /**
   * Фоново дозарезервировать строки списка заказов, где есть остаток, но резерв неполный.
   * (например после ручной корректировки наличия или если заказ пришёл раньше поступления).
   */
  _scheduleEnsureReservesForUnderReservedOrders(orders) {
    if (!repositoryFactory.isUsingPostgreSQL() || !Array.isArray(orders) || !orders.length) {
      return;
    }
    const rows = orders.filter((o) => {
      const st = String(o.status || '').trim().toLowerCase();
      if (!['new', 'in_procurement', 'in_assembly'].includes(st)) return false;
      const need = Math.max(
        1,
        Number(o.needQty ?? o.need_qty ?? o.quantity) || parseInt(o.quantity, 10) || 1
      );
      const reserved = Number(o.reservedQty ?? o.reserved_qty) || 0;
      return reserved < need;
    });
    if (!rows.length) return;
    const copy = rows.slice();
    setImmediate(() => {
      this._reapplyReserveForOrderRows(copy).catch(() => {});
    });
  }

  async getPage(options = {}) {
    if (repositoryFactory.isUsingPostgreSQL()) {
      const lightReserve = options.lightReserveEnrich !== false;
      const countPromise =
        typeof this.repository.countAll === 'function'
          ? this.repository.countAll(options)
          : Promise.resolve(null);
      const [items, total] = await Promise.all([this.repository.findAll(options), countPromise]);
      await this.enrichOrdersReserveMetrics(items, { light: lightReserve });
      await this.enrichOrdersProcurementSuppliers(items, options.profileId);
      this._scheduleEnsureReservesForUnderReservedOrders(items);
      return { items, total: total ?? items.length };
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

  /**
   * Сколько единиц можно зарезервировать по позиции (комплектующая / комплект / обычный товар).
   * Для комплектующей заказа-комплекта — supply SKU и собираемость родительского комплекта.
   */
  async _getAvailableUnitsForOrderReserveLine(productId, orderRow, { warehouseId = null, kitProductId = null } = {}) {
    const pid = Number(productId);
    if (!Number.isFinite(pid) || pid < 1) return 0;

    const kitId =
      kitProductId != null && Number.isFinite(Number(kitProductId))
        ? Number(kitProductId)
        : null;

    if (kitId != null && kitId > 0 && pid !== kitId && (await isKitProductId(kitId))) {
      const components = await getKitComponents(kitId);
      const comp = components.find((c) => Number(c.component_product_id) === pid);
      const perKit = comp ? Math.max(1, parseInt(comp.quantity, 10) || 1) : 1;
      const snap = await getProductSupplySnapshotWithClient(null, pid);
      const compAvail = snap.available;
      const maxKits = await this._computeMaxKitUnitsReservableForOrder(kitId, warehouseId);
      return Math.min(Math.floor(compAvail), Math.floor(maxKits) * perKit);
    }

    if (await isKitProductId(pid)) {
      return Math.floor(await this._computeMaxKitUnitsReservableForOrder(pid, warehouseId));
    }

    const snap = await getProductSupplySnapshotWithClient(null, pid);
    return Math.floor(snap.available);
  }

  /** Повторная попытка резерва (новый / закупка / после поступления остатка). */
  async _reapplyReserveForOrderRows(rows) {
    const list = [...(Array.isArray(rows) ? rows : [])].sort((a, b) => {
      const qa = Math.max(1, parseInt(a?.quantity ?? a?.qty ?? 1, 10) || 1);
      const qb = Math.max(1, parseInt(b?.quantity ?? b?.qty ?? 1, 10) || 1);
      return qb - qa;
    });
    const excludeIds = list.map((r) => orderRowDbId(r)).filter((id) => id != null);
    const touchedKitIds = new Set();
    for (const row of list) {
      if (!row) continue;
      try {
        const pid = await this._resolveProductIdForOrderStock(row);
        const pnum = Number(pid);
        if (Number.isFinite(pnum) && pnum > 0) {
          if (await isKitProductId(pnum)) {
            const wh = await this._resolveOwnWarehouseIdForOrder(row);
            const warehouseId = await stockMovementsService.resolveWarehouseIdForProductStock(pnum, wh);
            const maxKits = await this._computeMaxKitUnitsReservableForOrder(pnum, warehouseId);
            if (maxKits <= 0) continue;
          } else {
            const snapRow = await getProductSupplySnapshotWithClient(null, pnum);
            if (Math.floor(snapRow.available) <= 0) continue;
          }
        }
        await this._applyReserveForOrderIfAbsent(row);
      } catch (e) {
        if (e?.statusCode !== 400) {
          /* ignore */
        }
      }
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
  async _sendToAssemblyPostgresBulk(orderIds, profileId, { deferReserve }) {
    const preserveStatuses = ['assembled', 'shipped', 'in_transit', 'delivered', 'cancelled'];
    const values = [];
    const params = [];
    let i = 1;
    for (const { marketplace, orderId } of orderIds) {
      if (!marketplace || orderId == null) continue;
      values.push(`($${i++}::text, $${i++}::text)`);
      params.push(this._marketplaceToOrdersDb(marketplace), String(orderId));
    }
    if (values.length === 0) {
      return { sent: orderIds.length, updated: 0, statusPreserved: 0, reserveRows: [] };
    }

    let profileSql = '';
    const pid = profileId != null && String(profileId).trim() !== '' ? Number(profileId) : null;
    if (pid && Number.isFinite(pid)) {
      profileSql = ` AND o.profile_id = $${i++}`;
      params.push(pid);
    }

    const preserveIdx = i++;
    params.push(preserveStatuses);

    const preservedRes = await query(
      `
      WITH refs(marketplace, order_id) AS (VALUES ${values.join(',')})
      SELECT COUNT(*)::int AS cnt
      FROM orders o
      INNER JOIN refs r ON o.marketplace = r.marketplace AND o.order_id = r.order_id
      WHERE o.status::text = ANY($${preserveIdx}::text[])
      ${profileSql}
      `,
      params
    );
    const statusPreserved = Number(preservedRes.rows?.[0]?.cnt) || 0;

    const upd = await query(
      `
      WITH refs(marketplace, order_id) AS (VALUES ${values.join(',')})
      UPDATE orders o
      SET status = 'in_assembly',
          returned_to_new_at = NULL,
          updated_at = CURRENT_TIMESTAMP
      FROM refs r
      WHERE o.marketplace = r.marketplace
        AND o.order_id = r.order_id
        AND (o.status IS NULL OR NOT (o.status::text = ANY($${preserveIdx}::text[])))
      ${profileSql}
      RETURNING o.*
      `,
      params
    );

    const updated = upd.rowCount ?? 0;
    const reserveRows = upd.rows || [];

    const runReserveBackground = (rows) => {
      setImmediate(() => {
        void (async () => {
          const pids = new Set();
          for (const row of rows) {
            await this._applyReserveForOrderIfAbsent(row).catch(() => {});
            let productId = await this._resolveProductIdForOrderStock(row).catch(() => null);
            if (!productId) productId = row.product_id;
            const pn = Number(productId);
            if (Number.isFinite(pn) && pn > 0) pids.add(pn);
          }
          for (const productId of pids) {
            await this.ensureReservesForProductIfSupplyAvailable(productId).catch(() => {});
          }
        })();
      });
    };

    if (deferReserve && reserveRows.length > 0) {
      runReserveBackground(reserveRows);
    } else if (!deferReserve && reserveRows.length > 0) {
      const pids = new Set();
      for (const row of reserveRows) {
        await this._applyReserveForOrderIfAbsent(row).catch(() => {});
        let productId = await this._resolveProductIdForOrderStock(row).catch(() => null);
        if (!productId) productId = row.product_id;
        const pn = Number(productId);
        if (Number.isFinite(pn) && pn > 0) pids.add(pn);
      }
      for (const productId of pids) {
        await this.ensureReservesForProductIfSupplyAvailable(productId).catch(() => {});
      }
    }

    return { sent: orderIds.length, updated, statusPreserved };
  }

  async sendToAssembly(orderIds, profileId = null, options = {}) {
    if (!Array.isArray(orderIds) || orderIds.length === 0) {
      return { sent: 0, updated: 0, statusPreserved: 0 };
    }
    const deferReserve = options.deferReserve === true;
    if (repositoryFactory.isUsingPostgreSQL()) {
      return this._sendToAssemblyPostgresBulk(orderIds, profileId, { deferReserve });
    }

    let updated = 0;
    const { readData, writeData } = await import('../utils/storage.js');
    const data = await readData('orders');
    const orders = (data?.orders && [...data.orders]) || [];
    const set = new Set(orderIds.map((o) => `${o.marketplace}|${o.orderId}`));
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
    return { sent: orderIds.length, updated, statusPreserved: 0 };
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
  _scheduleReapplyReserveForOrderRows(rows) {
    const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
    if (list.length === 0) return;
    const copy = list.map((r) => ({ ...r }));
    setImmediate(() => {
      this._reapplyReserveForOrderRows(copy).catch((e) => {
        console.warn('[Orders] reapply reserve after return-to-new:', e?.message || e);
      });
    });
  }

  /** Резерв после return-to-new — только в фоне (не блокировать HTTP). */
  _scheduleReapplyReserveAfterReturnToNew({ orderGroupId, marketplace, orderId, profileId }) {
    setImmediate(() => {
      void (async () => {
        let rows = [];
        if (orderGroupId) {
          rows = (await this.repository.findByOrderGroupId(orderGroupId, profileId)) || [];
          rows = rows.filter((row) => String(row.status || '').toLowerCase() === 'new');
        } else if (marketplace && orderId != null) {
          const r = await this.repository.findByMarketplaceAndOrderIdLite(
            marketplace,
            String(orderId),
            profileId
          );
          if (r) rows = [r];
        }
        if (rows.length > 0) await this._reapplyReserveForOrderRows(rows);
      })().catch((e) => {
        console.warn('[Orders] background reserve after return-to-new:', e?.message || e);
      });
    });
  }

  async returnOrderToNew(marketplace, orderId, profileId = null, opts = {}) {
    if (!marketplace || orderId == null) return null;
    if (repositoryFactory.isUsingPostgreSQL()) {
      const findLite =
        typeof this.repository.findByMarketplaceAndOrderIdLite === 'function'
          ? (mp, oid, pid) => this.repository.findByMarketplaceAndOrderIdLite(mp, oid, pid)
          : (mp, oid, pid) => this.repository.findByMarketplaceAndOrderId(mp, oid, pid);
      const order = await findLite(marketplace, String(orderId), profileId);
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
        if (!opts.skipReserveReapply) {
          this._scheduleReapplyReserveAfterReturnToNew({
            orderGroupId: order.orderGroupId,
            profileId,
          });
        }
        return { ...order, status: 'new' };
      }
      await this.repository.updateByMarketplaceAndOrderId(marketplace, String(orderId), { status: 'new' }, profileId);
      if (!opts.skipReserveReapply) {
        this._scheduleReapplyReserveAfterReturnToNew({ marketplace, orderId, profileId });
      }
      return { ...order, status: 'new' };
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
   * Перевести заказ в статус «В закупке» (in_procurement). Из «Новый» или «На сборке».
   * Если у заказа есть orderGroupId — обновляются все заказы группы.
   */
  _scheduleReapplyReserveAfterProcurement({ orderGroupId, marketplace, orderId, profileId }) {
    setImmediate(() => {
      void (async () => {
        let rows = [];
        if (orderGroupId) {
          rows = (await this.repository.findByOrderGroupId(orderGroupId, profileId)) || [];
        } else if (marketplace && orderId != null) {
          const findLite =
            typeof this.repository.findByMarketplaceAndOrderIdLite === 'function'
              ? (mp, oid, pid) => this.repository.findByMarketplaceAndOrderIdLite(mp, oid, pid)
              : (mp, oid, pid) => this.repository.findByMarketplaceAndOrderId(mp, oid, pid);
          const r = await findLite(marketplace, String(orderId), profileId);
          if (r) rows = [r];
        }
        if (rows.length > 0) await this._reapplyReserveForOrderRows(rows);
      })().catch((e) => {
        console.warn('[Orders] background reserve after procurement:', e?.message || e);
      });
    });
  }

  async setOrderToProcurement(marketplace, orderId, profileId = null, opts = {}) {
    if (!marketplace || orderId == null) return null;
    if (repositoryFactory.isUsingPostgreSQL()) {
      const findLite =
        typeof this.repository.findByMarketplaceAndOrderIdLite === 'function'
          ? (mp, oid, pid) => this.repository.findByMarketplaceAndOrderIdLite(mp, oid, pid)
          : (mp, oid, pid) => this.repository.findByMarketplaceAndOrderId(mp, oid, pid);
      const order = await findLite(marketplace, String(orderId), profileId);
      if (!order) return null;
      const stNorm = String(order.status ?? '').trim().toLowerCase();
      if (stNorm === 'in_procurement') return order;
      if (!orderEligibleForProcurement(order)) return null;
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
      if (!opts.skipReserveReapply) {
        this._scheduleReapplyReserveAfterProcurement({
          orderGroupId: order.orderGroupId || null,
          marketplace,
          orderId,
          profileId,
        });
      }
      return { ...order, status: 'in_procurement' };
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
   * Массово «В закупке»: один проход SQL + резерв в фоне (без N× findByMarketplaceAndOrderId).
   */
  async _bulkSetToProcurementPg(items, profileId = null, { skipReserveReapply = false } = {}) {
    const eligibleStatusSql = `(
      o.status IN ('new', 'in_assembly', 'wb_assembly')
      OR (
        o.marketplace = 'wb'
        AND (
          o.status = '__wb_status_pending__'
          OR LOWER(COALESCE(o.status, '')) = 'wb_status_unknown'
        )
      )
    )`;

    const values = [];
    const params = [];
    let i = 1;
    const seen = new Set();
    let skipped = 0;
    for (const it of items) {
      const mp = this._marketplaceToOrdersDb(it?.marketplace);
      const oid = it?.orderId != null ? String(it.orderId).trim() : '';
      if (!mp || !oid) {
        skipped += 1;
        continue;
      }
      const dk = `${mp}|${oid}`;
      if (seen.has(dk)) continue;
      seen.add(dk);
      values.push(`($${i++}::text, $${i++}::text)`);
      params.push(mp, oid);
    }
    if (values.length === 0) {
      return { updated: 0, skipped: items.length };
    }

    let profileSql = '';
    const pid = profileId != null && String(profileId).trim() !== '' ? Number(profileId) : null;
    if (pid && Number.isFinite(pid)) {
      profileSql = ` AND o.profile_id = $${i++}`;
      params.push(pid);
    }

    const seedRes = await query(
      `
      WITH refs(marketplace, order_id) AS (VALUES ${values.join(',')})
      SELECT o.id, o.marketplace, o.order_id, o.order_group_id, o.product_id, o.quantity,
             o.offer_id, o.marketplace_sku, o.product_name, o.delivery_address, o.status
      FROM orders o
      INNER JOIN refs r ON o.marketplace = r.marketplace AND o.order_id = r.order_id
      WHERE ${eligibleStatusSql}
      ${profileSql}
      `,
      params
    );
    const seedRows = seedRes.rows || [];
    skipped += Math.max(0, seen.size - seedRows.length);

    const groupIds = [
      ...new Set(
        seedRows
          .map((r) => (r.order_group_id != null ? String(r.order_group_id).trim() : ''))
          .filter(Boolean)
      ),
    ];
    const singleIds = seedRows
      .filter((r) => !r.order_group_id || String(r.order_group_id).trim() === '')
      .map((r) => r.id);

    const updatedById = new Map();

    if (groupIds.length > 0) {
      const gParams = [groupIds];
      let gProfileSql = '';
      if (pid && Number.isFinite(pid)) {
        gProfileSql = ' AND o.profile_id = $2';
        gParams.push(pid);
      }
      const gUp = await query(
        `
        UPDATE orders o
        SET status = 'in_procurement',
            returned_to_new_at = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE o.order_group_id = ANY($1::text[])
        ${gProfileSql}
        RETURNING o.*
        `,
        gParams
      );
      for (const row of gUp.rows || []) {
        if (row?.id != null) updatedById.set(row.id, row);
      }
    }

    if (singleIds.length > 0) {
      const sParams = [singleIds];
      let sProfileSql = '';
      if (pid && Number.isFinite(pid)) {
        sProfileSql = ' AND o.profile_id = $2';
        sParams.push(pid);
      }
      const sUp = await query(
        `
        UPDATE orders o
        SET status = 'in_procurement',
            returned_to_new_at = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE o.id = ANY($1::bigint[])
        ${sProfileSql}
        RETURNING o.*
        `,
        sParams
      );
      for (const row of sUp.rows || []) {
        if (row?.id != null) updatedById.set(row.id, row);
      }
    }

    const uniqueRows = [...updatedById.values()];
    if (uniqueRows.length > 0 && !skipReserveReapply) {
      setImmediate(() => {
        this._reapplyReserveForOrderRows(uniqueRows).catch((e) => {
          console.warn('[Orders] bulk reapply reserve after procurement:', e?.message || e);
        });
      });
    }

    return { updated: seedRows.length, skipped, rows: uniqueRows };
  }

  /**
   * Массово перевести заказы в «В закупке» и один раз дозарезервировать (без N тяжёлых HTTP-вызовов).
   * @param {{ marketplace: string, orderId: string }[]} items
   */
  async bulkSetToProcurement(items, profileId = null, options = {}) {
    const refs = Array.isArray(items) ? items : [];
    if (!repositoryFactory.isUsingPostgreSQL() || refs.length === 0) {
      return { updated: 0, skipped: refs.length, rows: [] };
    }
    return this._bulkSetToProcurementPg(refs, profileId, options);
  }

  /**
   * Массово вернуть заказы в «Новый» (один HTTP-запрос, резерв в фоне).
   * @param {{ marketplace: string, orderId: string }[]} items
   */
  async bulkReturnToNew(items, profileId = null) {
    const refs = Array.isArray(items) ? items : [];
    if (!repositoryFactory.isUsingPostgreSQL() || refs.length === 0) {
      return { updated: 0, skipped: refs.length };
    }
    const seen = new Set();
    const rowsForReserve = [];
    let updated = 0;
    let skipped = 0;

    for (const it of refs) {
      const mp = it?.marketplace != null ? String(it.marketplace).trim() : '';
      const oid = it?.orderId != null ? String(it.orderId).trim() : '';
      if (!mp || !oid) {
        skipped += 1;
        continue;
      }
      const dedupeKey = `${mp.toLowerCase()}|${oid}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const order = await this.returnOrderToNew(mp, oid, profileId, { skipReserveReapply: true });
      if (!order) {
        skipped += 1;
        continue;
      }
      updated += 1;
      const groupRows = order.orderGroupId
        ? await this.repository.findByOrderGroupId(order.orderGroupId, profileId)
        : [order];
      for (const r of groupRows) {
        if (String(r.status || '').toLowerCase() === 'new') {
          const rid = orderRowDbId(r);
          if (rid != null) rowsForReserve.push(r);
        }
      }
    }

    const reserveByDbId = new Map();
    for (const r of rowsForReserve) {
      const rid = orderRowDbId(r);
      if (rid != null) reserveByDbId.set(rid, r);
    }
    this._scheduleReapplyReserveForOrderRows([...reserveByDbId.values()]);

    return { updated, skipped };
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
  /**
   * Строка заказа (orders.id), к которой привязан резерв по productId.
   * Для YM/Ozon с несколькими товарами в одном order_id нельзя брать rows[0].
   */
  async _findOrderRowForReserveProduct(rows, productId) {
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) return null;
    const pid = Number(productId);
    if (!Number.isFinite(pid) || pid < 1) return list[0];

    for (const r of list) {
      const direct = Number(r.productId ?? r.product_id);
      if (direct === pid) return r;
    }
    for (const r of list) {
      try {
        const resolved = await this._resolveProductIdForOrderStock(r);
        if (Number(resolved) === pid) return r;
      } catch {
        /* ignore */
      }
    }
    for (const r of list) {
      const id = orderRowDbId(r);
      if (!id) continue;
      const net = await this._getReservedQtyForOrderProduct(id, pid);
      if (net > 0) return r;
    }
    return list[0];
  }

  /** Все строки orders.id одного заказа (группа, несколько offerId, ручной заказ). */
  async _mergeOrderRowsForReserve(initialRows, { profileId = null } = {}) {
    const map = new Map();
    const queue = [];
    const add = (r) => {
      const id = orderRowDbId(r);
      if (id == null) return;
      const k = String(id);
      if (!map.has(k)) {
        map.set(k, r);
        queue.push(r);
      }
    };
    for (const r of initialRows || []) add(r);
    const seenGid = new Set();
    while (queue.length) {
      const r = queue.shift();
      const gid = String(r.orderGroupId ?? r.order_group_id ?? '').trim();
      if (!gid || seenGid.has(gid)) continue;
      seenGid.add(gid);
      const more = await this.repository.findByOrderGroupId(gid, profileId);
      for (const m of more || []) add(m);
    }
    return [...map.values()].sort((a, b) => Number(a.id) - Number(b.id));
  }

  /** Все строки orders для резерва: по ключу заказа + order_group_id + слияние дубликатов. */
  async _collectOrderRowsForReserve(marketplace, orderId, { profileId = null } = {}) {
    const oid = orderIdKeyForReserveLookup(marketplace, orderId);
    if (!oid || !marketplace) return [];

    let rows = await this._findOrderRowsForReserve(marketplace, orderId, { profileId });
    if (!repositoryFactory.isUsingPostgreSQL()) return rows;

    const map = new Map();
    const add = (r) => {
      const id = orderRowDbId(r);
      if (id != null) map.set(String(id), r);
    };
    for (const r of rows) add(r);

    const gids = new Set();
    for (const r of rows) {
      const gid = String(r.orderGroupId ?? r.order_group_id ?? '').trim();
      if (gid) gids.add(gid);
    }
    if (!gids.size && oid) gids.add(oid);

    for (const gid of gids) {
      const groupRows = await this.repository.findByOrderGroupId(gid, profileId);
      for (const gr of groupRows || []) add(gr);
    }

    const byKey = await this.repository.findRowsForReserveByOrderKey(marketplace, oid, profileId);
    for (const r of byKey || []) add(r);

    return [...map.values()].sort((a, b) => Number(a.id) - Number(b.id));
  }

  /** Позиции из detail API (YM items, Ozon products, WB — одна строка). */
  _extractDetailLineItems(detail, marketplace) {
    if (!detail || typeof detail !== 'object') return [];
    const mp = String(marketplace || '').toLowerCase();
    if (mp === 'yandex' || mp === 'ym' || mp === 'yandexmarket') {
      const items = Array.isArray(detail.items) ? detail.items : [];
      return items.map((it) => ({
        offerId: it?.offerId ?? it?.offer_id ?? '',
        name: it?.offerName ?? it?.offer_name ?? it?.name ?? '',
        count: it?.count ?? it?.quantity ?? 1
      }));
    }
    if (mp === 'ozon') {
      const products = Array.isArray(detail.products) ? detail.products : [];
      return products.map((p) => ({
        offerId: p?.offer_id ?? p?.offerId ?? '',
        name: p?.name ?? '',
        count: p?.quantity ?? 1
      }));
    }
    if (mp === 'wildberries' || mp === 'wb') {
      return [
        {
          offerId: detail.article ?? detail.offerId ?? '',
          name: detail.productName ?? detail.product_name ?? '',
          count: detail.quantity ?? 1
        }
      ];
    }
    return [];
  }

  /** Дополнить резерв позициями из API МП, если в БД ещё одна строка (типично YM до повторного синка). */
  async _augmentReserveFromDetailItems(summary, marketplace, orderId, rows, { profileId = null } = {}) {
    if (!rows?.length) return summary;
    // Несколько строк уже в БД — API МП не нужен (иначе таймаут 90 с при синхронизации).
    if (rows.length > 1) return summary;
    let detailItems = [];
    try {
      const { default: ordersSyncService } = await import('./orders.sync.service.js');
      const MP_AUGMENT_MS = Number(process.env.ORDER_RESERVE_MP_AUGMENT_MS) || 12000;
      const pack = await Promise.race([
        ordersSyncService.getOrderDetail(marketplace, orderId, { profileId }),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('ORDER_DETAIL_MP_TIMEOUT')), MP_AUGMENT_MS);
        })
      ]);
      detailItems = this._extractDetailLineItems(pack?.detail, marketplace);
    } catch {
      return summary;
    }
    if (detailItems.length <= 1) return summary;

    const rowsByOffer = new Map();
    for (const r of rows) {
      const off = String(r.offerId ?? r.offer_id ?? '').trim().toLowerCase();
      if (off) rowsByOffer.set(off, r);
    }

    const extraRows = [...rows];
    const baseOid = orderIdKeyForReserveLookup(marketplace, orderId);
    const gid =
      String(rows[0]?.orderGroupId ?? rows[0]?.order_group_id ?? '').trim() || baseOid;

    for (const it of detailItems) {
      const offer = String(it.offerId ?? '').trim();
      if (!offer) continue;
      const key = offer.toLowerCase();
      if (rowsByOffer.has(key)) continue;
      extraRows.push({
        marketplace,
        orderId: `${baseOid}:${offer}`,
        order_group_id: gid,
        orderGroupId: gid,
        offer_id: offer,
        offerId: offer,
        product_name: it.name || offer,
        productName: it.name || offer,
        quantity: Math.max(1, parseInt(it.count, 10) || 1),
        product_id: null,
        productId: null
      });
      rowsByOffer.set(key, extraRows[extraRows.length - 1]);
    }

    if (extraRows.length <= rows.length) return summary;
    return this._summarizeReserveForRows(extraRows);
  }

  async _findOrderRowsForReserve(marketplace, orderId, { profileId = null } = {}) {
    const oid = orderIdKeyForReserveLookup(marketplace, orderId);
    if (!oid || !marketplace) return [];

    if (repositoryFactory.isUsingPostgreSQL()) {
      const byKey = await this.repository.findRowsForReserveByOrderKey(marketplace, oid, profileId);
      const byGroup = await this._findOrderGroupRows(marketplace, orderId, { profileId });
      let rows = [...byKey, ...byGroup];
      if (!rows.length) {
        rows = await this.repository.findByOrderGroupId(oid, profileId);
      }
      if (!rows.length) {
        const one = await this.repository.findByMarketplaceAndOrderId(marketplace, oid, profileId);
        if (one) rows = [one];
      }
      return this._mergeOrderRowsForReserve(rows, { profileId });
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
    const lines = [];
    for (const row of rows || []) {
      const id = orderRowDbId(row);
      const qty = Math.max(1, parseInt(row.quantity, 10) || 1);
      let reserved = 0;
      let productId = id ? await this._resolveProductIdForOrderStock(row).catch(() => null) : null;
      if (!productId && id) {
        productId = await this.resolveProductIdForAssemblyLine(row).catch(() => null);
      }
      const pid = Number(productId);
      const lineEntries = [];
      const orderLineLabel = await this._orderLineDisplayLabel(row);

      if (id && Number.isFinite(pid) && pid > 0 && (await isKitProductId(pid))) {
        reserved = await getReservedKitUnitsForOrder(pid, id);
        const preferredWh = await this._resolveOwnWarehouseIdForOrder(row);
        const warehouseId = await stockMovementsService.resolveWarehouseIdForProductStock(
          pid,
          preferredWh
        );
        const onKitRes = await this._getReservedQtyForOrderProduct(id, pid);
        if (onKitRes > 0) {
          lineEntries.push({
            productId: pid,
            reservedQty: onKitRes,
            needQty: qty,
            availableQty: await this._getAvailableUnitsForOrderReserveLine(pid, row, {
              warehouseId
            }),
            lineKind: 'kit_whole',
            label: orderLineLabel || 'Комплект (целым SKU)'
          });
        }
        const components = await getKitComponents(pid);
        for (const c of components) {
          const compId = Number(c.component_product_id);
          if (!Number.isFinite(compId) || compId < 1) continue;
          const perKit = Math.max(1, parseInt(c.quantity, 10) || 1);
          const compRes = await this._getReservedQtyForOrderProduct(id, compId);
          if (compRes <= 0 && onKitRes > 0) continue;
          const compLabel = (await this._productDisplayLabelById(compId)) || 'Комплектующая';
          lineEntries.push({
            productId: compId,
            reservedQty: compRes,
            needQty: qty * perKit,
            perKitQty: perKit,
            reservedKitUnits: Math.floor(compRes / perKit),
            needKitUnits: qty,
            availableQty: await this._getAvailableUnitsForOrderReserveLine(compId, row, {
              warehouseId,
              kitProductId: pid
            }),
            lineKind: 'component',
            kitProductId: pid,
            label: `${compLabel} (×${perKit} в комплекте)`
          });
        }
        if (lineEntries.length === 0 && reserved > 0) {
          lineEntries.push({
            productId: pid,
            reservedQty: reserved,
            needQty: qty,
            lineKind: 'kit',
            label: orderLineLabel || 'Комплект'
          });
        }
      } else if (id && Number.isFinite(pid) && pid > 0) {
        reserved = await this._getReservedQtyForOrderProduct(id, pid);
        const preferredWh = await this._resolveOwnWarehouseIdForOrder(row);
        const warehouseId = await stockMovementsService.resolveWarehouseIdForProductStock(
          pid,
          preferredWh
        );
        lineEntries.push({
          productId: pid,
          reservedQty: reserved,
          needQty: qty,
          availableQty: await this._getAvailableUnitsForOrderReserveLine(pid, row, { warehouseId }),
          lineKind: 'product',
          label: orderLineLabel || (await this._productDisplayLabelById(pid))
        });
      } else if (id) {
        reserved = await this._getReservedQtyForOrder(id);
        lineEntries.push({
          productId: row.productId ?? row.product_id ?? null,
          reservedQty: reserved,
          needQty: qty,
          lineKind: 'unknown',
          label: orderLineLabel
        });
      }

      if (lineEntries.length === 0) {
        lineEntries.push({
          productId: Number.isFinite(pid) && pid > 0 ? pid : null,
          reservedQty: reserved,
          needQty: qty,
          lineKind: Number.isFinite(pid) && pid > 0 ? 'product' : 'unknown',
          label: orderLineLabel || row.productName || row.product_name || 'Позиция заказа'
        });
      }

      for (const le of lineEntries) {
        lines.push({
          orderLineId: row.orderId ?? row.order_id,
          orderRowDbId: id,
          productName: row.productName ?? row.product_name ?? null,
          offerId: row.offerId ?? row.offer_id ?? null,
          ...le
        });
      }
    }
    const needQty = lines.reduce((s, l) => s + (Number(l.needQty) || 0), 0);
    const reservedQty = lines.reduce((s, l) => s + (Number(l.reservedQty) || 0), 0);
    return {
      hasReserve: reservedQty > 0,
      reservedQty,
      needQty,
      fullyReserved: needQty > 0 && reservedQty >= needQty,
      lines
    };
  }

  _reserveToggleMessage(before, after, doUnreserve) {
    if (doUnreserve) {
      const removed = Math.max(0, (before?.reservedQty ?? 0) - (after?.reservedQty ?? 0));
      if (!after?.hasReserve) {
        return removed > 0
          ? `Резерв снят (${removed} из ${before?.needQty ?? after?.needQty ?? 0})`
          : 'Резерв снят';
      }
      if (removed > 0) {
        return `Снято ${removed} из ${before?.needQty ?? 0}, в резерве осталось ${after.reservedQty} из ${after.needQty}`;
      }
      return 'Резерв не снят — обновите страницу или проверьте историю остатков';
    }
    if ((after?.reservedQty ?? 0) <= (before?.reservedQty ?? 0)) {
      return after?.needQty > 0
        ? `Недостаточно остатка для резерва (сейчас ${after.reservedQty} из ${after.needQty})`
        : 'Резерв не изменён';
    }
    if (after.fullyReserved) {
      return `Резерв установлен: ${after.reservedQty} из ${after.needQty}`;
    }
    return `Резерв частично установлен: ${after.reservedQty} из ${after.needQty}`;
  }

  async getOrderReserveSummary(
    marketplace,
    orderId,
    { profileId = null, skipDetailAugment = false } = {}
  ) {
    const rows = await this._collectOrderRowsForReserve(marketplace, orderId, { profileId });
    if (!rows.length) {
      const err = new Error('Заказ не найден в системе');
      err.statusCode = 404;
      throw err;
    }
    let summary = await this._summarizeReserveForRows(rows);
    if (!skipDetailAugment) {
      summary = await this._augmentReserveFromDetailItems(summary, marketplace, orderId, rows, {
        profileId
      });
    }
    return enrichReserveSummaryCoverage(summary);
  }

  /**
   * Резерв / снятие резерва по одному товару (или комплектующей) в заказе.
   * @param {number|null} [quantity] — сколько единиц; null = максимум доступный / весь нетто-резерв
   */
  async setOrderReserveForProduct(
    marketplace,
    orderId,
    { profileId = null, productId, action = 'toggle', quantity = null } = {}
  ) {
    if (!repositoryFactory.isUsingPostgreSQL()) {
      const err = new Error('Резерв по заказам доступен только при использовании PostgreSQL');
      err.statusCode = 501;
      throw err;
    }
    const pid = Number(productId);
    if (!Number.isFinite(pid) || pid < 1) {
      const err = new Error('Укажите productId товара или комплектующей');
      err.statusCode = 400;
      throw err;
    }

    const rows = await this._collectOrderRowsForReserve(marketplace, orderId, { profileId });
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

    const row = await this._findOrderRowForReserveProduct(rows, pid);
    const orderDbId = orderRowDbId(row);
    if (!orderDbId) {
      const err = new Error('Нет id строки заказа в БД');
      err.statusCode = 400;
      throw err;
    }

    const scopeRows = rows.filter((r) => orderRowDbId(r) === orderDbId);
    const before = await this._summarizeReserveForRows(scopeRows.length ? scopeRows : [row]);
    const net = await this._getReservedQtyForOrderProduct(orderDbId, pid);
    const act = String(action || 'toggle').toLowerCase();
    let doUnreserve = false;
    if (act === 'unreserve') {
      doUnreserve = true;
    } else if (act === 'reserve') {
      doUnreserve = false;
    } else {
      doUnreserve = net > 0 || before.hasReserve === true;
    }
    const orderIdStr = String(row.orderId ?? row.order_id ?? orderId);
    const preferredWh = await this._resolveOwnWarehouseIdForOrder(row);
    const warehouseId = await stockMovementsService.resolveWarehouseIdForProductStock(pid, preferredWh);
    if (doUnreserve) {
      const release =
        quantity != null
          ? Math.min(Math.max(0, parseInt(quantity, 10) || 0), net)
          : net;
      if (release <= 0) {
        const err = new Error('По этой позиции нет резерва для снятия');
        err.statusCode = 400;
        throw err;
      }
      await stockMovementsService.applyChange(pid, {
        delta: release,
        type: 'unreserve',
        reason: `Снятие резерва по заказу ${orderIdStr} (вручную, позиция)`.trim(),
        meta: {
          order_id: orderDbId,
          orderId: orderIdStr,
          warehouse_id: warehouseId,
          manual_unreserve: true,
          partial_line: true
        }
      });
    } else {
      const qtyWanted =
        quantity != null ? Math.max(1, parseInt(quantity, 10) || 1) : null;
      const already = net;
      const perNeed = await this._resolveShipmentQtyForOrderProduct(row, pid);
      const headroom = Math.max(0, perNeed - already);
      let toAdd;
      if (qtyWanted != null) {
        // quantity — сколько штук добавить в резерв в этой операции (не целевой итог)
        toAdd = Math.min(qtyWanted, headroom);
      } else {
        toAdd = headroom;
      }
      const kitId = await this._resolveProductIdForOrderStock(row);
      const kitProductId =
        kitId != null && (await isKitProductId(kitId)) && pid !== Number(kitId)
          ? Number(kitId)
          : null;
      const snapManual = await getProductSupplySnapshotWithClient(null, pid);
      const available = Math.min(
        await this._getAvailableUnitsForOrderReserveLine(pid, row, {
          warehouseId,
          kitProductId
        }),
        Math.floor(snapManual.available)
      );
      toAdd = Math.min(toAdd, available);
      if (toAdd <= 0) {
        if (qtyWanted != null && qtyWanted > 0) {
          const snap = await getProductSupplySnapshotWithClient(null, pid);
          const err = new Error(
            `Недостаточно остатка для резерва (доступно без поставщиков: ${available}, запрошено: ${qtyWanted}; ` +
              `на складе ${snap.onHand}, в пути ${snap.incoming}, в резерве ${snap.reserved})`
          );
          err.statusCode = 400;
          throw err;
        }
      } else {
        const meta = {
          order_id: orderDbId,
          orderId: orderIdStr,
          warehouse_id: warehouseId,
          partial_line: true
        };
        if (kitProductId != null) {
          meta.kit_product_id = kitProductId;
          const components = await getKitComponents(kitProductId);
          const comp = components.find((c) => Number(c.component_product_id) === pid);
          const perKit = comp ? Math.max(1, parseInt(comp.quantity, 10) || 1) : 1;
          if (toAdd >= perKit) {
            meta.kit_units = Math.floor(toAdd / perKit) || 1;
          }
        }
        await this._applyReserveForOrderComponent(pid, toAdd, orderIdStr, {
          ...meta,
          order_row: row
        });
      }
    }

    const after = await enrichReserveSummaryCoverage(
      await this._summarizeReserveForRows(scopeRows.length ? scopeRows : [row])
    );
    return {
      action: doUnreserve ? 'unreserve' : 'reserve',
      productId: pid,
      ...after,
      message: this._reserveToggleMessage(before, after, doUnreserve)
    };
  }

  /**
   * Поставить / снять резерв по строкам выбранного заказа (не по всему order_group_id).
   * @param {'toggle'|'reserve'|'unreserve'} action
   */
  async setOrderReserve(marketplace, orderId, { profileId = null, action = 'toggle', productId = null, quantity = null } = {}) {
    if (productId != null && String(productId).trim() !== '') {
      return this.setOrderReserveForProduct(marketplace, orderId, {
        profileId,
        productId,
        action,
        quantity
      });
    }
    if (!repositoryFactory.isUsingPostgreSQL()) {
      const err = new Error('Резерв по заказам доступен только при использовании PostgreSQL');
      err.statusCode = 501;
      throw err;
    }

    const rows = await this._collectOrderRowsForReserve(marketplace, orderId, { profileId });
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
      const oidLabel = String(rows[0]?.orderId ?? rows[0]?.order_id ?? orderId);
      const affected = await this._releaseReservesForOrderRows(rows, oidLabel, async (pid, net, orderIdLabel, meta) => {
        await stockMovementsService.applyChange(pid, {
          delta: net,
          type: 'unreserve',
          reason: `Снятие резерва по заказу ${orderIdLabel} (вручную)`.trim(),
          meta: { ...meta, manual_unreserve: true }
        });
      });
      if (!affected.length && before.hasReserve) {
        const err = new Error(
          'Резерв в журнале не найден по id заказа. Обновите страницу или снимите резерв в «История остатков» товара.'
        );
        err.statusCode = 400;
        throw err;
      }
      // Не перераспределяем освободившийся остаток на другие заказы сразу после ручного снятия в карточке.
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

    const after = await enrichReserveSummaryCoverage(await this._summarizeReserveForRows(rows));
    return {
      action: doUnreserve ? 'unreserve' : 'reserve',
      ...after,
      message: this._reserveToggleMessage(before, after, doUnreserve)
    };
  }

  /**
   * Строки заказа из локальной БД для карточки заказа (product_id → ссылка на каталог).
   */
  /** Статус заказа в ERM для карточки (первая строка группы). */
  async getErmStatusForOrder(marketplace, orderId, { profileId = null } = {}) {
    let rows = await this._collectOrderRowsForReserve(marketplace, orderId, { profileId });
    if (!rows.length) {
      rows = await this._findOrderGroupRows(marketplace, orderId, { profileId });
    }
    const st = rows?.[0]?.status ?? rows?.[0]?.order_status;
    if (st != null && String(st).trim() !== '') {
      return String(st).trim().toLowerCase();
    }
    const one = await this.getByMarketplaceAndOrderId(marketplace, orderId, { profileId });
    return one?.status != null ? String(one.status).trim().toLowerCase() : null;
  }

  async getLocalLinesForOrderDetail(marketplace, orderId, { profileId = null } = {}) {
    let rows = await this._collectOrderRowsForReserve(marketplace, orderId, { profileId });
    if (!rows.length) {
      rows = await this._findOrderGroupRows(marketplace, orderId, { profileId });
    }
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


