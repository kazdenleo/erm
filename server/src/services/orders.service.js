/**
 * Orders Service
 * Бизнес-логика для работы с заказами
 */

import fetch from 'node-fetch';
import { query } from '../config/database.js';
import repositoryFactory from '../config/repository-factory.js';
import stockMovementsService, { runWithProductStockLock } from './stockMovements.service.js';
import {
  isKitProductId,
  applyKitOrderReserve,
  computeMaxKitUnitsReservable,
  computeKitReservableBreakdown,
  allocateKitReservePriority,
  reconcileMisplacedKitWholeReserve,
  reconcileMixedKitOrderReservePaths,
  getReservedKitUnitsForOrder,
  getReservedKitUnitsForOrderValidation,
  releaseAllReservesForOrder,
  findKitProductIdForMarketplaceOrder,
  collectOrderSkuCandidates,
  isKitComponentProductId,
  getKitComponents,
  batchPiecesPerKitUnitMap,
  batchKitIdByComponentMap,
  getNetReservedForOrderProduct,
  sumKitComponentQtyPerKit,
  buildKitComponentQtyMap,
  getComponentAssemblableUnits,
  computeAssemblableFromComponents,
  getReservedKitUnitsFromComponentsForOrder,
  resolveComplementaryKitReserveUnits,
  readKitPhysicalOnHandFromDb,
  resolveKitOrderShipmentPlan,
  kitOrderReserveExceedsOnHand,
  findKitProductIdForOrderComponentReserve,
  releaseKitOrderReserveUnits
} from './kitStock.service.js';
import {
  NET_RESERVED_SUM_EXPR_SQL,
  RAW_RESERVED_SUM_EXPR_SQL,
  computeAvailableQuantity,
  getProductSupplySnapshotWithClient,
  getReservableSupplyUnits
} from './sellableQuantity.service.js';
import { resolveProfileProcurementStatusEnabled } from '../utils/profileProcurementStatus.js';
import logger from '../utils/logger.js';
import {
  orderReserveMovementMatchOrderRowSql,
  orderReserveMovementMatchSql
} from '../constants/netReservedStockSql.js';
import { isOrderOnAssemblyStatus } from '../constants/orderStatuses.js';
import { buildAssemblyCompositionLinesForOrder } from './assemblyOrderItems.service.js';

function reserveSnapshotOptsFromMeta(meta = {}) {
  const wh = meta?.warehouse_id ?? meta?.warehouseId ?? null;
  if (wh != null && String(wh).trim() !== '') {
    return { warehouseId: wh };
  }
  return {};
}
import integrationsService from './integrations.service.js';
import { getYandexBusinessAndCampaigns, normalizeYandexApiKey } from './orders.sync.service.js';
import { getYandexHttpsAgent } from '../utils/yandex-https-agent.js';
import { ozonPostingNumberFromOrderId } from '../utils/ozonPosting.js';
import {
  getManualOrderGroupKey,
  isManualOrderEditableStatus
} from '../utils/manualOrderGroup.js';

/** Заказ FBS с маркетплейса (не ручной) — резерв только со склада из warehouse_mappings. */
export function isMarketplaceFbsOrderRow(orderRow) {
  const mp = String(orderRow?.marketplace || '').toLowerCase();
  return (
    mp === 'wb' ||
    mp === 'wildberries' ||
    mp === 'ozon' ||
    mp === 'ym' ||
    mp === 'yandex' ||
    mp === 'yandexmarket'
  );
}

/** Ручной заказ — резерв только со склада profiles.manual_orders_warehouse_id. */
export function isManualOrderRow(orderRow) {
  return String(orderRow?.marketplace || '').toLowerCase() === 'manual';
}

/** FBS и ручные заказы — резерв строго с привязанного склада, без fallback на другие склады. */
export function isStrictWarehouseOrderRow(orderRow) {
  return isMarketplaceFbsOrderRow(orderRow) || isManualOrderRow(orderRow);
}

/**
 * Покрытие резерва по заказу: со склада или с «в пути».
 * Резерв в системе возможен только при доступном остатке/ожидании — «без покрытия» не показываем.
 * @returns {'none'|'on_hand'|'incoming'}
 */
export function classifyOrderReserveCoverage({
  onHand = 0,
  incoming = 0,
  reservedRaw = 0,
  orderReserved = 0
} = {}) {
  const R = Math.max(0, Math.floor(Number(orderReserved) || 0));
  if (R <= 0) return 'none';
  const H = Math.max(0, Math.floor(Number(onHand) || 0));
  const I = Math.max(0, Math.floor(Number(incoming) || 0));
  const raw = Math.max(0, Math.floor(Number(reservedRaw) || 0));
  const reservedOthers = Math.max(0, raw - R);
  const onHandFree = Math.max(0, H - Math.min(reservedOthers, H));
  const fromOnHand = Math.min(R, onHandFree);
  const remaining = R - fromOnHand;
  if (remaining <= 0) return 'on_hand';
  const reservedBeyondOnHand = Math.max(0, reservedOthers - H);
  const incomingFree = Math.max(0, I - reservedBeyondOnHand);
  const fromIncoming = Math.min(remaining, incomingFree);
  if (fromIncoming >= remaining) return 'incoming';
  return fromOnHand > 0 ? 'on_hand' : 'incoming';
}

/** Сколько ещё можно покрыть резервом с фактического остатка (FIFO: сначала занят on_hand). */
export function onHandHeadroomBeforeReserve({ onHand = 0, reservedRaw = 0 } = {}) {
  const H = Math.max(0, Math.floor(Number(onHand) || 0));
  const R0 = Math.max(0, Math.floor(Number(reservedRaw) || 0));
  return Math.max(0, H - Math.min(R0, H));
}

/** Резерв с «в пути» (incoming) — только для заказов в закупке или на сборке. */
export function orderStatusAllowsIncomingReserve(status) {
  const st = String(status ?? '').trim().toLowerCase();
  return st === 'in_procurement' || st === 'in_assembly' || st === 'wb_assembly';
}

/**
 * Покрытие резерва по заказам одного товара: учитывает свободное наличие после резервов других заказов.
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
                AND (sm.meta ? 'order_id' OR sm.meta ? 'orderId')
                AND ${orderReserveMovementMatchOrderRowSql('sm.', 'o.')}
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
    for (const { oid, reserved } of list) {
      const kind = sup
        ? classifyOrderReserveCoverage({ ...sup, orderReserved: reserved })
        : 'incoming';
      map.set(`${oid}:${pid}`, kind);
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
    `SELECT o.id AS order_db_id,
            sm.product_id,
            ${NET_RESERVED_SUM_EXPR_SQL}::int AS reserved_qty
     FROM orders o
     JOIN stock_movements sm ON sm.type IN ('reserve', 'unreserve')
       AND (sm.meta ? 'order_id' OR sm.meta ? 'orderId')
       AND ${orderReserveMovementMatchOrderRowSql('sm.', 'o.')}
     WHERE o.id = ANY($1::bigint[])
     GROUP BY o.id, sm.product_id
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
      CASE
        WHEN EXISTS (
          SELECT 1 FROM stock_movements smj
          WHERE smj.product_id = p.id AND LOWER(TRIM(smj.type::text)) = 'incoming'
        ) THEN GREATEST(
          GREATEST(0, COALESCE((
            SELECT SUM(quantity_change)::int
            FROM stock_movements smj
            WHERE smj.product_id = p.id AND LOWER(TRIM(smj.type::text)) = 'incoming'
          ), 0)),
          COALESCE((
            SELECT incoming_after::int
            FROM stock_movements sm
            WHERE sm.product_id = p.id AND sm.incoming_after IS NOT NULL
            ORDER BY sm.created_at DESC, sm.id DESC
            LIMIT 1
          ), 0)
        )
        ELSE COALESCE(p.incoming_quantity, 0)::int
      END AS incoming,
      CASE
        WHEN EXISTS (SELECT 1 FROM product_warehouse_stock pws WHERE pws.product_id = p.id)
        THEN COALESCE((
          SELECT SUM(COALESCE(pws.quantity, 0))::int
          FROM product_warehouse_stock pws
          WHERE pws.product_id = p.id
        ), 0)
        ELSE COALESCE(p.quantity, 0)
      END::int AS on_hand,
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

async function enrichReserveSummaryCoverage(summary, { light = false } = {}) {
  if (!summary || typeof summary !== 'object') return summary;
  const lines = Array.isArray(summary.lines) ? summary.lines : [];
  const pids = lines.map((l) => Number(l.productId)).filter((id) => id > 0);
  const supplyMap = await batchProductReserveSupplyMap(pids);
  const coverageFifoMap = light ? null : await buildReserveCoverageFifoMap(pids);
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

/** Статусы, при которых товар уже должен быть списан со склада (сборка / отгрузка / логистика МП). */
export const ORDER_SHIPMENT_DEDUCT_STATUSES = new Set([
  'assembled',
  'shipped',
  'in_transit',
  'delivered'
]);

export function isOrderShipmentDeductStatus(status) {
  return ORDER_SHIPMENT_DEDUCT_STATUSES.has(String(status || '').trim().toLowerCase());
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
  if (
    sNorm === 'new' ||
    sNorm === 'in_assembly' ||
    sNorm === 'wb_assembly' ||
    sNorm === 'unknown'
  ) {
    return true;
  }
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
               o.product_name,
               o.delivery_address,
               pm.matched_product_id
        FROM refs r
        JOIN orders o
          ON o.marketplace = r.marketplace
         AND o.order_id = r.order_id
        LEFT JOIN LATERAL (
          SELECT p2.id AS matched_product_id
          FROM product_skus ps
          JOIN products p2 ON p2.id = ps.product_id
          WHERE ps.marketplace = o.marketplace
            AND (
              (o.offer_id IS NOT NULL AND TRIM(ps.sku) = TRIM(o.offer_id))
              OR (o.marketplace_sku IS NOT NULL AND TRIM(ps.sku) = TRIM(CAST(o.marketplace_sku AS TEXT)))
              OR (o.marketplace = 'ozon' AND o.marketplace_sku IS NOT NULL AND ps.marketplace_product_id IS NOT NULL
                  AND ps.marketplace_product_id = o.marketplace_sku::bigint)
              OR (o.marketplace = 'wb' AND o.offer_id IS NOT NULL
                  AND TRIM(ps.sku) = TRIM(REGEXP_REPLACE(o.offer_id::text, '^.*?([0-9]+)$', '\\1')))
              OR (o.marketplace = 'wb' AND o.product_name IS NOT NULL
                  AND TRIM(ps.sku) = TRIM(REGEXP_REPLACE(o.product_name::text, '^.*?([0-9]+)$', '\\1')))
            )
          LIMIT 1
        ) pm ON true
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
        o.matched_product_id,
        o.offer_id,
        o.marketplace_sku,
        o.product_name,
        o.delivery_address,
        p.id AS joined_product_id,
        p.product_type,
        COALESCE(p.quantity, 0)::int AS product_qty,
        COALESCE(p.reserved_quantity, 0)::int AS product_reserved_qty
      FROM ord o
      LEFT JOIN res r ON r.oid = o.id::bigint
      LEFT JOIN products p ON p.id = COALESCE(o.product_id, o.matched_product_id)
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
      let prodId =
        row.product_id != null
          ? Number(row.product_id)
          : row.matched_product_id != null
            ? Number(row.matched_product_id)
            : null;
      let prodQty = Number(row.product_qty) || 0;
      let prodRes = Number(row.product_reserved_qty) || 0;

      // Если product_id в orders ещё не заполнен, пытаемся сопоставить через product_skus (как в UI).
      if (!prodId || !Number.isFinite(prodId) || prodId < 1) {
        try {
          const kitBySku = await findKitProductIdForMarketplaceOrder(0, {
            marketplace: row.marketplace,
            offerId: row.offer_id,
            offer_id: row.offer_id,
            sku: row.marketplace_sku,
            marketplace_sku: row.marketplace_sku,
            productName: row.product_name,
            product_name: row.product_name
          });
          if (kitBySku != null && (await isKitProductId(kitBySku))) {
            prodId = kitBySku;
          }
        } catch {
          /* ignore */
        }
        if ((!prodId || !Number.isFinite(prodId) || prodId < 1) && fastBatch) {
          blocked.push({ marketplace: o.marketplace, orderId: oid, reason: 'не определён товар (product_id)' });
          continue;
        }
        const orderRowForResolve = {
          marketplace: row.marketplace,
          offerId: row.offer_id,
          offer_id: row.offer_id,
          sku: row.marketplace_sku,
          marketplace_sku: row.marketplace_sku,
          productName: row.product_name,
          product_name: row.product_name,
          productId: row.product_id
        };
        const loadProductStockCache = async (pid) => {
          if (productCache.has(pid)) {
            const c = productCache.get(pid);
            prodQty = c.qty;
            prodRes = c.reserved;
            return;
          }
          const pr = await query(
            `SELECT COALESCE(quantity, 0)::int AS quantity,
                    COALESCE(reserved_quantity, 0)::int AS reserved_quantity
             FROM products
             WHERE id = $1
             LIMIT 1`,
            [pid]
          );
          const prow = pr.rows?.[0] || {};
          prodQty = Number(prow.quantity) || 0;
          prodRes = Number(prow.reserved_quantity) || 0;
          productCache.set(pid, { qty: prodQty, reserved: prodRes });
        };
        if (!prodId || !Number.isFinite(prodId) || prodId < 1) {
          try {
            const fromLine = await this.resolveProductIdForAssemblyLine(orderRowForResolve);
            const lid = fromLine != null ? Number(fromLine) : null;
            if (lid && Number.isFinite(lid) && lid > 0) {
              prodId = lid;
              await loadProductStockCache(prodId);
            }
          } catch {
            /* ignore */
          }
        }
        if (!prodId || !Number.isFinite(prodId) || prodId < 1) {
          try {
            const resolved = await this._resolveProductIdForOrderStock(orderRowForResolve);
            const rid = resolved != null ? Number(resolved) : null;
            if (rid && Number.isFinite(rid) && rid > 0) {
              prodId = rid;
              await loadProductStockCache(prodId);
            }
          } catch {
            /* ignore */
          }
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
          ? await getReservedKitUnitsForOrderValidation(prodId, orderDbId)
          : resQty;
      if (reservedForLine < need) {
        blocked.push({
          marketplace: o.marketplace,
          orderId: oid,
          reason: `нет резерва под заказ (зарезервировано: ${reservedForLine}, нужно: ${need})`
        });
        continue;
      }
      if (isKit && orderDbId) {
        const orderRowForWh = {
          marketplace: row.marketplace,
          delivery_address: row.delivery_address ?? null
        };
        const warehouseId = await this._resolveWarehouseIdForOrderReserve(orderRowForWh, prodId);
        const exceedsOnHand = await kitOrderReserveExceedsOnHand(
          prodId,
          orderDbId,
          warehouseId,
          oid
        );
        if (exceedsOnHand) {
          blocked.push({
            marketplace: o.marketplace,
            orderId: oid,
            reason: 'резерв комплекта не покрыт наличием на складе'
          });
          continue;
        }
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
    const isKit = await isKitProductId(pid);

    for (const orow of ordRes.rows || []) {
      if (excess <= 0) break;
      const orderDbId = Number(orow.order_row_id);
      const netForOrder = Number(orow.net_r) || 0;
      if (netForOrder <= 0 || !Number.isFinite(orderDbId)) continue;
      const orderIdStr = String(orow.order_id ?? '');
      const trimMeta = {
        order_id: orderDbId,
        orderId: orderIdStr,
        trim_excess: true,
        marketplace: orow.marketplace ?? null,
        ...meta
      };
      const unreserveFn = (prodId, qty, _oidLabel, extraMeta = {}) =>
        stockMovementsService.applyChange(prodId, {
          delta: qty,
          type: 'unreserve',
          reason: baseReason,
          meta: { ...trimMeta, ...extraMeta }
        });

      if (isKit) {
        const units = Math.min(netForOrder, excess);
        if (units <= 0) continue;
        const kitReleased = await releaseKitOrderReserveUnits(
          pid,
          orderDbId,
          units,
          unreserveFn,
          trimMeta
        );
        if (kitReleased <= 0) continue;
        released += kitReleased;
        excess -= kitReleased;
        ordersTouched++;
        continue;
      }

      const kitId = await findKitProductIdForOrderComponentReserve(pid, orderDbId);
      if (kitId != null) {
        const components = await getKitComponents(kitId);
        const comp = components.find((c) => Number(c.component_product_id) === pid);
        const perKit = comp ? Math.max(1, parseInt(comp.quantity, 10) || 1) : 1;
        const unreserveQty = Math.min(netForOrder, excess);
        const kitUnits = Math.min(Math.floor(unreserveQty / perKit), Math.floor(netForOrder / perKit));
        if (kitUnits <= 0) continue;
        const kitReleased = await releaseKitOrderReserveUnits(
          kitId,
          orderDbId,
          kitUnits,
          unreserveFn,
          trimMeta
        );
        if (kitReleased <= 0) continue;
        released += kitReleased * perKit;
        excess -= kitReleased * perKit;
        ordersTouched++;
        continue;
      }

      const unreserveQty = Math.min(netForOrder, excess);
      await unreserveFn(pid, unreserveQty, orderIdStr, {});
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
    const st = String(order.status || '').toLowerCase();
    const procurementEnabled = await resolveProfileProcurementStatusEnabled(
      profileId ?? order.profile_id ?? order.profileId ?? null
    );
    if (procurementEnabled) {
      if (st !== 'in_procurement') return;
    } else if (!['new', 'in_procurement'].includes(st)) {
      return;
    }
    await this._reapplyReserveForOrderRows([order]);
  }

  async _resolveOwnWarehouseIdForOrder(orderRow) {
    if (!repositoryFactory.isUsingPostgreSQL() || !orderRow) return null;
    const mpRaw = String(orderRow.marketplace || '').toLowerCase();
    const mp = mpRaw === 'wildberries' ? 'wb' : mpRaw === 'yandex' ? 'ym' : mpRaw;
    const isMpOrder = isMarketplaceFbsOrderRow(orderRow);
    const mpWarehouseId = String(orderRow.deliveryAddress ?? orderRow.delivery_address ?? '').trim();
    if (mp && mpWarehouseId) {
      try {
        const repo = repositoryFactory.getRepository('warehouse_mappings');
        let wid = await repo?.findOwnWarehouseIdByMarketplaceWarehouseId?.(mp, mpWarehouseId);
        if (wid) return wid;

        const numMatch = mpWarehouseId.match(/^(\d+)/);
        if (numMatch) {
          wid = await repo?.findOwnWarehouseIdByMarketplaceWarehouseId?.(mp, numMatch[1]);
          if (wid) return wid;
        }

        const namePart = mpWarehouseId.includes('—')
          ? mpWarehouseId
              .split('—')
              .slice(1)
              .join('—')
              .trim()
          : mpWarehouseId;
        if (namePart && repo?.findByMarketplace) {
          const mappings = await repo.findByMarketplace(mp);
          for (const m of mappings || []) {
            const mid = String(m.marketplace_warehouse_id || '').trim();
            if (!mid) continue;
            const midName = mid.includes('—') ? mid.split('—').slice(1).join('—').trim() : mid;
            if (
              mid.includes(namePart) ||
              namePart.includes(midName) ||
              midName.includes(namePart)
            ) {
              return m.warehouse_id;
            }
          }
        }
      } catch {
        // ignore
      }
    }
    if (isMpOrder && mp) {
      try {
        const repo = repositoryFactory.getRepository('warehouse_mappings');
        const primary = await repo?.findPrimaryOwnWarehouseIdForMarketplace?.(mp);
        if (primary) return primary;
      } catch {
        // ignore
      }
    }
    if (isManualOrderRow(orderRow)) {
      const orderWh = orderRow.warehouse_id ?? orderRow.warehouseId ?? null;
      const orderWhNum = orderWh != null ? Number(orderWh) : NaN;
      if (Number.isFinite(orderWhNum) && orderWhNum > 0) return orderWhNum;
      try {
        const profileId = orderRow.profile_id ?? orderRow.profileId ?? null;
        if (profileId != null) {
          const profRepo = repositoryFactory.getProfilesRepository();
          const prof = await profRepo?.findById?.(profileId);
          const wid = prof?.manual_orders_warehouse_id ?? prof?.manualOrdersWarehouseId ?? null;
          if (wid) return wid;
        }
        const whRepo = repositoryFactory.getWarehousesRepository();
        const legacyWid = await whRepo?.findManualOrdersWarehouseId?.(profileId);
        if (legacyWid) return legacyWid;
      } catch {
        // ignore
      }
    }
    return await stockMovementsService.productsRepository.resolveOwnWarehouseId(null);
  }

  /**
   * Склад для резерва/отгрузки заказа.
   * FBS с маркетплейса — только привязка из warehouse_mappings (без поиска «где есть остаток»).
   * Ручной заказ — только склад из profiles.manual_orders_warehouse_id (без поиска «где есть остаток»).
   */
  async _resolveWarehouseIdForOrderReserve(orderRow, productId = null) {
    const mappedWh = await this._resolveOwnWarehouseIdForOrder(orderRow);
    if (isMarketplaceFbsOrderRow(orderRow) || isManualOrderRow(orderRow)) {
      return mappedWh;
    }
    if (productId != null) {
      return stockMovementsService.resolveWarehouseIdForProductStock(productId, mappedWh);
    }
    return mappedWh;
  }

  /** FBS / ручной заказ без привязки склада — резерв недоступен. */
  _fbsReserveWarehouseBlocked(orderRow, warehouseId) {
    if (!isStrictWarehouseOrderRow(orderRow)) return false;
    return warehouseId == null || String(warehouseId).trim() === '';
  }

  _assertFbsReserveWarehouse(orderRow, warehouseId) {
    if (!this._fbsReserveWarehouseBlocked(orderRow, warehouseId)) return;
    const err = new Error(
      isManualOrderRow(orderRow)
        ? 'Не выбран склад списания для ручного заказа'
        : 'Не определён склад FBS для заказа — настройте привязку warehouse_mappings'
    );
    err.statusCode = 400;
    throw err;
  }

  async _reconcileKitReserveBeforeApply(orderRow, kitProductId, orderDbId, metaBase = {}) {
    const pid = Number(kitProductId);
    const id = Number(orderDbId);
    if (!Number.isFinite(pid) || pid < 1 || !Number.isFinite(id) || id < 1) return;
    if (!(await isKitProductId(pid))) return;

    const orderIdStr = String(orderRow?.orderId ?? orderRow?.order_id ?? id).trim();
    const stockHooks = {
      unreserveProduct: (unreservePid, net, oid, m) =>
        stockMovementsService.applyChange(unreservePid, {
          delta: net,
          type: 'unreserve',
          reason: `Перенос резерва комплекта на комплектующие (заказ ${oid})`.trim(),
          meta: m
        }),
      applyKitReserve: (kitId, kits, oid, m) =>
        applyKitOrderReserve(kitId, kits, oid, m, (compId, compQty, o, mm) =>
          this._applyReserveForOrderComponent(compId, compQty, o, mm)
        )
    };

    try {
      await reconcileMisplacedKitWholeReserve(
        pid,
        id,
        orderIdStr || String(id),
        metaBase,
        stockHooks
      );
    } catch (e) {
      if (e?.statusCode !== 400) throw e;
    }
    try {
      await reconcileMixedKitOrderReservePaths(
        pid,
        id,
        orderIdStr || String(id),
        metaBase,
        (unreservePid, net, oid, m) =>
          stockMovementsService.applyChange(unreservePid, {
            delta: net,
            type: 'unreserve',
            reason: `Снятие дублирующего резерва комплекта (заказ ${oid})`.trim(),
            meta: m
          })
      );
    } catch (e) {
      if (e?.statusCode !== 400) throw e;
    }
  }

  async _availableUnitsForOrderReserve(productId, orderRow, warehouseId) {
    const pid = Number(productId);
    if (!Number.isFinite(pid) || pid < 1) return 0;
    const wh =
      warehouseId != null && String(warehouseId).trim() !== '' ? warehouseId : null;
    const snap = await getProductSupplySnapshotWithClient(null, pid, { warehouseId: wh });
    if (!orderStatusAllowsIncomingReserve(orderRow?.status)) {
      return Math.max(0, Math.floor(onHandHeadroomBeforeReserve(snap)));
    }
    return Math.max(0, Math.floor(snap.available));
  }

  /**
   * Попытка резерва при появлении/синхронизации заказа или остатка.
   * Раньше: при любом уже существующем резерве или при maxKits < qty для комплекта выходили без дозаполнения.
   */
  async _reserveForOrderIfStockAvailable(orderRow) {
    if (!repositoryFactory.isUsingPostgreSQL() || !orderRow) return;
    await this._applyReserveForOrderIfAbsent(orderRow);
  }

  /** Статусы, из которых авто-«На сборку» после полного резерва (настройка аккаунта). */
  _orderStatusesEligibleForAutoAssembly(status) {
    const st = String(status ?? '').trim().toLowerCase();
    return st === 'new' || st === 'in_procurement';
  }

  /**
   * Если включено profiles.auto_send_to_assembly_on_reserve — отправить заказ на сборку
   * после полного резерва под количество заказа (фоном, как кнопка «На сборку»).
   */
  _scheduleAutoSendToAssemblyAfterReserve(orderRow) {
    if (!repositoryFactory.isUsingPostgreSQL() || !orderRow) return;
    setImmediate(() => {
      void this._runAutoSendToAssemblyAfterReserve(orderRow).catch((e) => {
        logger.warn('[autoAssembly] failed', {
          orderId: orderRow.orderId ?? orderRow.order_id,
          message: e?.message || String(e)
        });
      });
    });
  }

  async _runAutoSendToAssemblyAfterReserve(orderRow) {
    if (!repositoryFactory.isUsingPostgreSQL() || !orderRow) return;
    const orderIdStr = String(orderRow.orderId ?? orderRow.order_id ?? '').trim();
    const mp = orderRow.marketplace;
    if (!orderIdStr || mp == null || String(mp).trim() === '') return;

    const profileId = normalizeProfileIdForOrders(orderRow.profile_id ?? orderRow.profileId);
    if (profileId == null) return;

    const profRepo = repositoryFactory.getProfilesRepository();
    const prof = profRepo ? await profRepo.findById(profileId) : null;
    if (prof?.auto_send_to_assembly_on_reserve !== true) return;

    if (!this._orderStatusesEligibleForAutoAssembly(orderRow.status)) return;

    const assemblyRef = { marketplace: mp, orderId: orderIdStr };
    const check = await this.validateReservedStockForAssembly([assemblyRef], { profileId });
    if (!Array.isArray(check?.ok) || check.ok.length === 0) return;

    const result = await this.sendToAssembly([assemblyRef], profileId, { deferReserve: true });
    if ((result?.updated ?? 0) <= 0) return;

    const { processAssemblyShipmentsInBackground } = await import('./orderAssemblyBackground.service.js');
    await processAssemblyShipmentsInBackground([assemblyRef], { profileId, organizationId: null });

    logger.info('[autoAssembly] order sent to assembly after reserve', {
      marketplace: mp,
      orderId: orderIdStr,
      profileId
    });
  }

  /**
   * Установить резерв по заказу: уменьшить доступный остаток и записать движение в историю.
   * Для комплекта: целые — резерв на SKU комплекта; из деталей — на комплектующие.
   */
  async _applyReserveForOrder(productId, quantity, orderId, meta = {}) {
    if (!productId || quantity < 1) return;
    const qtyWanted = Math.max(1, parseInt(quantity, 10) || 1);

    if (await isKitProductId(productId)) {
      return applyKitOrderReserve(
        productId,
        qtyWanted,
        orderId,
        meta,
        (compId, compQty, oid, m) =>
          this._applyReserveForOrderComponent(compId, compQty, oid, m)
      );
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
      const supplyOpts = reserveSnapshotOptsFromMeta(meta);
      if (reserveAsKitComponentEarly && Number(meta?.kit_product_id) > 0) {
        const orderRow =
          meta?.order_row && typeof meta.order_row === 'object' ? meta.order_row : null;
        const gateAvail = await this._getAvailableUnitsForOrderReserveLine(productId, orderRow, {
          warehouseId: supplyOpts.warehouseId ?? null,
          kitProductId: Number(meta.kit_product_id)
        });
        if (Math.floor(gateAvail) <= 0) return;
      } else {
        const orderRow =
          meta?.order_row && typeof meta.order_row === 'object' ? meta.order_row : null;
        const gateAvail = await this._availableUnitsForOrderReserve(
          productId,
          orderRow,
          supplyOpts.warehouseId ?? null
        );
        if (Math.floor(gateAvail) <= 0) return;
      }
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

    const snapBeforeReserve = await getProductSupplySnapshotWithClient(
      null,
      productId,
      reserveSnapshotOptsFromMeta(meta)
    );
    const orderRowForIncoming =
      meta?.order_row && typeof meta.order_row === 'object' ? meta.order_row : null;
    const allowIncoming = orderStatusAllowsIncomingReserve(
      orderRowForIncoming?.status ?? meta?.order_status
    );
    let reserveFromOnHand;
    let reserveFromIncoming;
    if (hasKitPrealloc) {
      const breakdown = await computeKitReservableBreakdown(productId, {
        warehouseId: meta?.warehouse_id ?? meta?.warehouseId ?? null
      });
      const wholePool = Math.max(
        0,
        breakdown.wholeReserveAvail != null
          ? Number(breakdown.wholeReserveAvail) || 0
          : Number(breakdown.physicalOnHand) || 0
      );
      qty = Math.min(qty, wholePool);
      if (qty <= 0) return;
      reserveFromOnHand = qty;
      reserveFromIncoming = 0;
    } else {
      const cap = allowIncoming
        ? Math.floor(snapBeforeReserve.available)
        : onHandHeadroomBeforeReserve(snapBeforeReserve);
      qty = Math.min(qty, cap);
      if (qty <= 0) return;
      reserveFromOnHand = Math.min(qty, onHandHeadroomBeforeReserve(snapBeforeReserve));
      reserveFromIncoming = allowIncoming ? Math.max(0, qty - reserveFromOnHand) : 0;
      if (!allowIncoming) {
        qty = reserveFromOnHand;
        if (qty <= 0) return;
      }
    }

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

  /** Снять N комплектов с резерва комплектующих под заказ. */
  async _releaseKitUnitsFromComponentReserves(orderDbId, orderIdStr, kitProductId, kitUnits) {
    const kitId = Number(kitProductId);
    const units = Math.max(0, parseInt(kitUnits, 10) || 0);
    if (!Number.isFinite(kitId) || kitId < 1 || units <= 0) return false;

    const components = await getKitComponents(kitId);
    if (!components?.length) return false;

    const { releaseOrderReservesGroupedByWarehouse } = await import('./kitStock.service.js');
    let releasedAny = false;
    for (const c of components) {
      const compId = Number(c.component_product_id);
      if (!Number.isFinite(compId) || compId < 1) continue;
      const perKit = Math.max(1, parseInt(c.quantity, 10) || 1);
      const piecesToRelease = units * perKit;
      const affected = await releaseOrderReservesGroupedByWarehouse(
        orderDbId,
        orderIdStr,
        async (productId, net, orderIdLabel, meta) => {
          const rel = Math.min(net, piecesToRelease);
          if (rel <= 0) return;
          await stockMovementsService.applyChange(productId, {
            delta: rel,
            type: 'unreserve',
            reason: `Снятие резерва комплектующих (заказ ${orderIdLabel}, ${units} компл.)`.trim(),
            meta: {
              ...meta,
              manual_unreserve: true,
              skip_auto_reserve: true,
              kit_manual_unreserve: true,
              kit_product_id: kitId,
              kit_units: units
            }
          });
        },
        { productId: compId }
      );
      if (affected.length) releasedAny = true;
    }
    return releasedAny;
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

  async _resolveWarehouseIdForOrderProductAssembly(orderRow, productId) {
    const orderDbId = orderRowDbId(orderRow);
    const pid = Number(productId);
    if (orderDbId && Number.isFinite(pid) && pid >= 1) {
      const whRows = await query(
        `SELECT warehouse_id,
                GREATEST(0, COALESCE(SUM(CASE WHEN type = 'reserve' THEN -quantity_change
                  WHEN type = 'unreserve' THEN quantity_change ELSE 0 END), 0))::int AS net
         FROM stock_movements
         WHERE product_id = $2
           AND type IN ('reserve', 'unreserve')
           AND warehouse_id IS NOT NULL
           AND (meta->>'order_id')::bigint = $1
         GROUP BY warehouse_id
         HAVING COALESCE(SUM(CASE WHEN type = 'reserve' THEN -quantity_change
           WHEN type = 'unreserve' THEN quantity_change ELSE 0 END), 0) > 0
         ORDER BY net DESC, warehouse_id ASC`,
        [orderDbId, pid]
      );
      if (whRows.rows?.[0]?.warehouse_id != null) {
        return Number(whRows.rows[0].warehouse_id);
      }
      const shipRow = await query(
        `SELECT warehouse_id FROM stock_movements
         WHERE product_id = $2 AND type = 'shipment' AND warehouse_id IS NOT NULL
           AND (meta->>'order_id')::bigint = $1
         ORDER BY id DESC LIMIT 1`,
        [orderDbId, pid]
      );
      if (shipRow.rows?.[0]?.warehouse_id != null) {
        return Number(shipRow.rows[0].warehouse_id);
      }
    }
    return this._resolveWarehouseIdForOrderReserve(orderRow, productId);
  }

  async _assemblyMetaForOrderProduct(orderRow, productId) {
    const orderDbId = orderRowDbId(orderRow);
    const orderIdStr = String(orderRow.orderId ?? orderRow.order_id ?? '').trim();
    const warehouseId = await this._resolveWarehouseIdForOrderProductAssembly(orderRow, productId);
    return {
      order_id: orderDbId,
      orderId: orderIdStr,
      assembled: true,
      warehouse_id: warehouseId || null
    };
  }

  /** @deprecated используйте _assemblyMetaForOrderProduct(orderRow, productId) */
  async _assemblyMetaForOrderRow(orderRow) {
    const productId = await this._resolveProductIdForOrderStock(orderRow);
    return this._assemblyMetaForOrderProduct(orderRow, productId);
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
  async _applyAssemblyStockForOrderProduct(orderRow, productId, targetQty = null, opts = {}) {
    if (!repositoryFactory.isUsingPostgreSQL() || !orderRow || !productId) return;
    const orderDbId = orderRowDbId(orderRow);
    if (!orderDbId) return;

    const pid = Number(productId);
    if (!Number.isFinite(pid) || pid < 1) return;

    const metaBase = await this._assemblyMetaForOrderProduct(orderRow, pid);
    const orderIdStr = metaBase.orderId || '';
    const lineQty =
      targetQty != null
        ? Math.max(0, parseInt(targetQty, 10) || 0)
        : await this._resolveShipmentQtyForOrderProduct(orderRow, pid);
    if (lineQty <= 0) return;

    const alreadyShipped = await this._getShippedQtyForOrderProduct(orderDbId, pid);
    const shipQty = Math.max(0, lineQty - alreadyShipped);
    if (shipQty <= 0) return;

    let requireReserve = opts.requireReserve;
    if (requireReserve === undefined) {
      const net = await this._getReservedQtyForOrderProduct(orderDbId, pid);
      requireReserve = net > 0;
    }

    await stockMovementsService.applyOrderAssemblyShipment(pid, {
      shipQty,
      unreserveReason: `Отгрузка: снятие резерва по заказу ${orderIdStr}`.trim(),
      shipmentReason: `Отгрузка: списание наличия по заказу ${orderIdStr}`.trim(),
      meta: metaBase,
      requireReserve: requireReserve !== false
    });
  }

  async _withKitAssemblyStockLocks(kitProductId, fn) {
    // Сериализация — в applyOrderAssemblyShipment (xact_lock в одной транзакции).
    // Внешний runWithProductStockLock давал deadlock: два соединения, один product_id.
    return fn();
  }

  /**
   * Комплект: снять резерв с SKU комплекта (если был), списать целые комплекты со склада
   * и списать комплектующие по составу.
   */
  async _applyAssemblyStockForKitOrder(orderRow, kitProductId) {
    const kitId = Number(kitProductId);
    if (!Number.isFinite(kitId) || kitId < 1) return;

    return this._withKitAssemblyStockLocks(kitId, () =>
      this._applyAssemblyStockForKitOrderLocked(orderRow, kitId)
    );
  }

  async _applyAssemblyStockForKitOrderLocked(orderRow, kitProductId) {
    const kitId = Number(kitProductId);
    if (!Number.isFinite(kitId) || kitId < 1) return;

    const orderDbId = orderRowDbId(orderRow);
    if (!orderDbId) return;

    const kitQty = Math.max(1, parseInt(orderRow.quantity, 10) || 1);
    const metaBase = await this._assemblyMetaForOrderProduct(orderRow, kitId);
    const warehouseId = metaBase.warehouse_id ?? null;
    const orderIdStr = metaBase.orderId || '';

    const { wholeUnitsToShip, componentKitUnitsToShip } = await resolveKitOrderShipmentPlan(
      kitId,
      orderDbId,
      {
        kitOrderQty: kitQty,
        marketplaceOrderId: orderIdStr || null,
        warehouseId,
        getShippedQtyForProduct: (odbId, pid) => this._getShippedQtyForOrderProduct(odbId, pid)
      }
    );

    const components = await getKitComponents(kitId);
    const wholeShipped = Math.max(
      0,
      Number(await this._getShippedQtyForOrderProduct(orderDbId, kitId)) || 0
    );
    let kitsShippedViaComp = 0;
    if (components.length > 0) {
      const qtyPerKitByComp = new Map();
      for (const c of components) {
        const pid = Number(c.component_product_id);
        if (!Number.isFinite(pid) || pid < 1) continue;
        const perKit = Math.max(1, parseInt(c.quantity, 10) || 1);
        qtyPerKitByComp.set(pid, (qtyPerKitByComp.get(pid) || 0) + perKit);
      }
      let minKits = Infinity;
      for (const [pid, perKit] of qtyPerKitByComp) {
        const shipped = Number(await this._getShippedQtyForOrderProduct(orderDbId, pid)) || 0;
        minKits = Math.min(minKits, Math.floor(shipped / perKit));
      }
      kitsShippedViaComp = Number.isFinite(minKits) ? Math.max(0, minKits) : 0;
    }
    const orderKitsRemaining = Math.max(0, kitQty - wholeShipped - kitsShippedViaComp);
    if (wholeUnitsToShip + componentKitUnitsToShip > orderKitsRemaining) {
      const err = new Error(
        `План отгрузки комплекта превышает остаток заказа: ` +
          `к отгрузке ${wholeUnitsToShip + componentKitUnitsToShip}, осталось ${orderKitsRemaining}`
      );
      err.statusCode = 409;
      throw err;
    }

    const kitNet = await getNetReservedForOrderProduct(orderDbId, kitId, orderIdStr || null, warehouseId);
    const requireReserve = kitNet > 0;

    if (wholeUnitsToShip > 0) {
      await stockMovementsService.applyOrderAssemblyShipment(kitId, {
        shipQty: wholeUnitsToShip,
        unreserveReason: `Отгрузка: снятие резерва комплекта по заказу ${orderIdStr}`.trim(),
        shipmentReason: `Отгрузка: списание комплекта (1 SKU) по заказу ${orderIdStr}`.trim(),
        meta: metaBase,
        requireReserve
      });
    }

    if (componentKitUnitsToShip > 0) {
      const compQtyMap = buildKitComponentQtyMap(components, componentKitUnitsToShip);
      for (const [compId, compQty] of compQtyMap) {
        await this._applyAssemblyStockForOrderProduct(orderRow, compId, compQty);
      }
    }
  }

  /** Снять остаточный резерв после отгрузки (если unreserve не прошёл по складу / комплекту). */
  async _releaseLeftoverOrderReserve(orderRow) {
    if (!repositoryFactory.isUsingPostgreSQL() || !orderRow) return;
    const orderDbId = orderRowDbId(orderRow);
    if (!orderDbId) return;
    const label = String(orderRow.orderId ?? orderRow.order_id ?? '').trim();
    await releaseAllReservesForOrder(orderDbId, label, async (pid, net, orderIdLabel, meta) => {
      await stockMovementsService.applyChange(pid, {
        delta: net,
        type: 'unreserve',
        reason: `Снятие остаточного резерва после отгрузки (заказ ${orderIdLabel})`.trim(),
        meta: { ...meta, post_shipment_cleanup: true }
      });
    });
  }

  /**
   * Заказ полностью списан со склада (shipment по строке) — резерв больше не нужен.
   */
  async isOrderFullyShipped(orderRow) {
    if (!orderRow || !repositoryFactory.isUsingPostgreSQL()) return false;
    const orderDbId = orderRowDbId(orderRow);
    if (!orderDbId) return false;

    const orderQty = Math.max(1, parseInt(orderRow.quantity, 10) || 1);
    let productId = await this._resolveProductIdForOrderStock(orderRow);
    const pid = Number(productId);
    if (!Number.isFinite(pid) || pid < 1) return false;

    if (await isKitProductId(pid)) {
      const components = await getKitComponents(pid);
      const wholeShipped = Math.max(0, Number(await this._getShippedQtyForOrderProduct(orderDbId, pid)) || 0);
      let kitsViaComp = 0;
      if (components.length > 0) {
        let minKits = Infinity;
        for (const c of components) {
          const compId = Number(c.component_product_id);
          const perKit = Math.max(1, parseInt(c.quantity, 10) || 1);
          if (!Number.isFinite(compId) || compId < 1) continue;
          const shipped = Number(await this._getShippedQtyForOrderProduct(orderDbId, compId)) || 0;
          minKits = Math.min(minKits, Math.floor(shipped / perKit));
        }
        kitsViaComp = Number.isFinite(minKits) ? Math.max(0, minKits) : 0;
      }
      return wholeShipped + kitsViaComp >= orderQty;
    }

    const shipped = Number(await this._getShippedQtyForOrderProduct(orderDbId, pid)) || 0;
    return shipped >= orderQty;
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
      await this._releaseLeftoverOrderReserve(orderRow);
      return;
    }

    const productId = await this._resolveProductIdForOrderStock(orderRow);
    if (!productId) return;

    if (await isKitProductId(productId)) {
      await this._applyAssemblyStockForKitOrder(orderRow, productId);
      await this._releaseLeftoverOrderReserve(orderRow);
      return;
    }

    await this._applyAssemblyStockForOrderProduct(orderRow, productId);
    await this._releaseLeftoverOrderReserve(orderRow);
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
    const errors = [];

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
        if (!isOrderShipmentDeductStatus(status)) {
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
        const message = e?.message || String(e);
        console.warn('[Orders] applyAssemblyStockForShipmentOrders:', orderId, message);
        errors.push({ orderId, message });
      }
    }

    return { processed, stockOnly, skipped, notFound, errors };
  }

  /**
   * Догоняющее списание: заказы в статусе отгрузки/логистики без движения shipment в журнале.
   */
  async reconcileMissingShipmentStockForProduct(productId, { profileId = null, limit = 80 } = {}) {
    if (!repositoryFactory.isUsingPostgreSQL()) {
      return { processed: 0, skipped: 0, errors: [] };
    }
    const pid = Number(productId);
    if (!Number.isFinite(pid) || pid < 1) {
      return { processed: 0, skipped: 0, errors: [] };
    }

    const statuses = [...ORDER_SHIPMENT_DEDUCT_STATUSES];
    const params = [pid, statuses];
    let profileSql = '';
    if (profileId != null && String(profileId).trim() !== '') {
      const p = Number(profileId);
      if (Number.isFinite(p) && p > 0) {
        profileSql = ` AND o.profile_id = $${params.length + 1}`;
        params.push(p);
      }
    }

    const r = await query(
      `SELECT o.id, o.marketplace, o.order_id, o.status, o.quantity, o.product_id, o.order_group_id
       FROM orders o
       WHERE LOWER(TRIM(COALESCE(o.status, ''))) = ANY($2::text[])
         AND (
           o.product_id = $1::bigint
           OR o.product_id IN (SELECT component_product_id FROM kit_components WHERE kit_product_id = $1::bigint)
           OR EXISTS (SELECT 1 FROM kit_components kc WHERE kc.kit_product_id = o.product_id AND kc.component_product_id = $1::bigint)
         )
         ${profileSql}
       ORDER BY o.updated_at DESC NULLS LAST
       LIMIT ${Math.max(1, Math.min(500, Number(limit) || 80))}`,
      params
    );

    let processed = 0;
    let skipped = 0;
    const errors = [];
    const seen = new Set();

    for (const row of r.rows || []) {
      const dbId = orderRowDbId(row);
      if (dbId == null || seen.has(dbId)) continue;
      seen.add(dbId);

      try {
        if (await this.isOrderFullyShipped(row)) {
          skipped += 1;
          await this._releaseLeftoverOrderReserve(row).catch(() => {});
          continue;
        }
        await this._applyAssemblyStockForOrderRow(row);
        if (await this.isOrderFullyShipped(row)) {
          processed += 1;
        } else {
          skipped += 1;
        }
      } catch (e) {
        errors.push({
          orderId: row.order_id,
          message: e?.message || String(e)
        });
      }
    }

    return { processed, skipped, errors };
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

  /** Быстрая сводка резерва без построения lines (для toggle до/после setOrderReserve). */
  async _lightOrderReserveSnapshot(rows) {
    let totalNeed = 0;
    let totalReserved = 0;
    for (const row of rows || []) {
      const id = orderRowDbId(row);
      const qty = Math.max(1, parseInt(row.quantity, 10) || 1);
      totalNeed += qty;
      if (!id) continue;
      const productId = await this._resolveProductIdForOrderStock(row).catch(() => null);
      const pid = Number(productId);
      if (!Number.isFinite(pid) || pid < 1) continue;
      if (await isKitProductId(pid)) {
        totalReserved += await getReservedKitUnitsForOrderValidation(pid, id);
      } else {
        totalReserved += await this._getReservedQtyForOrderProduct(id, pid);
      }
    }
    return {
      hasReserve: totalReserved > 0,
      reservedQty: totalReserved,
      needQty: totalNeed,
      fullyReserved: totalNeed > 0 && totalReserved >= totalNeed
    };
  }

  /**
   * Ручное снятие резерва по заказу: не дозарезервировать автоматически, пока пользователь
   * снова не поставит резерв вручную (reserve после manual unreserve).
   */
  async _manualUnreserveBlocksAutoReserve(orderDbId, productId, marketplaceOrderId = null) {
    const oid = Number(orderDbId);
    const pid = Number(productId);
    if (!Number.isFinite(oid) || oid < 1 || !Number.isFinite(pid) || pid < 1) return false;

    const scopeIds = new Set([pid]);
    if (await isKitProductId(pid)) {
      for (const c of await getKitComponents(pid)) {
        const cid = Number(c.component_product_id);
        if (Number.isFinite(cid) && cid > 0) scopeIds.add(cid);
      }
    }
    const parents = await query(
      `SELECT DISTINCT kit_product_id FROM kit_components WHERE component_product_id = $1`,
      [pid]
    );
    for (const row of parents.rows || []) {
      const kid = Number(row.kit_product_id);
      if (Number.isFinite(kid) && kid > 0) scopeIds.add(kid);
    }

    const mpLabel =
      marketplaceOrderId != null && String(marketplaceOrderId).trim() !== ''
        ? String(marketplaceOrderId).trim()
        : null;

    for (const scopePid of scopeIds) {
      const r = await query(
        `SELECT
           (SELECT MAX(sm.id) FROM stock_movements sm
            WHERE sm.product_id = $1
              AND sm.type = 'unreserve'
              AND (
                sm.meta->>'manual_unreserve' IN ('true', 't')
                OR (sm.meta->'manual_unreserve')::text = 'true'
              )
              AND ${orderReserveMovementMatchSql('sm.', 2, 3)}) AS last_manual_id,
           (SELECT MAX(sm.id) FROM stock_movements sm
            WHERE sm.product_id = $1
              AND sm.type = 'reserve'
              AND ${orderReserveMovementMatchSql('sm.', 2, 3)}) AS last_reserve_id`,
        [scopePid, oid, mpLabel]
      );
      const lastManual = Number(r.rows?.[0]?.last_manual_id) || 0;
      const lastReserve = Number(r.rows?.[0]?.last_reserve_id) || 0;
      if (lastManual > 0 && lastManual > lastReserve) return true;
    }
    return false;
  }

  /** Резерв для строки заказа из БД: частичный резерв и дозаполнение до qty при появлении остатка. */
  async _applyReserveForOrderIfAbsent(
    orderRow,
    { skipKitReconcile = false, allowDespiteManualUnreserve = false } = {}
  ) {
    if (!repositoryFactory.isUsingPostgreSQL() || !orderRow) return;
    if (isOrderTerminalNoReserve(orderRow.status)) return;
    const id = orderRowDbId(orderRow);
    const orderIdStr = String(orderRow.orderId ?? orderRow.order_id ?? '').trim();
    const qty = Math.max(1, parseInt(orderRow.quantity, 10) || 1);
    if (!id) return;
    const productId = await this._resolveProductIdForOrderStock(orderRow);
    if (!productId) return;

    if (
      !allowDespiteManualUnreserve &&
      (await this._manualUnreserveBlocksAutoReserve(id, productId, orderIdStr || null))
    ) {
      return;
    }

    const rawProductId = orderRow?.productId ?? orderRow?.product_id;
    if (rawProductId == null || String(rawProductId).trim() === '') {
      query(
        `UPDATE orders SET product_id = $1, updated_at = CURRENT_TIMESTAMP
         WHERE id = $2 AND product_id IS NULL`,
        [productId, id]
      ).catch(() => {});
    }

    const warehouseId = await this._resolveWarehouseIdForOrderReserve(orderRow, productId);
    const strictWh = isStrictWarehouseOrderRow(orderRow);
    if (strictWh && (warehouseId == null || String(warehouseId).trim() === '')) return;

    const { getProductSupplySnapshotWithClient } = await import('./sellableQuantity.service.js');
    if (!(await isKitProductId(productId))) {
      const avail = await this._availableUnitsForOrderReserve(productId, orderRow, warehouseId);
      if (avail <= 0) return;
    } else {
      const maxKitsGate = await this._computeMaxKitUnitsReservableForOrder(productId, warehouseId, {
        orderRow
      });
      if (maxKitsGate <= 0) return;
    }

    // Частичный резерв:
    // - резервируем только то, что уже есть (факт + ожидается - уже зарезервировано)
    // - если пришла часть товара, резервируем эту часть, даже если до количества заказа не хватает
    if (await isKitProductId(productId)) {
      if (!skipKitReconcile) {
        try {
          await reconcileMisplacedKitWholeReserve(
            productId,
            id,
            orderIdStr || String(id),
            { warehouse_id: warehouseId, order_id: id, orderId: orderIdStr, strict_warehouse: strictWh },
            {
              unreserveProduct: (pid, net, oid, m) =>
                stockMovementsService.applyChange(pid, {
                  delta: net,
                  type: 'unreserve',
                  reason: `Перенос резерва комплекта на комплектующие (заказ ${oid})`.trim(),
                  meta: m
                }),
              applyKitReserve: (kitId, kits, oid, m) =>
                applyKitOrderReserve(kitId, kits, oid, m, (compId, compQty, o, mm) =>
                  this._applyReserveForOrderComponent(compId, compQty, o, mm)
                )
            }
          );
        } catch (e) {
          if (e?.statusCode !== 400) throw e;
        }

        try {
          await reconcileMixedKitOrderReservePaths(
            productId,
            id,
            orderIdStr || String(id),
            { warehouse_id: warehouseId, order_id: id, orderId: orderIdStr, strict_warehouse: strictWh },
            (pid, net, oid, m) =>
              stockMovementsService.applyChange(pid, {
                delta: net,
                type: 'unreserve',
                reason: `Снятие дублирующего резерва комплекта (заказ ${oid})`.trim(),
                meta: m
              })
          );
        } catch (e) {
          if (e?.statusCode !== 400) throw e;
        }
      }

      const alreadyReservedKits = await getReservedKitUnitsForOrderValidation(productId, id);
      const need = Math.max(0, qty - alreadyReservedKits);
      if (need <= 0) return;
      const maxKits = await this._computeMaxKitUnitsReservableForOrder(productId, warehouseId, {
        orderRow
      });
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
            order_qty: qty,
            order_row: orderRow,
            warehouse_id: warehouseId,
            strict_warehouse: strictWh,
            partial: reserveKits < need
          },
          (compId, compQty, oid, m) =>
            this._applyReserveForOrderComponent(compId, compQty, oid, m)
        );
      } catch (e) {
        if (e?.statusCode === 400) return;
        throw e;
      }
      this._scheduleAutoSendToAssemblyAfterReserve(orderRow);
      return;
    }

    const alreadyReservedForOrder = await this._getReservedQtyForOrderProduct(id, productId);
    const need = Math.max(0, qty - alreadyReservedForOrder);
    if (need <= 0) return;

    const snapAvail = await this._availableUnitsForOrderReserve(productId, orderRow, warehouseId);
    if (snapAvail <= 0) return;

    const reserveNow = Math.min(need, snapAvail);
    if (reserveNow <= 0) return;

    if (!isMarketplaceFbsOrderRow(orderRow)) {
      const snapFinal = await getProductSupplySnapshotWithClient(null, productId);
      if (Math.floor(snapFinal.available) < reserveNow) return;
    }

    try {
      await this._applyReserveForOrder(productId, reserveNow, orderIdStr || String(id), {
        order_id: id,
        orderId: orderIdStr,
        order_row: orderRow,
        warehouse_id: warehouseId,
        strict_warehouse: strictWh,
        partial: reserveNow < need
      });
    } catch (e) {
      if (e?.statusCode === 400) return;
      throw e;
    }
    this._scheduleAutoSendToAssemblyAfterReserve(orderRow);
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
          const st = String(o?.status ?? '').trim().toLowerCase();
          await this._applyReserveForOrderIfAbsent(o, {
            allowDespiteManualUnreserve: st === 'in_procurement'
          });
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
      const kitIdByOrderDbId = new Map();
      for (const row of orders) {
        const oid = orderRowDbId(row);
        if (!oid) continue;
        const pid = Number(row.productId ?? row.product_id) || 0;
        const reserved = Number(row.reservedQty ?? row.reserved_qty) || 0;

        if (Number.isFinite(pid) && pid > 0) {
          if (kitPiecesMap.has(pid)) {
            kitIdByOrderDbId.set(oid, pid);
            continue;
          }
          // Комплектующая в каталоге ≠ заказ на комплект: резерв считаем по product_id строки.
        }

        // Дорогой поиск по SKU заказа — только при резерве или без product_id (часто WB).
        if (reserved <= 0 && Number.isFinite(pid) && pid > 0) continue;

        const kitId = await findKitProductIdForMarketplaceOrder(pid, row);
        if (kitId != null) kitIdByOrderDbId.set(oid, Number(kitId));
      }

      const correctedRows = [];
      for (const o of orders) {
        const oid = orderRowDbId(o);
        let reserved = Number(o.reservedQty ?? o.reserved_qty) || 0;
        let need = orderReserveNeedQty(o);
        const kitId = oid ? kitIdByOrderDbId.get(oid) : null;
        const pid = Number(o.productId ?? o.product_id);
        const sqlReserved = reserved;
        if (oid && kitId && Number.isFinite(pid) && pid > 0 && kitPiecesMap.has(pid)) {
          reserved = await getReservedKitUnitsForOrderValidation(kitId, oid);
          need = Math.max(1, parseInt(o.quantity, 10) || 1);
        } else if (oid && kitId && (!Number.isFinite(pid) || pid < 1)) {
          reserved = await getReservedKitUnitsForOrderValidation(kitId, oid);
          need = Math.max(1, parseInt(o.quantity, 10) || 1);
        } else if (
          oid &&
          Number.isFinite(pid) &&
          pid > 0 &&
          (componentKitMap.has(pid) || (kitId && !kitPiecesMap.has(pid)))
        ) {
          const productReserved = await this._getReservedQtyForOrderProduct(oid, pid);
          reserved = Math.max(sqlReserved, productReserved);
          if (componentKitMap.has(pid)) {
            need = Math.max(1, parseInt(o.quantity, 10) || 1);
          } else if (reserved > need) {
            need = await this._resolveOrderReserveNeedQtyForLight(o, kitPiecesMap, componentKitMap);
          }
        } else if (reserved > need) {
          need = await this._resolveOrderReserveNeedQtyForLight(o, kitPiecesMap, componentKitMap);
        }
        correctedRows.push({ o, reserved, need, oid });
      }

      const orderIdsWithReserve = correctedRows
        .filter((x) => x.reserved > 0 && x.oid)
        .map((x) => x.oid);
      const coverageByOrderId = await buildReserveCoverageByOrderIds(orderIdsWithReserve);

      for (const { o, reserved, need, oid } of correctedRows) {
        o.reservedQty = reserved;
        o.reserved_qty = reserved;
        o.needQty = need;
        o.need_qty = need;
        o.hasReserve = reserved > 0;
        o.has_reserve = reserved > 0;
        o.fullyReserved = need > 0 && reserved >= need;
        if (oid && coverageByOrderId.has(oid)) {
          o.reserveCoverage = coverageByOrderId.get(oid);
          o.reserve_coverage = o.reserveCoverage;
        } else if (reserved > 0) {
          const pid = Number(o.productId ?? o.product_id);
          const fifoKey =
            Number.isFinite(pid) && pid > 0 && Number.isFinite(oid) && oid > 0
              ? `${oid}:${pid}`
              : null;
          let kind = 'incoming';
          if (fifoKey && coverageFifoMap?.has(fifoKey)) {
            kind = coverageFifoMap.get(fifoKey);
          } else {
            const sup = Number.isFinite(pid) && pid > 0 ? supplyMap.get(pid) : null;
            kind = sup ? classifyOrderReserveCoverage({ ...sup, orderReserved: reserved }) : 'incoming';
          }
          o.reserveCoverage = kind;
          o.reserve_coverage = kind;
        } else {
          o.reserveCoverage = 'none';
          o.reserve_coverage = 'none';
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
        o.assemblyCompositionLines = await buildAssemblyCompositionLinesForOrder(o, this);
        o.assembly_composition_lines = o.assemblyCompositionLines;
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

  /**
   * Маркетплейс заказа по ID: если в URL неверный mp (частая ошибка wb→ozon в ссылках),
   * подставляем фактический из БД.
   */
  async resolveMarketplaceForOrderDetail(marketplace, orderId, { profileId = null } = {}) {
    const hinted = await this.getByMarketplaceAndOrderId(marketplace, orderId, { profileId });
    if (hinted?.marketplace) return hinted.marketplace;
    const any = await this.getByOrderId(orderId, { profileId });
    if (any?.marketplace) return any.marketplace;
    return marketplace;
  }

  /** Найти заказ по order_id (posting number) в любом маркетплейсе — для этикеток и роутов по :orderId */
  async getByOrderId(orderId, { profileId = null } = {}) {
    if (repositoryFactory.isUsingPostgreSQL()) {
      return await this.repository.findAnyByOrderId(orderId, profileId);
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
        deliveryAddress: created?.deliveryAddress ?? orderData.delivery_address,
        warehouse_id: created?.warehouseId ?? created?.warehouse_id ?? orderData.warehouse_id,
        warehouseId: created?.warehouseId ?? created?.warehouse_id ?? orderData.warehouse_id,
        profile_id: created?.profileId ?? created?.profile_id ?? orderData.profile_id,
        profileId: created?.profileId ?? created?.profile_id ?? orderData.profile_id
      });
    }
    return created;
  }

  /**
   * Создать ручной заказ с несколькими товарами (одна группа).
   * @param {Array<{ productId: number, quantity: number, price?: number }>} items — price за единицу (если не передана, берётся из карточки товара)
   * @param {{ profileId?: number|null, customerName?: string|null, customerPhone?: string|null, warehouseId?: number|null }} [meta]
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
    const warehouseIdRaw = meta.warehouseId ?? meta.warehouse_id ?? null;
    const warehouseId =
      warehouseIdRaw != null && warehouseIdRaw !== '' ? Number(warehouseIdRaw) : null;
    if (!Number.isFinite(warehouseId) || warehouseId < 1) {
      const error = new Error('Укажите склад списания для ручного заказа');
      error.statusCode = 400;
      throw error;
    }
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
        warehouse_id: warehouseId,
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
          orderGroupId: orderGroupId,
          warehouse_id: warehouseId,
          warehouseId,
          profile_id: Number.isFinite(profileId) && profileId > 0 ? profileId : null,
          profileId: Number.isFinite(profileId) && profileId > 0 ? profileId : null
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

  /** Строки ручного заказа по ключу группы или order_id одиночной позиции. */
  async _findManualOrderGroupRows(orderGroupId, profileId = null) {
    const gid = String(orderGroupId ?? '').trim();
    if (!gid) return [];
    let rows = await this.repository.findByOrderGroupId(gid, profileId);
    if (rows?.length) return rows;
    const single = await this.repository.findByMarketplaceAndOrderId('manual', gid, profileId);
    if (!single) return [];
    if (String(single.marketplace || '').toLowerCase() !== 'manual') return [];
    return [single];
  }

  _nextManualLineOrderId(groupKey, existingRows) {
    const ids = new Set(
      (existingRows || [])
        .map((r) => String(r.orderId ?? r.order_id ?? '').trim())
        .filter(Boolean)
    );
    let maxSuffix = 1;
    for (const id of ids) {
      if (id === groupKey) continue;
      const m = id.match(/-(\d+)$/);
      if (m) maxSuffix = Math.max(maxSuffix, parseInt(m[1], 10));
    }
    for (let n = maxSuffix + 1; n < maxSuffix + 200; n++) {
      const candidate = `${groupKey}-${n}`;
      if (!ids.has(candidate)) return candidate;
    }
    return `${groupKey}-${Date.now()}`;
  }

  async _ensureManualOrderGroupId(groupKey, rows) {
    if (!groupKey || !Array.isArray(rows) || rows.length <= 1) return;
    for (const r of rows) {
      const gid = String(r.orderGroupId ?? r.order_group_id ?? '').trim();
      if (gid === groupKey) continue;
      const dbId = orderRowDbId(r);
      if (!dbId) continue;
      await this.repository.update(dbId, { order_group_id: groupKey });
    }
  }

  /**
   * Обновить ручной заказ (только marketplace=manual, статус «Новый»).
   * @param {string} orderGroupId — order_group_id или order_id одиночной позиции
   * @param {Array<{ id?: number, productId: number, quantity: number, price?: number }>} items
   * @param {{ profileId?: number|null, customerName?: string|null, customerPhone?: string|null, warehouseId?: number|null }} [meta]
   */
  async updateManualWithItems(orderGroupId, items, meta = {}) {
    if (!repositoryFactory.isUsingPostgreSQL()) {
      const error = new Error('Редактирование ручных заказов поддерживается только при использовании PostgreSQL');
      error.statusCode = 501;
      throw error;
    }
    if (!Array.isArray(items) || items.length === 0) {
      const error = new Error('Укажите хотя бы одну позицию (items: [{ productId, quantity, price }, ...])');
      error.statusCode = 400;
      throw error;
    }
    const profileId = meta.profileId != null ? Number(meta.profileId) : null;
    const warehouseIdRaw = meta.warehouseId ?? meta.warehouse_id ?? null;
    const warehouseId =
      warehouseIdRaw != null && warehouseIdRaw !== '' ? Number(warehouseIdRaw) : null;
    if (!Number.isFinite(warehouseId) || warehouseId < 1) {
      const error = new Error('Укажите склад списания для ручного заказа');
      error.statusCode = 400;
      throw error;
    }
    const customerName =
      meta.customerName != null && String(meta.customerName).trim() !== ''
        ? String(meta.customerName).trim()
        : null;
    const customerPhone =
      meta.customerPhone != null && String(meta.customerPhone).trim() !== ''
        ? String(meta.customerPhone).trim()
        : null;

    const anchorId = String(orderGroupId ?? '').trim();
    if (!anchorId) {
      const error = new Error('Не указан идентификатор заказа');
      error.statusCode = 400;
      throw error;
    }

    const existingRows = await this._findManualOrderGroupRows(anchorId, profileId);
    if (!existingRows.length) {
      const error = new Error('Ручной заказ не найден');
      error.statusCode = 404;
      throw error;
    }
    for (const r of existingRows) {
      if (String(r.marketplace || '').toLowerCase() !== 'manual') {
        const error = new Error('Редактирование доступно только для ручных заказов');
        error.statusCode = 400;
        throw error;
      }
      if (!isManualOrderEditableStatus(r.status)) {
        const error = new Error('Редактирование доступно только для заказов в статусе «Новый»');
        error.statusCode = 400;
        throw error;
      }
    }

    const groupKey =
      String(existingRows[0].orderGroupId ?? existingRows[0].order_group_id ?? '').trim() ||
      getManualOrderGroupKey(existingRows[0].orderId ?? existingRows[0].order_id) ||
      anchorId;

    for (const r of existingRows) {
      await this.releaseReserveIfExistsForOrder('manual', r.orderId ?? r.order_id);
    }

    const productsService = (await import('./products.service.js')).default;
    const existingById = new Map(
      existingRows
        .map((r) => [orderRowDbId(r), r])
        .filter(([id]) => id != null)
    );
    const keepDbIds = new Set();
    const workingRows = [...existingRows];

    for (const item of items) {
      const productId = item.productId != null ? Number(item.productId) : null;
      const quantity = Math.max(1, parseInt(item.quantity, 10) || 1);
      if (!productId || !Number.isInteger(productId) || productId < 1) continue;
      const productObj = await productsService.getById(productId);
      if (!productObj) continue;
      let price = item.price != null && item.price !== '' ? Number(item.price) : NaN;
      if (!Number.isFinite(price) || price < 0) {
        price =
          productObj.cost != null
            ? Number(productObj.cost)
            : productObj.price != null
              ? Number(productObj.price)
              : 0;
      }

      const itemDbId = item.id != null ? Number(item.id) : null;
      const existingRow =
        itemDbId != null && Number.isFinite(itemDbId) && itemDbId > 0
          ? existingById.get(itemDbId)
          : null;

      if (existingRow) {
        const dbId = orderRowDbId(existingRow);
        keepDbIds.add(dbId);
        await this.repository.update(dbId, {
          product_id: productId,
          product_name: productObj.name ?? productObj.product_name ?? null,
          quantity,
          price,
          customer_name: customerName,
          customer_phone: customerPhone,
          warehouse_id: warehouseId
        });
        continue;
      }

      const orderId =
        workingRows.length === 0
          ? groupKey
          : this._nextManualLineOrderId(
              groupKey,
              workingRows
            );
      const orderData = {
        profile_id: Number.isFinite(profileId) && profileId > 0 ? profileId : null,
        marketplace: 'manual',
        order_id: orderId,
        order_group_id:
          items.length > 1 ||
          existingRows.length > 1 ||
          existingRows[0]?.orderGroupId ||
          existingRows[0]?.order_group_id
            ? groupKey
            : null,
        product_id: productId,
        product_name: productObj.name ?? productObj.product_name ?? null,
        offer_id: null,
        marketplace_sku: null,
        quantity,
        price,
        status: 'new',
        customer_name: customerName,
        customer_phone: customerPhone,
        warehouse_id: warehouseId
      };
      const row = await this.repository.create(orderData);
      workingRows.push(row);
      const newDbId = orderRowDbId(row);
      if (newDbId != null) keepDbIds.add(newDbId);
    }

    if (keepDbIds.size === 0) {
      const error = new Error('Не удалось обновить заказ: проверьте товары и цены.');
      error.statusCode = 400;
      throw error;
    }

    for (const r of existingRows) {
      const dbId = orderRowDbId(r);
      if (dbId == null || keepDbIds.has(dbId)) continue;
      await this.repository.delete(dbId);
    }

    let finalRows = await this._findManualOrderGroupRows(groupKey, profileId);
    if (!finalRows.length) {
      finalRows = [];
      for (const id of keepDbIds) {
        const row = await this.repository.findById(id);
        if (row) finalRows.push(row);
      }
      finalRows.sort((a, b) => Number(a.id) - Number(b.id));
    }

    if (finalRows.length > 1) {
      await this._ensureManualOrderGroupId(groupKey, finalRows);
      finalRows = await this._findManualOrderGroupRows(groupKey, profileId);
    }

    for (const row of finalRows) {
      const oid = orderRowDbId(row);
      const orderId = row.orderId ?? row.order_id;
      const productId = row.productId ?? row.product_id;
      if (!oid || !productId) continue;
      await this._reserveForOrderIfStockAvailable({
        id: oid,
        orderId,
        order_id: orderId,
        productId,
        product_id: productId,
        quantity: row.quantity ?? 1,
        status: row.status ?? 'new',
        marketplace: 'manual',
        deliveryAddress: null,
        orderGroupId: groupKey,
        warehouse_id: warehouseId,
        warehouseId,
        profile_id: row.profileId ?? row.profile_id ?? profileId,
        profileId: row.profileId ?? row.profile_id ?? profileId
      });
    }

    return { orderGroupId: groupKey, orders: finalRows };
  }

  /** Найти все заказы группы (для сборки) */
  async getByOrderGroupId(orderGroupId) {
    if (!repositoryFactory.isUsingPostgreSQL() || !orderGroupId) return [];
    return await this.repository.findByOrderGroupId(orderGroupId);
  }

  /** Заказ по артикулу самой карточки товара (products.sku / product_skus), а не по SKU комплекта. */
  async _orderRowMatchesProductCatalogSku(productId, orderRow) {
    const pid = Number(productId);
    if (!Number.isFinite(pid) || pid < 1) return false;
    const candidates = collectOrderSkuCandidates(orderRow);
    if (!candidates.length) return false;
    const upper = candidates.map((c) => String(c).trim().toUpperCase()).filter(Boolean);
    if (!upper.length) return false;
    try {
      const r = await query(
        `SELECT TRIM(COALESCE(p.sku, '')) AS sku
         FROM products p
         WHERE p.id = $1 AND TRIM(COALESCE(p.sku, '')) <> ''
         UNION
         SELECT TRIM(COALESCE(ps.sku, ''))
         FROM product_skus ps
         WHERE ps.product_id = $1 AND TRIM(COALESCE(ps.sku, '')) <> ''`,
        [pid]
      );
      const catalog = new Set(
        (r.rows || []).map((row) => String(row.sku).trim().toUpperCase()).filter(Boolean)
      );
      return upper.some((c) => catalog.has(c));
    } catch {
      return false;
    }
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
    // Ручной заказ: product_id задан явно при создании — комплект и комплектующие резервируются по строкам.
    if (isManualOrderRow(orderRow)) {
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
    if (resolved != null) {
      return resolved;
    }
    if (await isKitProductId(productId)) {
      // Заказ привязан к SKU комплекта в orders.product_id — резервируем комплект.
      return productId;
    }
    if (await isKitComponentProductId(productId)) {
      if (await this._orderRowMatchesProductCatalogSku(productId, orderRow)) {
        return productId;
      }
      // Комплектующая без совпадения артикула заказа с комплектом — не резервируем как обычный товар.
      return null;
    }
    return productId;
  }

  /** Сколько комплектов можно зарезервировать на складе заказа; для FBS — без fallback на другие склады. */
  async _computeMaxKitUnitsReservableForOrder(kitProductId, warehouseId, opts = {}) {
    const kitId = Number(kitProductId);
    if (!Number.isFinite(kitId) || kitId < 1) return 0;
    const strict =
      opts.strictWarehouse === true ||
      (opts.orderRow != null && isStrictWarehouseOrderRow(opts.orderRow));
    const wh =
      warehouseId != null && String(warehouseId).trim() !== '' ? warehouseId : null;
    if (wh != null) {
      const scoped = await computeMaxKitUnitsReservable(kitId, { warehouseId: wh });
      if (scoped > 0 || strict) return scoped;
    }
    if (strict) return 0;
    return computeMaxKitUnitsReservable(kitId, { warehouseId: null });
  }

  /** Сколько комплектов можно зарезервировать: только из комплектующих, если целых SKU нет. */
  async _kitReservableUnitsForOrderLine(kitId, warehouseId, orderRow, { remainingKits = null } = {}) {
    const kid = Number(kitId);
    if (!Number.isFinite(kid) || kid < 1) return 0;
    const wh =
      warehouseId != null && String(warehouseId).trim() !== '' ? warehouseId : null;
    const breakdown = await computeKitReservableBreakdown(kid, { warehouseId: wh });
    const wholeReserveAvail = Math.max(0, Number(breakdown.wholeReserveAvail) || 0);
    const headroom =
      remainingKits != null ? Math.max(0, Number(remainingKits) || 0) : null;
    if (wholeReserveAvail <= 0) {
      const asm = Math.floor(await computeAssemblableFromComponents(kid, { warehouseId: wh }));
      return headroom != null ? Math.min(headroom, asm) : asm;
    }
    const maxKits = await this._computeMaxKitUnitsReservableForOrder(kid, wh, { orderRow });
    return headroom != null ? Math.min(headroom, maxKits) : maxKits;
  }

  /**
   * Сколько единиц можно зарезервировать по позиции (комплектующая / комплект / обычный товар).
   * Для комплектующей заказа-комплекта — supply SKU и собираемость родительского комплекта.
   */
  async _getAvailableUnitsForOrderReserveLine(productId, orderRow, { warehouseId = null, kitProductId = null } = {}) {
    const pid = Number(productId);
    if (!Number.isFinite(pid) || pid < 1) return 0;
    if (orderRow != null && this._fbsReserveWarehouseBlocked(orderRow, warehouseId)) {
      return 0;
    }

    const kitId =
      kitProductId != null && Number.isFinite(Number(kitProductId))
        ? Number(kitProductId)
        : null;

    if (kitId != null && kitId > 0 && pid !== kitId && (await isKitProductId(kitId))) {
      const components = await getKitComponents(kitId);
      const comp = components.find((c) => Number(c.component_product_id) === pid);
      const perKit = comp ? Math.max(1, parseInt(comp.quantity, 10) || 1) : 1;
      const compAvail = await getReservableSupplyUnits(pid, {
        warehouseId: warehouseId != null && String(warehouseId).trim() !== '' ? warehouseId : null
      });
      const maxKits = await this._computeMaxKitUnitsReservableForOrder(kitId, warehouseId, {
        orderRow
      });
      return Math.min(Math.floor(compAvail), Math.floor(maxKits) * perKit);
    }

    if (await isKitProductId(pid)) {
      return Math.floor(
        await this._kitReservableUnitsForOrderLine(pid, warehouseId, orderRow)
      );
    }

    const units = Math.floor(
      await getReservableSupplyUnits(pid, {
        warehouseId: warehouseId != null && String(warehouseId).trim() !== '' ? warehouseId : null
      })
    );
    if (!orderStatusAllowsIncomingReserve(orderRow?.status)) {
      const wh =
        warehouseId != null && String(warehouseId).trim() !== '' ? warehouseId : null;
      const snap = await getProductSupplySnapshotWithClient(null, pid, { warehouseId: wh });
      return Math.min(units, Math.max(0, Math.floor(onHandHeadroomBeforeReserve(snap))));
    }
    return units;
  }

  /** Повторная попытка резерва (новый / закупка / после поступления остатка). */
  async _reapplyReserveForOrderRows(rows, { allowDespiteManualUnreserve = false } = {}) {
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
            const warehouseId = await this._resolveWarehouseIdForOrderReserve(row, pnum);
            const maxKits = await this._computeMaxKitUnitsReservableForOrder(pnum, warehouseId, {
              orderRow: row
            });
            if (maxKits <= 0) continue;
          } else {
            const wh = await this._resolveWarehouseIdForOrderReserve(row, pnum);
            const avail = await this._availableUnitsForOrderReserve(pnum, row, wh);
            if (avail <= 0) continue;
          }
        }
        const allowDespite =
          allowDespiteManualUnreserve ||
          String(row?.status ?? '').trim().toLowerCase() === 'in_procurement';
        await this._applyReserveForOrderIfAbsent(row, {
          allowDespiteManualUnreserve: allowDespite
        });
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
    const skuCandidates = collectOrderSkuCandidates(orderRow);
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
    let found = null;
    for (const candidate of skuCandidates) {
      found = await trySku(candidate);
      if (found != null) return found;
    }
    found = await trySku(offer);
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
    for (const candidate of skuCandidates) {
      found = await tryProductTable(candidate);
      if (found != null) return found;
    }
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
      o => isOrderOnAssemblyStatus(o.status) && String(o.productId) === String(productId)
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
    return orders.find(o => isOrderOnAssemblyStatus(o.status) && norm(o.productName || o.product_name) === norm(name)) || null;
  }

  /**
   * Отправить выбранные заказы на сборку: обновить статус на 'in_assembly'.
   * @param {Array<{ marketplace: string, orderId: string }>} orderIds
   * @returns {{ sent: number, updated: number }}
   */
  async _sendToAssemblyPostgresBulk(orderIds, profileId, { deferReserve, preserveAssembled = false }) {
    const preserveStatuses = preserveAssembled
      ? ['assembled', 'shipped', 'in_transit', 'delivered', 'cancelled']
      : ['shipped', 'in_transit', 'delivered', 'cancelled'];
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
          assembled_at = NULL,
          assembled_by_user_id = NULL,
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
    const preserveAssembled = options.preserveAssembled === true;
    if (repositoryFactory.isUsingPostgreSQL()) {
      return this._sendToAssemblyPostgresBulk(orderIds, profileId, { deferReserve, preserveAssembled });
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
      const procurementEnabled = await resolveProfileProcurementStatusEnabled(
        profileId ?? order.profile_id ?? order.profileId ?? null
      );
      if (!procurementEnabled) {
        if (!opts.skipReserveReapply) {
          this._scheduleReapplyReserveAfterProcurement({
            orderGroupId: order.orderGroupId || null,
            marketplace,
            orderId,
            profileId,
          });
        }
        return order;
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
      if (!opts.skipReserveReapply) {
        this._scheduleReapplyReserveAfterProcurement({
          orderGroupId: order.orderGroupId || null,
          marketplace,
          orderId,
          profileId,
        });
      }
      setImmediate(() => {
        void this._removeProcurementOrdersFromOpenShipments(
          [{ marketplace, order_id: String(orderId), profile_id: profileId }],
          profileId
        );
      });
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
      o.status IN ('new', 'in_assembly', 'wb_assembly', 'unknown')
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

    const procurementEnabled = await resolveProfileProcurementStatusEnabled(profileId);
    if (!procurementEnabled) {
      if (seedRows.length > 0 && !skipReserveReapply) {
        setImmediate(() => {
          this._reapplyReserveForOrderRows(seedRows).catch((e) => {
            console.warn('[Orders] bulk reserve without procurement status:', e?.message || e);
          });
        });
      }
      return { updated: 0, skipped, procurementStatusDisabled: true, rows: [] };
    }

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
    if (uniqueRows.length > 0) {
      setImmediate(() => {
        void this._removeProcurementOrdersFromOpenShipments(uniqueRows, profileId);
      });
    }

    return { updated: seedRows.length, skipped, rows: uniqueRows };
  }

  async _removeProcurementOrdersFromOpenShipments(orderRows, profileId = null) {
    if (!Array.isArray(orderRows) || orderRows.length === 0) return;
    const shipmentsService = (await import('./shipments.service.js')).default;
    const seen = new Set();
    for (const row of orderRows) {
      const mp = String(row.marketplace ?? row.marketplace_db ?? '').trim();
      const oid = String(row.order_id ?? row.orderId ?? '').trim();
      if (!mp || !oid || seen.has(`${mp}|${oid}`)) continue;
      seen.add(`${mp}|${oid}`);
      try {
        await shipmentsService.removeOrderFromOpenShipments(mp, oid, {
          profileId: profileId ?? row.profile_id ?? row.profileId ?? null,
          organizationId: row.organization_id ?? row.organizationId ?? null,
        });
      } catch (e) {
        console.warn('[Orders] remove from shipment on procurement:', oid, e?.message || e);
      }
    }
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
    let totalNeed = 0;
    let totalReserved = 0;
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
        reserved = await getReservedKitUnitsForOrderValidation(pid, id);
        totalNeed += qty;
        totalReserved += reserved;
        const preferredWh = await this._resolveWarehouseIdForOrderReserve(row, pid);
        const warehouseId = preferredWh;
        const maxKitsAvail = await this._computeMaxKitUnitsReservableForOrder(pid, warehouseId, {
          orderRow: row
        });
        const breakdown = await computeKitReservableBreakdown(pid, { warehouseId });
        const onKitRes = await this._getReservedQtyForOrderProduct(id, pid);
        const wholeAvail = Math.max(0, Number(breakdown.wholeReserveAvail) || 0);
        const reserveOnWholeSku = onKitRes > 0;
        const reserveOnComponents = !reserveOnWholeSku && reserved > 0;
        const remainingKits = Math.max(0, qty - reserved);
        const kitReservableQty =
          wholeAvail > 0 ? Math.min(remainingKits, wholeAvail, maxKitsAvail) : 0;

        const components = await getKitComponents(pid);
        const componentCandidates = [];
        for (const c of components) {
          const compId = Number(c.component_product_id);
          if (!Number.isFinite(compId) || compId < 1) continue;
          const perKit = Math.max(1, parseInt(c.quantity, 10) || 1);
          const compRes = await this._getReservedQtyForOrderProduct(id, compId);
          const compAvail = await this._getAvailableUnitsForOrderReserveLine(compId, row, {
            warehouseId,
            kitProductId: pid
          });
          const compLabel = (await this._productDisplayLabelById(compId)) || 'Комплектующая';
          componentCandidates.push({
            productId: compId,
            reservedQty: compRes,
            needQty: qty * perKit,
            perKitQty: perKit,
            reservedKitUnits: Math.floor(compRes / perKit),
            needKitUnits: qty,
            availableQty: compAvail,
            lineKind: 'component',
            kitProductId: pid,
            kitReserveFromComponents: true,
            label: `${compLabel} (×${perKit} в комплекте)`
          });
        }

        const fullCompositionHint =
          componentCandidates.length > 0
            ? `Состав: ${componentCandidates.map((e) => e.label).filter(Boolean).join('; ')}`
            : null;

        // Приоритет: целый комплект (1 SKU) только при фактическом наличии на складе.
        const physicalOnHand = Math.max(0, Number(breakdown.physicalOnHand) || 0);
        const wholeReserveAvail = Math.max(0, Number(breakdown.wholeReserveAvail) || 0);
        const componentsOnlyReserve = wholeReserveAvail <= 0;
        const showKitLine =
          physicalOnHand > 0 &&
          (reserveOnWholeSku || kitReservableQty > 0 || (reserved > 0 && componentsOnlyReserve));

        if (showKitLine) {
          let availableQty = await this._kitReservableUnitsForOrderLine(pid, warehouseId, row, {
            remainingKits
          });
          const preferComponentsForRemainder =
            componentsOnlyReserve || (reserveOnWholeSku && remainingKits > 0);
          lineEntries.push({
            productId: pid,
            reservedQty: reserved,
            needQty: qty,
            availableQty,
            lineKind: reserveOnWholeSku ? 'kit_whole' : 'kit',
            kitReserveFromComponents:
              reserveOnComponents ||
              preferComponentsForRemainder ||
              componentsOnlyReserve,
            label: orderLineLabel || 'Комплект',
            compositionHint: fullCompositionHint
          });
        } else if (componentCandidates.length > 0) {
          const remainingKitsAgg = Math.max(0, qty - reserved);
          let availableQty = await this._kitReservableUnitsForOrderLine(pid, warehouseId, row, {
            remainingKits: remainingKitsAgg
          });
          if (kitReservableQty > 0 && wholeReserveAvail > 0) {
            availableQty = Math.min(availableQty, kitReservableQty);
          }

          // Одна строка комплекта с полным составом (все комплектующие), не только с ненулевым резервом.
          lineEntries.push({
            productId: pid,
            reservedQty: reserved,
            needQty: qty,
            availableQty,
            lineKind: 'kit',
            kitReserveFromComponents: true,
            label: orderLineLabel || 'Комплект',
            compositionHint: fullCompositionHint
          });
        }
      } else if (id && Number.isFinite(pid) && pid > 0) {
        totalNeed += qty;
        reserved = await this._getReservedQtyForOrderProduct(id, pid);
        totalReserved += reserved;
        const warehouseId = await this._resolveWarehouseIdForOrderReserve(row, pid);
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
        totalNeed += qty;
        totalReserved += reserved;
        lineEntries.push({
          productId: row.productId ?? row.product_id ?? null,
          reservedQty: reserved,
          needQty: qty,
          lineKind: 'unknown',
          label: orderLineLabel
        });
      }

      if (lineEntries.length === 0) {
        totalNeed += qty;
        totalReserved += reserved;
        lineEntries.push({
          productId: Number.isFinite(pid) && pid > 0 ? pid : null,
          reservedQty: reserved,
          needQty: qty,
          lineKind: Number.isFinite(pid) && pid > 0 ? 'product' : 'unknown',
          label: orderLineLabel || row.productName || row.product_name || 'Позиция заказа'
        });
      }

      for (const le of lineEntries) {
        const isComponentLine = String(le.lineKind || '').toLowerCase() === 'component';
        lines.push({
          orderLineId: row.orderId ?? row.order_id,
          orderRowDbId: id,
          productName: row.productName ?? row.product_name ?? null,
          ...(isComponentLine
            ? {}
            : { offerId: row.offerId ?? row.offer_id ?? null }),
          ...le
        });
      }
    }
    const needQty = totalNeed > 0 ? totalNeed : lines.reduce((s, l) => s + (Number(l.needQty) || 0), 0);
    const reservedQty =
      totalReserved > 0 || totalNeed > 0
        ? totalReserved
        : lines.reduce((s, l) => s + (Number(l.reservedQty) || 0), 0);
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

  /**
   * Перед сводкой резерва в карточке заказа: перенос ошибочного резерва комплекта,
   * синхронизация products.quantity с PWS и снятие резерва без покрытия остатком.
   */
  async _reconcileReserveBeforeOrderSummary(rows) {
    if (!repositoryFactory.isUsingPostgreSQL() || !Array.isArray(rows) || !rows.length) return;

    const stockHooks = {
      unreserveProduct: (pid, net, oid, m) =>
        stockMovementsService.applyChange(pid, {
          delta: net,
          type: 'unreserve',
          reason: `Перенос резерва комплекта на комплектующие (заказ ${oid})`.trim(),
          meta: m
        }),
      applyKitReserve: (kitId, kits, oid, m) =>
        applyKitOrderReserve(kitId, kits, oid, m, (compId, compQty, o, mm) =>
          this._applyReserveForOrderComponent(compId, compQty, o, mm)
        )
    };

    for (const row of rows) {
      const id = orderRowDbId(row);
      if (!id) continue;
      const orderIdStr = String(row.orderId ?? row.order_id ?? '').trim();
      const productId = await this._resolveProductIdForOrderStock(row).catch(() => null);
      const pid = Number(productId);
      if (!Number.isFinite(pid) || pid < 1) continue;

      const warehouseId = await this._resolveWarehouseIdForOrderReserve(row, pid);
      const metaBase = {
        warehouse_id: warehouseId,
        order_id: id,
        orderId: orderIdStr,
        strict_warehouse: isMarketplaceFbsOrderRow(row),
        source: 'order_reserve_summary'
      };

      const kitIdsToReconcile = new Set();
      if (await isKitProductId(pid)) {
        kitIdsToReconcile.add(pid);
      } else {
        const parents = await query(
          `SELECT DISTINCT kit_product_id FROM kit_components WHERE component_product_id = $1`,
          [pid]
        );
        for (const pr of parents.rows || []) {
          const kid = Number(pr.kit_product_id);
          if (Number.isFinite(kid) && kid > 0) kitIdsToReconcile.add(kid);
        }
      }
      if (kitIdsToReconcile.size === 0) continue;

      for (const kitId of kitIdsToReconcile) {
        if (kitId === pid) {
          try {
            await reconcileMisplacedKitWholeReserve(
              kitId,
              id,
              orderIdStr || String(id),
              metaBase,
              stockHooks
            );
          } catch (e) {
            if (e?.statusCode !== 400) {
              console.warn('[Orders] reconcileReserveBeforeOrderSummary:', e?.message || e);
            }
          }
        }
        try {
          await reconcileMixedKitOrderReservePaths(
            kitId,
            id,
            orderIdStr || String(id),
            metaBase,
            (unreservePid, net, oid, m) =>
              stockMovementsService.applyChange(unreservePid, {
                delta: net,
                type: 'unreserve',
                reason: `Снятие дублирующего резерва комплекта (заказ ${oid})`.trim(),
                meta: m
              })
          );
        } catch (e) {
          if (e?.statusCode !== 400) {
            console.warn('[Orders] reconcileMixedKitReserve:', e?.message || e);
          }
        }
      }
    }
  }

  async getOrderReserveSummary(
    marketplace,
    orderId,
    { profileId = null, skipDetailAugment = false, skipReconcile = false, lightCoverage = false } = {}
  ) {
    const rows = await this._collectOrderRowsForReserve(marketplace, orderId, { profileId });
    if (!rows.length) {
      const err = new Error('Заказ не найден в системе');
      err.statusCode = 404;
      throw err;
    }
    if (!skipReconcile) {
      await this._reconcileReserveBeforeOrderSummary(rows);
    }
    let summary = await this._summarizeReserveForRows(rows);
    if (!skipDetailAugment) {
      summary = await this._augmentReserveFromDetailItems(summary, marketplace, orderId, rows, {
        profileId
      });
    }
    return enrichReserveSummaryCoverage(summary, { light: lightCoverage });
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

    const before = await this._lightOrderReserveSnapshot(rows);
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
    const warehouseId = await this._resolveWarehouseIdForOrderReserve(row, pid);
    const strictWh = isStrictWarehouseOrderRow(row);
    this._assertFbsReserveWarehouse(row, warehouseId);
    if (doUnreserve) {
      const isKitRoot = await isKitProductId(pid);
      if (isKitRoot) {
        const onKit = await this._getReservedQtyForOrderProduct(orderDbId, pid);
        const fromComp = await getReservedKitUnitsFromComponentsForOrder(pid, orderDbId);
        const orderQty = Math.max(1, parseInt(row.quantity, 10) || 1);

        if (quantity == null) {
          const components = await getKitComponents(pid);
          const productIds = [
            pid,
            ...(components || []).map((c) => Number(c.component_product_id))
          ].filter((n) => Number.isFinite(n) && n > 0);
          let releasedAny = false;
          const { releaseOrderReservesGroupedByWarehouse } = await import('./kitStock.service.js');
          for (const p of productIds) {
            const affected = await releaseOrderReservesGroupedByWarehouse(
              orderDbId,
              orderIdStr,
              async (productId, net, orderIdLabel, meta) => {
                await stockMovementsService.applyChange(productId, {
                  delta: net,
                  type: 'unreserve',
                  reason: `Снятие резерва по заказу ${orderIdLabel} (вручную, комплект)`.trim(),
                  meta: {
                    ...meta,
                    manual_unreserve: true,
                    skip_auto_reserve: true,
                    kit_manual_unreserve: true
                  }
                });
              },
              { productId: p }
            );
            if (affected.length) releasedAny = true;
          }
          if (!releasedAny) {
            const err = new Error('По этой позиции нет резерва для снятия');
            err.statusCode = 400;
            throw err;
          }
        } else if (onKit <= 0 && fromComp > 0) {
          const validated = resolveComplementaryKitReserveUnits(onKit, fromComp, orderQty);
          const toRelease = Math.min(Math.max(0, parseInt(quantity, 10) || 0), validated);
          if (toRelease <= 0) {
            const err = new Error('По этой позиции нет резерва для снятия');
            err.statusCode = 400;
            throw err;
          }
          const ok = await this._releaseKitUnitsFromComponentReserves(
            orderDbId,
            orderIdStr,
            pid,
            toRelease
          );
          if (!ok) {
            const err = new Error('По этой позиции нет резерва для снятия');
            err.statusCode = 400;
            throw err;
          }
        } else {
          const release =
            quantity != null
              ? Math.min(Math.max(0, parseInt(quantity, 10) || 0), net)
              : net;
          if (release <= 0) {
            const err = new Error('По этой позиции нет резерва для снятия');
            err.statusCode = 400;
            throw err;
          }
          if (fromComp > 0 && onKit > 0) {
            const err = new Error(
              'Смешанный резерв (целый комплект и комплектующие) — снимите весь резерв по позиции'
            );
            err.statusCode = 400;
            throw err;
          }
          const { releaseOrderReservesGroupedByWarehouse } = await import('./kitStock.service.js');
          const affected = await releaseOrderReservesGroupedByWarehouse(
            orderDbId,
            orderIdStr,
            async (productId, net, orderIdLabel, meta) => {
              const rel = Math.min(net, release);
              if (rel <= 0) return;
              await stockMovementsService.applyChange(productId, {
                delta: rel,
                type: 'unreserve',
                reason: `Снятие резерва по заказу ${orderIdLabel} (вручную, комплект)`.trim(),
                meta: {
                  ...meta,
                  manual_unreserve: true,
                  skip_auto_reserve: true,
                  kit_manual_unreserve: true
                }
              });
            },
            { productId: pid }
          );
          if (!affected.length) {
            const err = new Error('По этой позиции нет резерва для снятия');
            err.statusCode = 400;
            throw err;
          }
        }
      } else {
        const release =
          quantity != null
            ? Math.min(Math.max(0, parseInt(quantity, 10) || 0), net)
            : net;
        if (release <= 0) {
          const err = new Error('По этой позиции нет резерва для снятия');
          err.statusCode = 400;
          throw err;
        }
        const { releaseOrderReservesGroupedByWarehouse } = await import('./kitStock.service.js');
        const affected = await releaseOrderReservesGroupedByWarehouse(
          orderDbId,
          orderIdStr,
          async (productId, net, orderIdLabel, meta) => {
            const rel = Math.min(net, release);
            if (rel <= 0) return;
            await stockMovementsService.applyChange(productId, {
              delta: rel,
              type: 'unreserve',
              reason: `Снятие резерва по заказу ${orderIdLabel} (вручную, позиция)`.trim(),
              meta: {
                ...meta,
                manual_unreserve: true,
                skip_auto_reserve: true,
                partial_line: true
              }
            });
          },
          { productId: pid }
        );
        if (!affected.length) {
          const err = new Error('По этой позиции нет резерва для снятия');
          err.statusCode = 400;
          throw err;
        }
      }
    } else {
      const qtyWanted =
        quantity != null ? Math.max(1, parseInt(quantity, 10) || 1) : null;
      const orderQty = Math.max(1, parseInt(row.quantity, 10) || 1);
      let already = net;
      let perNeed = await this._resolveShipmentQtyForOrderProduct(row, pid);
      if (await isKitProductId(pid)) {
        already = await getReservedKitUnitsForOrderValidation(pid, orderDbId);
        perNeed = orderQty;
      }
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
      const snapManual = await this._availableUnitsForOrderReserve(pid, row, warehouseId);
      let available = await this._getAvailableUnitsForOrderReserveLine(pid, row, {
        warehouseId,
        kitProductId
      });
      const reserveAsWholeKit = (await isKitProductId(pid)) && kitProductId == null;
      if (!reserveAsWholeKit) {
        available = Math.min(available, snapManual);
      }
      toAdd = Math.min(toAdd, available);
      if (toAdd <= 0) {
        if (qtyWanted != null && qtyWanted > 0) {
          if ((await isKitProductId(pid)) && already >= orderQty) {
            const afterAlready = await enrichReserveSummaryCoverage(
              await this._summarizeReserveForRows(rows),
              { light: true }
            );
            return {
              action: 'reserve',
              productId: pid,
              ...afterAlready,
              message: 'Резерв по заказу уже установлен'
            };
          }
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
          strict_warehouse: strictWh,
          manual_reserve: true,
          partial_line: true
        };
        if (kitProductId != null) {
          const err = new Error(
            'Прямой резерв комплектующей запрещён — используйте резерв по позиции комплекта'
          );
          err.statusCode = 400;
          throw err;
        }
        if ((await isKitProductId(pid)) && kitProductId == null) {
          await this._reconcileKitReserveBeforeApply(row, pid, orderDbId, {
            ...meta,
            order_row: row,
            strict_warehouse: strictWh
          });
          const reservedKits = await applyKitOrderReserve(
            pid,
            toAdd,
            orderIdStr,
            {
              ...meta,
              order_row: row,
              order_qty: orderQty,
              partial_line: true
            },
            (compId, compQty, oid, m) =>
              this._applyReserveForOrderComponent(compId, compQty, oid, m)
          );
          if (toAdd > 0 && !(Number(reservedKits) > 0)) {
            const wh = warehouseId;
            const onKit = await getNetReservedForOrderProduct(orderDbId, pid, orderIdStr, wh);
            const fromComp = await getReservedKitUnitsFromComponentsForOrder(pid, orderDbId);
            const assemblable = await computeAssemblableFromComponents(pid, { warehouseId: wh });
            let hint = '';
            if (onKit > 0 && fromComp > 0 && onKit + fromComp > toAdd) {
              hint =
                ' На заказе дублирующий резерв на SKU и комплектующих — снимите резерв и повторите.';
            } else if (assemblable < toAdd) {
              hint = ` Собираемость из комплектующих на складе заказа: ${assemblable} компл.`;
            }
            const err = new Error(
              `Не удалось зарезервировать комплект (доступно: ${available}, запрошено: ${toAdd}).${hint}`
            );
            err.statusCode = 400;
            throw err;
          }
        } else {
          await this._applyReserveForOrderComponent(pid, toAdd, orderIdStr, {
            ...meta,
            order_row: row
          });
        }
      }
    }

    const after = await enrichReserveSummaryCoverage(
      await this._summarizeReserveForRows(rows),
      { light: true }
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

    const before = await this._lightOrderReserveSnapshot(rows);
    const act = String(action || 'toggle').toLowerCase();
    const doUnreserve = act === 'unreserve' || (act === 'toggle' && before.hasReserve);

    if (doUnreserve) {
      const oidLabel = String(rows[0]?.orderId ?? rows[0]?.order_id ?? orderId);
      const affected = await this._releaseReservesForOrderRows(rows, oidLabel, async (pid, net, orderIdLabel, meta) => {
        await stockMovementsService.applyChange(pid, {
          delta: net,
          type: 'unreserve',
          reason: `Снятие резерва по заказу ${orderIdLabel} (вручную)`.trim(),
          meta: { ...meta, manual_unreserve: true, skip_auto_reserve: true }
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
      const reservedBefore = Number(before.reservedQty) || 0;
      for (const row of rows) {
        const productId = await this._resolveProductIdForOrderStock(row);
        if (!productId) {
          const err = new Error(
            'Не удалось сопоставить товар заказа с каталогом. Укажите SKU в карточке товара или сопоставление маркетплейса.'
          );
          err.statusCode = 400;
          throw err;
        }
        const warehouseId = await this._resolveWarehouseIdForOrderReserve(row, productId);
        this._assertFbsReserveWarehouse(row, warehouseId);
        try {
          await this._applyReserveForOrderIfAbsent(row, {
            skipKitReconcile: false,
            allowDespiteManualUnreserve: true
          });
        } catch (e) {
          if (e?.statusCode === 400) throw e;
          /* ignore */
        }
      }
      const afterTry = await enrichReserveSummaryCoverage(
        await this._summarizeReserveForRows(rows),
        { light: true }
      );
      const reservedAfter = Number(afterTry.reservedQty) || 0;
      if (reservedAfter <= reservedBefore) {
        const err = new Error(
          isManualOrderRow(rows[0])
            ? 'Не удалось поставить резерв — проверьте остаток на складе для ручных заказов (Настройки → Аккаунт).'
            : 'Не удалось поставить резерв — проверьте остаток на складе FBS и сопоставление товара с каталогом.'
        );
        err.statusCode = 400;
        throw err;
      }
    }

    const after = await enrichReserveSummaryCoverage(await this._summarizeReserveForRows(rows), {
      light: true
    });
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


