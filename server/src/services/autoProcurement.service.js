/**
 * Автозакупка: позиции в открытые закупки по поставщику и bucket приезда,
 * затем реальная отправка в API поставщика (если настроен).
 */

import { query, transaction } from '../config/database.js';
import repositoryFactory from '../config/repository-factory.js';
import purchasesService from './purchases.service.js';
import ordersService, { queryOrderProductReserveMetaMap } from './orders.service.js';
import logger from '../utils/logger.js';
import { autoOrderSettingsFromApiConfig } from '../utils/supplierAutoOrderSettings.js';
import { sqlOpenSupplierReserved } from '../utils/supplierStockReservation.js';
import {
  autoArrivalNoteText,
  computeProcurementDates,
  resolveProcurementArrivalBucketFromApiConfig,
} from '../utils/supplierProcurementArrival.js';
import { shouldBypassMinOrderAmount } from '../utils/minOrderShipmentGuard.js';
import { resolveSupplierWarehouseNameForMainWarehouse } from '../utils/citySupplierWarehouse.js';
import { sortSupplierCandidatesByProcurementRules } from '../utils/supplierCandidateSort.js';
import { findOpenAutoPurchaseId } from '../utils/openPurchaseLookup.js';
import { loadWarehouseWeekendDays } from '../utils/warehouseProcurementCalendar.js';
import { computeProcurementDeficit } from '../utils/orderProcurementCoverage.js';
import { isProfileSupplierSyncEnabled } from '../utils/profileSupplierSync.js';
import { hasRecentSupplierAccept } from '../utils/recentSupplierAccept.js';
import { isKitProductId, getKitComponents } from './kitStock.service.js';
import {
  supplierPreSubmitRequired,
  trySubmitPurchaseToSupplier,
} from './supplierOrderPlacement.service.js';
import { loadSupplierReliabilityScores } from './supplierReliability.service.js';
import { runSchedulerDbJob } from '../utils/schedulerDbMutex.js';
import {
  shouldFailoverAfterSupplierSubmit,
  rollbackDemandItemsForFailover,
  unfulfillableOrderRefs,
  orderRefKey,
} from '../utils/supplierProcurementFailover.js';
import { addRuntimeNotification } from '../utils/runtime-notifications.js';

function normalizeProfileId(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'string' ? parseInt(v, 10) : Number(v);
  return Number.isNaN(n) ? null : n;
}

function orderMarketplaceToDb(marketplace) {
  const m = String(marketplace || '').toLowerCase();
  if (m === 'wildberries' || m === 'wb') return 'wb';
  if (m === 'yandex' || m === 'ym' || m === 'yandexmarket') return 'ym';
  if (m === 'manual') return 'manual';
  return m === 'ozon' ? 'ozon' : 'ozon';
}

let _runInProgress = false;

function parseApiConfig(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

const ELIGIBLE_STATUS_SQL = `(
  o.status IN ('new', 'in_assembly', 'wb_assembly', 'unknown')
  OR (
    o.marketplace = 'wb'
    AND (
      o.status = '__wb_status_pending__'
      OR LOWER(COALESCE(o.status, '')) = 'wb_status_unknown'
    )
  )
)`;

async function orderAlreadyInOpenPurchase(client, profileId, marketplace, orderId, orderGroupId = null) {
  const dbMp = orderMarketplaceToDb(marketplace);
  const oid = String(orderId ?? '').trim();
  const gid = orderGroupId != null ? String(orderGroupId).trim() : '';
  if (!dbMp || !oid) return false;
  const r = await client.query(
    `SELECT 1
     FROM purchase_items pi
     INNER JOIN purchases p ON p.id = pi.purchase_id
     CROSS JOIN LATERAL jsonb_array_elements(COALESCE(pi.source_orders, '[]'::jsonb)) AS elem
     WHERE p.profile_id = $1
       AND LOWER(COALESCE(p.status, '')) NOT IN ('cancelled', 'canceled')
       AND (
         LOWER(TRIM(elem->>'orderId')) = LOWER(TRIM($3))
         OR (
           $4::text <> ''
           AND LOWER(TRIM(elem->>'orderId')) = LOWER(TRIM($4))
         )
       )
       AND (
         CASE
           WHEN LOWER(COALESCE(elem->>'marketplace', '')) IN ('wb', 'wildberries') THEN 'wb'
           WHEN LOWER(COALESCE(elem->>'marketplace', '')) IN ('ym', 'yandex', 'yandexmarket') THEN 'ym'
           WHEN LOWER(COALESCE(elem->>'marketplace', '')) = 'manual' THEN 'manual'
           ELSE 'ozon'
         END
       ) = $2
     LIMIT 1`,
    [profileId, dbMp, oid, gid]
  );
  return (r.rows?.length ?? 0) > 0;
}

/**
 * Сколько уже закуплено по заказу и товару (антидубль автозакупки).
 * Учитываем не только open: после приёмки закупка уходит в archived, и иначе
 * заказ снова выглядит «без покрытия» и автозаказ дублирует позицию.
 * Также: недавний успешный Basket_Add (in-memory) — если локальную строку
 * откатили, а позиция у поставщика осталась.
 */
async function purchasedQtyInOpenPurchases(profileId, orderDbId, productId) {
  const oid = Number(orderDbId);
  const pid = Number(productId);
  if (!Number.isFinite(oid) || oid < 1 || !Number.isFinite(pid) || pid < 1) return 0;

  if (hasRecentSupplierAccept(profileId, oid, pid)) {
    const o = await query(`SELECT COALESCE(quantity, 1)::int AS order_qty FROM orders WHERE id = $1`, [
      oid,
    ]);
    return Math.max(0, Number(o.rows?.[0]?.order_qty) || 1);
  }

  const r = await query(
    `SELECT
       GREATEST(1, COALESCE(o.quantity, 1))::int AS order_qty,
       EXISTS (
         SELECT 1
         FROM purchase_items pi
         INNER JOIN purchases p ON p.id = pi.purchase_id
         CROSS JOIN LATERAL jsonb_array_elements(COALESCE(pi.source_orders, '[]'::jsonb)) AS elem
         WHERE p.profile_id = $1
           AND pi.product_id = $3
           AND LOWER(COALESCE(p.status, '')) NOT IN ('cancelled', 'canceled')
           AND (
             LOWER(TRIM(elem->>'orderId')) = LOWER(TRIM(o.order_id))
             OR (
               o.order_group_id IS NOT NULL
               AND LOWER(TRIM(elem->>'orderId')) = LOWER(TRIM(o.order_group_id))
             )
           )
       ) AS ever_linked,
       EXISTS (
         SELECT 1
         FROM purchase_items pi
         INNER JOIN purchases p ON p.id = pi.purchase_id
         CROSS JOIN LATERAL jsonb_array_elements(COALESCE(pi.source_orders, '[]'::jsonb)) AS elem
         WHERE p.profile_id = $1
           AND pi.product_id = $3
           AND LOWER(COALESCE(p.status, '')) NOT IN ('cancelled', 'canceled')
           AND (
             LOWER(TRIM(elem->>'orderId')) = LOWER(TRIM(o.order_id))
             OR (
               o.order_group_id IS NOT NULL
               AND LOWER(TRIM(elem->>'orderId')) = LOWER(TRIM(o.order_group_id))
             )
           )
           AND (
             NULLIF(TRIM(elem->>'supplierSubmittedAt'), '') IS NOT NULL
             OR NULLIF(TRIM(elem->>'supplier_submitted_at'), '') IS NOT NULL
             OR NULLIF(TRIM(elem->>'supplierBasketItemId'), '') IS NOT NULL
             OR NULLIF(TRIM(elem->>'supplier_basket_item_id'), '') IS NOT NULL
           )
       ) AS supplier_accepted,
       (
         SELECT COALESCE(SUM(GREATEST(0, pi.expected_quantity - pi.received_quantity)), 0)::int
         FROM purchase_items pi
         INNER JOIN purchases p ON p.id = pi.purchase_id
         CROSS JOIN LATERAL jsonb_array_elements(COALESCE(pi.source_orders, '[]'::jsonb)) AS elem
         WHERE p.profile_id = $1
           AND pi.product_id = $3
           AND p.status = 'open'
           AND (
             LOWER(TRIM(elem->>'orderId')) = LOWER(TRIM(o.order_id))
             OR (
               o.order_group_id IS NOT NULL
               AND LOWER(TRIM(elem->>'orderId')) = LOWER(TRIM(o.order_group_id))
             )
           )
       ) AS open_remaining
     FROM orders o
     WHERE o.id = $2`,
    [profileId, oid, pid]
  );
  const row = r.rows?.[0];
  if (!row) return 0;
  if (row.ever_linked || row.supplier_accepted) return Math.max(0, Number(row.order_qty) || 0);
  return Math.max(0, Number(row.open_remaining) || 0);
}

async function loadActiveSuppliers(profileId, { requireAutoOrdersEnabled = false } = {}) {
  const r = await query(
    `SELECT id, name, code, api_config
     FROM suppliers
     WHERE profile_id = $1
       AND COALESCE(is_active, true) = true`,
    [profileId]
  );
  const out = [];
  for (const row of r.rows || []) {
    const apiConfig = parseApiConfig(row.api_config);
    const auto = autoOrderSettingsFromApiConfig(apiConfig);
    if (requireAutoOrdersEnabled && !auto.autoOrdersEnabled) continue;
    out.push({
      id: Number(row.id),
      name: row.name,
      code: row.code,
      apiConfig,
      ...auto,
    });
  }
  return out;
}

async function loadAutoSuppliers(profileId) {
  return loadActiveSuppliers(profileId, { requireAutoOrdersEnabled: true });
}

async function pickSupplierForProduct(
  productId,
  autoSuppliers,
  qty = 1,
  { warehouseWeekendDays = null, now = new Date(), excludeSupplierIds = null } = {}
) {
  const exclude = new Set(
    (Array.isArray(excludeSupplierIds) ? excludeSupplierIds : [])
      .map((id) => Number(id))
      .filter((id) => Number.isFinite(id) && id > 0)
  );
  const ids = autoSuppliers
    .map((s) => Number(s.id))
    .filter((id) => Number.isFinite(id) && id > 0 && !exclude.has(id));
  if (!ids.length) return null;
  const need = Math.max(1, Math.floor(Number(qty) || 1));
  const r = await query(
    `SELECT ss.supplier_id, ss.price,
            GREATEST(0, COALESCE(ss.stock, 0) - ${sqlOpenSupplierReserved('ss.supplier_id', 'ss.product_id')})::int AS stock,
            COALESCE(ss.delivery_days, 0)::int AS delivery_days,
            COALESCE((s.api_config->>'isPriority')::boolean, (s.api_config->>'is_priority')::boolean, false) AS is_priority
     FROM supplier_stocks ss
     INNER JOIN suppliers s ON s.id = ss.supplier_id
     WHERE ss.product_id = $1
       AND ss.supplier_id = ANY($2::bigint[])
       AND ss.stock IS NOT NULL
       AND GREATEST(0, COALESCE(ss.stock, 0) - ${sqlOpenSupplierReserved('ss.supplier_id', 'ss.product_id')}) >= $3`,
    [productId, ids, need]
  );

  const supplierById = new Map(autoSuppliers.map((s) => [Number(s.id), s]));
  const reliabilityById = await loadSupplierReliabilityScores(
    (r.rows || []).map((row) => row.supplier_id)
  );
  const candidates = [];
  for (const row of r.rows || []) {
    const sid = Number(row.supplier_id);
    const base = supplierById.get(sid);
    if (!base || exclude.has(sid)) continue;
    candidates.push({
      ...base,
      price: row.price != null ? Number(row.price) : null,
      stock: row.stock != null ? Number(row.stock) : null,
      deliveryDays: Number(row.delivery_days) || 0,
      isPriority: Boolean(row.is_priority),
      reliability: reliabilityById.get(sid),
    });
  }
  if (!candidates.length) return null;
  const ranked = sortSupplierCandidatesByProcurementRules(candidates, {
    now,
    warehouseWeekendDays,
  });
  return ranked[0] || null;
}

/** Сопоставить product_id по offer_id / SKU (как ручная «В закупку» / «Отправить поставщику»). */
async function resolveOrderProductForAuto(row) {
  const raw = row?.product_id ?? row?.productId;
  const existing = raw != null && String(raw).trim() !== '' ? Number(raw) : null;
  if (Number.isFinite(existing) && existing > 0) {
    return { ...row, product_id: existing, productId: existing };
  }

  const orderRowForResolve = {
    id: row.id,
    marketplace: row.marketplace,
    offerId: row.offer_id,
    offer_id: row.offer_id,
    sku: row.marketplace_sku,
    marketplace_sku: row.marketplace_sku,
    productName: row.product_name,
    product_name: row.product_name,
    productId: row.product_id,
    product_id: row.product_id,
    quantity: row.quantity,
    status: row.status,
    profile_id: row.profile_id,
    profileId: row.profile_id,
  };

  const resolved = await ordersService._resolveProductIdForOrderStock(orderRowForResolve);
  const pid = resolved != null ? Number(resolved) : null;
  if (!Number.isFinite(pid) || pid < 1) return null;

  // Записать привязку в заказ, чтобы следующие прогоны и UI видели товар.
  const orderDbId = Number(row.id);
  if (Number.isFinite(orderDbId) && orderDbId > 0) {
    query(
      `UPDATE orders SET product_id = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND product_id IS NULL`,
      [pid, orderDbId]
    ).catch((e) => {
      logger.warn('[AutoProcurement] persist product_id failed', {
        orderId: row.order_id,
        productId: pid,
        message: e?.message || String(e),
      });
    });
  }

  return { ...row, product_id: pid, productId: pid };
}
async function expandDemandForOrderRow(row, autoSuppliers, pickOpts = {}) {
  const productId = Number(row.product_id);
  const qty = Math.max(1, parseInt(row.quantity, 10) || 1);
  if (!Number.isFinite(productId) || productId < 1) return [];

  const base = {
    orderDbId: Number(row.id),
    marketplace: row.marketplace,
    orderId: row.order_id,
    orderRow: row,
  };

  if (await isKitProductId(productId)) {
    const whole = await pickSupplierForProduct(productId, autoSuppliers, qty, pickOpts);
    if (whole) {
      return [{ ...base, productId, quantityNeeded: qty }];
    }
    const components = await getKitComponents(productId);
    if (components.length) {
      return components
        .map((c) => {
          const compId = Number(c.component_product_id);
          const perKit = Math.max(1, parseInt(c.quantity, 10) || 1);
          if (!Number.isFinite(compId) || compId < 1) return null;
          return { ...base, productId: compId, quantityNeeded: perKit * qty };
        })
        .filter(Boolean);
    }
  }

  return [{ ...base, productId, quantityNeeded: qty }];
}

/**
 * Для автозакупки учитываем только резерв со склада (on_hand).
 * Резерв «с входящего» не закрывает дефицит: иначе второй заказ на тот же SKU
 * «закрывается» ожиданием чужой поставки и не уходит поставщику.
 */
async function deficitQtyForDemandLine(line, profileId) {
  const metaMap = await queryOrderProductReserveMetaMap(line.productId, [line.orderDbId]);
  const meta = metaMap.get(Number(line.orderDbId)) || { fromOnHand: 0 };
  const reservedOnHand = Math.max(0, Math.floor(Number(meta.fromOnHand) || 0));
  const purchased = await purchasedQtyInOpenPurchases(profileId, line.orderDbId, line.productId);
  const coverage = computeProcurementDeficit({
    quantityNeeded: line.quantityNeeded,
    quantityReserved: reservedOnHand,
    quantityPurchased: purchased,
  });
  return coverage.deficit;
}

async function retryPendingAutoSubmits(profileId, autoSuppliers) {
  const ids = autoSuppliers.map((s) => s.id).filter((id) => Number.isFinite(id) && id > 0);
  if (!ids.length) return { checked: 0, submitted: 0 };

  const r = await query(
    `SELECT p.id, p.supplier_id
     FROM purchases p
     WHERE p.profile_id = $1
       AND p.status = 'open'
       AND p.supplier_id = ANY($2::bigint[])
     ORDER BY p.id ASC
     LIMIT 80`,
    [profileId, ids]
  );

  let submitted = 0;
  for (const row of r.rows || []) {
    const purchaseId = Number(row.id);
    const supplierId = Number(row.supplier_id);
    if (!Number.isFinite(purchaseId) || !Number.isFinite(supplierId)) continue;
    const pre = await supplierPreSubmitRequired(supplierId, profileId);
    if (!pre.required) continue;
    const out = await trySubmitPurchaseToSupplier({
      purchaseId,
      supplierId,
      profileId,
    }).catch((e) => ({
      submitted: false,
      reason: 'submit_error',
      message: e?.message || String(e),
    }));
    if (out?.submitted) {
      submitted += 1;
      logger.info('[AutoProcurement] retry submit ok', {
        profileId,
        purchaseId,
        supplierId,
      });
      // Позиции попали в закупку при неудачной отправке и остались в «Новых».
      const sentRefs = await query(
        `SELECT DISTINCT elem->>'marketplace' AS marketplace, elem->>'orderId' AS "orderId"
         FROM purchase_items pi
         CROSS JOIN LATERAL jsonb_array_elements(COALESCE(pi.source_orders, '[]'::jsonb)) AS elem
         WHERE pi.purchase_id = $1 AND elem ? 'supplierSubmittedAt'`,
        [purchaseId]
      );
      if (sentRefs.rows?.length) {
        await ordersService.bulkSetToProcurement(sentRefs.rows, profileId).catch((e) => {
          logger.warn('[AutoProcurement] retry submit: set in_procurement failed', {
            purchaseId,
            message: e?.message || String(e),
          });
        });
      }
    } else if (out?.reason && out.reason !== 'already_submitted' && !out?.skipped) {
      logger.warn('[AutoProcurement] retry submit failed', {
        profileId,
        purchaseId,
        supplierId,
        reason: out.reason,
        message: out.message,
      });
      try {
        const { addRuntimeNotification } = await import('../utils/runtime-notifications.js');
        await addRuntimeNotification({
          type: 'supplier_order_submit_failed',
          severity: 'error',
          source: 'auto_procurement',
          profileId,
          dedupeKey: `supplier_order_submit_failed|retry|${purchaseId}`,
          title: 'Заказы не отправлены поставщику',
          message: `${out.supplierName || 'Поставщик'}: ${
            out.message || 'ошибка повторной отправки'
          }. Закупка №${purchaseId} — заказы нужно проверить (статус «Новый» при новой автозакупке).`,
          meta: {
            url: '/orders?status=new',
            purchase_id: purchaseId,
            supplier_id: supplierId,
            reason: out.reason || null,
          },
        });
      } catch (_) {
        /* ignore */
      }
    }
  }
  return { checked: r.rows?.length || 0, submitted };
}

async function resolveDefaultOrgAndWarehouse(profileId) {
  const orgRes = await query(
    `SELECT id FROM organizations WHERE profile_id = $1 ORDER BY id ASC LIMIT 1`,
    [profileId]
  );
  const organizationId = orgRes.rows?.[0]?.id != null ? Number(orgRes.rows[0].id) : null;
  if (!organizationId) return { organizationId: null, warehouseId: null };

  const whRes = await query(
    `SELECT id FROM warehouses
     WHERE organization_id = $1
       AND type = 'warehouse'
       AND supplier_id IS NULL
     ORDER BY id ASC`,
    [organizationId]
  );
  const rows = whRes.rows || [];
  const warehouseId = rows.length === 1 ? Number(rows[0].id) : rows[0] ? Number(rows[0].id) : null;
  return { organizationId, warehouseId };
}

/** Склад заказа (как для резерва): warehouse_mappings по складу МП / склад ручного заказа. */
async function resolveOrderWarehouseId(orderRows, defaultWarehouseId) {
  for (const row of orderRows) {
    try {
      const mapped = await ordersService._resolveWarehouseIdForOrderReserve(row, row.product_id);
      if (mapped != null && Number(mapped) > 0) return Number(mapped);
    } catch (e) {
      logger.warn('[AutoProcurement] resolve order warehouse failed', {
        orderId: row?.order_id,
        message: e?.message || String(e),
      });
    }
  }
  return defaultWarehouseId;
}

async function resolveWarehouseOrganizationId(warehouseId, fallbackOrganizationId) {
  const wid = Number(warehouseId);
  if (!Number.isFinite(wid) || wid < 1) return fallbackOrganizationId;
  const r = await query(`SELECT organization_id FROM warehouses WHERE id = $1 LIMIT 1`, [wid]);
  const orgId = r.rows?.[0]?.organization_id != null ? Number(r.rows[0].organization_id) : null;
  return Number.isFinite(orgId) && orgId > 0 ? orgId : fallbackOrganizationId;
}

function groupKey(supplierId, arrivalBucket, warehouseId) {
  return `${supplierId}|${arrivalBucket}|${warehouseId}`;
}

async function loadOrderRowsForSupplierOrder(profileId, marketplace, orderId) {
  const dbMp = orderMarketplaceToDb(marketplace);
  const oid = String(orderId ?? '').trim();
  if (!dbMp || !oid) return [];

  const head = await query(
    `SELECT o.id, o.marketplace, o.order_id, o.order_group_id, o.product_id, o.quantity, o.status,
            o.profile_id, o.warehouse_id, o.delivery_address
     FROM orders o
     WHERE o.profile_id = $1
       AND o.marketplace = $2
       AND o.order_id = $3
     LIMIT 1`,
    [profileId, dbMp, oid]
  );
  const row = head.rows?.[0];
  if (!row) return [];

  const gid = row.order_group_id != null ? String(row.order_group_id).trim() : '';
  if (gid) {
    const group = await query(
      `SELECT o.id, o.marketplace, o.order_id, o.order_group_id, o.product_id, o.quantity, o.status,
              o.profile_id, o.warehouse_id, o.delivery_address
       FROM orders o
       WHERE o.profile_id = $1
         AND o.order_group_id = $2
       ORDER BY o.id ASC`,
      [profileId, gid]
    );
    return group.rows || [];
  }
  return [row];
}

async function estimateGroupTotal(client, supplierId, items) {
  let sum = 0;
  for (const it of items || []) {
    const pr = await client.query(
      `SELECT price, delivery_days FROM supplier_stocks WHERE supplier_id = $1 AND product_id = $2`,
      [supplierId, it.productId]
    );
    const price = pr.rows?.[0]?.price != null ? Number(pr.rows[0].price) : 0;
    if (price > 0) sum += price * it.quantity;
  }
  return sum;
}

async function maxDeliveryDaysForGroup(supplierId, items) {
  let maxDays = 0;
  for (const it of items || []) {
    const pr = await query(
      `SELECT COALESCE(delivery_days, 0)::int AS delivery_days
         FROM supplier_stocks WHERE supplier_id = $1 AND product_id = $2`,
      [supplierId, it.productId]
    );
    const d = Number(pr.rows?.[0]?.delivery_days) || 0;
    if (d > maxDays) maxDays = d;
  }
  return maxDays;
}

async function loadEarliestShipmentAtFromItems(profileId, items) {
  const pairs = [];
  const seen = new Set();
  for (const it of items || []) {
    for (const o of it.sourceOrders || []) {
      const mp = orderMarketplaceToDb(o?.marketplace);
      const oid = String(o?.orderId ?? o?.order_id ?? '').trim();
      if (!mp || !oid) continue;
      const key = `${mp}|${oid}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ marketplace: mp, orderId: oid });
    }
  }
  if (!pairs.length || profileId == null) return null;
  const marketplaces = pairs.map((p) => p.marketplace);
  const orderIds = pairs.map((p) => p.orderId);
  const r = await query(
    `SELECT MIN(o.shipment_date) AS earliest
       FROM orders o
      WHERE o.profile_id = $1
        AND o.shipment_date IS NOT NULL
        AND o.marketplace = ANY($2::text[])
        AND o.order_id = ANY($3::text[])`,
    [profileId, marketplaces, orderIds]
  );
  const raw = r.rows?.[0]?.earliest;
  if (!raw) return null;
  const d = raw instanceof Date ? raw : new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Ниже мин. суммы: копить или отправить сразу из‑за срока отгрузки на МП.
 * @returns {Promise<'ok'|'wait'|'bypass'>}
 */
async function resolveMinOrderGate(
  g,
  { now, warehouseWeekendDays, ignoreMinOrderAmount = false, profileId = null } = {}
) {
  if (ignoreMinOrderAmount || g?.minOrderAmount == null) return 'ok';
  const est = await transaction(async (client) =>
    estimateGroupTotal(client, g.supplierId, g.items)
  );
  if (est >= g.minOrderAmount) return 'ok';

  let earliest = g.earliestShipmentAt || null;
  if (!earliest && profileId != null) {
    earliest = await loadEarliestShipmentAtFromItems(profileId, g.items);
    if (earliest) g.earliestShipmentAt = earliest;
  }

  const supplierRow = g.supplierRow || null;
  const apiConfig = supplierRow?.apiConfig || g.apiConfig || {};
  const deliveryDays = await maxDeliveryDaysForGroup(g.supplierId, g.items);
  let plannedDeliveryYmd = null;
  try {
    const dates = computeProcurementDates(
      apiConfig,
      now,
      deliveryDays,
      warehouseWeekendDays,
      supplierRow?.code || g.supplierCode || null,
      g.supplierWarehouseName || null
    );
    plannedDeliveryYmd = dates?.plannedDeliveryDate || null;
  } catch {
    plannedDeliveryYmd = null;
  }

  const bypass = shouldBypassMinOrderAmount({
    shipmentDeadline: earliest,
    plannedDeliveryYmd,
    minSlackDays: 1,
  });
  if (bypass) {
    logger.info('[AutoProcurement] мин. сумма: срок отгрузки горит — отправляем без накопления', {
      supplierId: g.supplierId,
      est,
      min: g.minOrderAmount,
      plannedDeliveryYmd,
      shipmentAt: earliest || null,
    });
    return 'bypass';
  }
  return 'wait';
}

/**
 * Ниже мин. суммы, но срок ещё позволяет копить: тихо пробуем другого поставщика.
 * Отмену на МП не делаем.
 */
async function tryAlternateSupplierForMinOrder({
  items,
  excludeSupplierId,
  earliestShipmentAt,
  autoSuppliers,
  profileId,
  userId,
  organizationId,
  warehouseId,
  warehouseWeekendDays,
  now,
}) {
  const exclude = Number(excludeSupplierId);
  const demand = (Array.isArray(items) ? items : [])
    .map((it) => ({
      productId: Number(it.productId ?? it.product_id),
      quantity: Math.max(1, Math.floor(Number(it.quantity) || 1)),
      sourceOrders: Array.isArray(it.sourceOrders) ? it.sourceOrders : [],
    }))
    .filter((it) => Number.isFinite(it.productId) && it.productId > 0 && it.sourceOrders.length);
  if (!demand.length) return { purchased: 0, submitted: 0 };

  const pickOpts = {
    warehouseWeekendDays,
    now,
    excludeSupplierIds: Number.isFinite(exclude) && exclude > 0 ? [exclude] : [],
  };
  const groups = new Map();
  for (const it of demand) {
    const supplier = await pickSupplierForProduct(
      it.productId,
      autoSuppliers,
      it.quantity,
      pickOpts
    );
    if (!supplier) continue;
    const supplierRow = autoSuppliers.find((s) => Number(s.id) === Number(supplier.id)) || supplier;
    const supplierWarehouseName = await resolveSupplierWarehouseNameForMainWarehouse(
      warehouseId,
      supplier.id,
      { profileId }
    );
    const arrivalBucket = resolveProcurementArrivalBucketFromApiConfig(
      supplierRow.apiConfig,
      now,
      warehouseWeekendDays,
      supplierRow.code,
      supplierWarehouseName
    );
    const key = groupKey(supplier.id, arrivalBucket, warehouseId);
    if (!groups.has(key)) {
      groups.set(key, {
        supplierId: supplier.id,
        arrivalBucket,
        minOrderAmount: supplierRow.minOrderAmount,
        supplierRow,
        apiConfig: supplierRow.apiConfig,
        supplierCode: supplierRow.code,
        supplierWarehouseName,
        earliestShipmentAt: earliestShipmentAt || null,
        items: [],
        procurementItems: [],
        seenProc: new Set(),
      });
    }
    const g = groups.get(key);
    for (const o of it.sourceOrders) {
      const mp = o?.marketplace;
      const oid = o?.orderId ?? o?.order_id;
      const procKey = `${mp}|${oid}`;
      if (mp != null && oid != null && !g.seenProc.has(procKey)) {
        g.seenProc.add(procKey);
        g.procurementItems.push({ marketplace: mp, orderId: oid });
      }
    }
    const existing = g.items.find((x) => x.productId === it.productId);
    if (existing) {
      existing.quantity += it.quantity;
      existing.sourceOrders.push(...it.sourceOrders);
    } else {
      g.items.push({
        productId: it.productId,
        quantity: it.quantity,
        sourceOrders: [...it.sourceOrders],
      });
    }
  }

  let purchased = 0;
  let submitted = 0;
  for (const g of groups.values()) {
    if (!g.items.length) continue;
    const openId = await transaction(async (client) =>
      findOpenAutoPurchaseId(client, {
        profileId,
        supplierId: g.supplierId,
        arrivalBucket: g.arrivalBucket,
        warehouseId,
        now,
        warehouseWeekendDays,
      })
    );
    // Новый поставщик тоже ниже мин. и без открытой закупки — не трогаем (копим).
    if (!openId && g.minOrderAmount != null) {
      const gate = await resolveMinOrderGate(g, {
        now,
        warehouseWeekendDays,
        profileId,
      });
      if (gate === 'wait') continue;
    }
    try {
      const result = await procureGroupForSupplierOrder(g, {
        profileId,
        userId,
        organizationId,
        warehouseId,
        now,
        warehouseWeekendDays,
        submitToSupplier: true,
      });
      if (result?.ok && result?.purchaseId) purchased += 1;
      if (result?.supplierSubmit?.submitted) submitted += 1;
    } catch (e) {
      logger.warn('[AutoProcurement] alternate supplier after min-order skip failed', {
        supplierId: g.supplierId,
        message: e?.message || String(e),
      });
    }
  }
  return { purchased, submitted };
}

async function procureGroupForSupplierOrder(
  g,
  {
    profileId,
    userId,
    organizationId,
    warehouseId,
    manualTest = false,
    now = new Date(),
    warehouseWeekendDays = null,
    submitToSupplier = false,
    ignoreMinOrderAmount = false,
  }
) {
  if (!g?.items?.length) {
    return { ok: false, error: 'no_items', message: 'Нет позиций для закупки' };
  }

  let purchaseId = await transaction(async (client) =>
    findOpenAutoPurchaseId(client, {
      profileId,
      supplierId: g.supplierId,
      arrivalBucket: g.arrivalBucket,
      warehouseId,
      now,
      warehouseWeekendDays,
    })
  );

  if (!manualTest && !purchaseId && g.minOrderAmount != null) {
    const gate = await resolveMinOrderGate(g, {
      now,
      warehouseWeekendDays,
      ignoreMinOrderAmount,
      profileId,
    });
    if (gate === 'wait') {
      const est = await transaction(async (client) =>
        estimateGroupTotal(client, g.supplierId, g.items)
      );
      return {
        ok: false,
        error: 'below_min_order_amount',
        message: `Сумма заказа (${Math.round(est)} ₽) ниже минимальной для поставщика (${g.minOrderAmount} ₽)`,
        estimatedTotal: est,
        minOrderAmount: g.minOrderAmount,
      };
    }
  }

  const note = manualTest
    ? `${autoArrivalNoteText(g.arrivalBucket)} · тест «Заказать»`
    : autoArrivalNoteText(g.arrivalBucket);
  const payload = {
    procurementItems: g.procurementItems,
    items: g.items.map((it) => ({
      productId: it.productId,
      quantity: it.quantity,
      sourceOrders: it.sourceOrders,
    })),
    note,
  };

  if (purchaseId) {
    payload.existingPurchaseId = purchaseId;
  } else {
    payload.supplierId = g.supplierId;
    payload.organizationId = organizationId;
    payload.warehouseId = warehouseId;
  }

  const result = await purchasesService.procureFromOrders(payload, {
    userId,
    profileId,
    submitToSupplier: Boolean(submitToSupplier),
  });

  return {
    ok: true,
    purchaseId: result?.purchaseId ?? purchaseId ?? null,
    procurement: result?.procurement ?? null,
    supplierSubmit: result?.supplierSubmit ?? null,
    rolledBack: Boolean(result?.rolledBack),
    rollbackItems: Array.isArray(result?.rollbackItems) ? result.rollbackItems : null,
    appendedToExisting: Boolean(purchaseId),
    arrivalBucket: g.arrivalBucket,
  };
}

const MAX_SUPPLIER_FAILOVER_DEPTH = 5;

/**
 * После отказа поставщика: те же позиции у следующего по правилам выбора.
 * Если закрыть некем и заказ ещё «Новый» — отмена на МП и пуш остатка.
 */
async function failoverRejectedDemand({
  items,
  failedSupplierId,
  triedSupplierIds,
  autoSuppliers,
  profileId,
  userId,
  organizationId,
  warehouseId,
  warehouseWeekendDays,
  now,
  depth = 0,
}) {
  const demand = (Array.isArray(items) ? items : [])
    .map((it) => ({
      productId: Number(it.productId ?? it.product_id),
      quantity: Math.max(1, Math.floor(Number(it.quantity) || 1)),
      sourceOrders: Array.isArray(it.sourceOrders) ? it.sourceOrders : [],
    }))
    .filter((it) => Number.isFinite(it.productId) && it.productId > 0 && it.sourceOrders.length);

  if (!demand.length) {
    return { purchased: 0, submitted: 0, cancelled: 0, unresolved: 0 };
  }

  const tried = new Set(
    [...(triedSupplierIds || [])]
      .map((id) => Number(id))
      .filter((id) => Number.isFinite(id) && id > 0)
  );
  const failedId = Number(failedSupplierId);
  if (Number.isFinite(failedId) && failedId > 0) tried.add(failedId);

  if (depth >= MAX_SUPPLIER_FAILOVER_DEPTH) {
    const cancelled = await cancelUnfulfillableMarketplaceOrders({
      items: demand,
      profileId,
      reason: 'Исчерпаны попытки смены поставщика после отказа',
    });
    return { purchased: 0, submitted: 0, cancelled, unresolved: demand.length };
  }

  const pickOpts = { warehouseWeekendDays, now, excludeSupplierIds: [...tried] };
  const groups = new Map();
  const noNext = [];

  for (const it of demand) {
    const supplier = await pickSupplierForProduct(
      it.productId,
      autoSuppliers,
      it.quantity,
      pickOpts
    );
    if (!supplier) {
      noNext.push(it);
      continue;
    }
    const supplierRow = autoSuppliers.find((s) => Number(s.id) === Number(supplier.id)) || supplier;
    const supplierWarehouseName = await resolveSupplierWarehouseNameForMainWarehouse(
      warehouseId,
      supplier.id,
      { profileId }
    );
    const arrivalBucket = resolveProcurementArrivalBucketFromApiConfig(
      supplierRow.apiConfig,
      now,
      warehouseWeekendDays,
      supplierRow.code,
      supplierWarehouseName
    );
    const key = groupKey(supplier.id, arrivalBucket, warehouseId);
    if (!groups.has(key)) {
      groups.set(key, {
        supplierId: supplier.id,
        arrivalBucket,
        minOrderAmount: supplierRow.minOrderAmount,
        supplierRow,
        apiConfig: supplierRow.apiConfig,
        supplierCode: supplierRow.code,
        supplierWarehouseName,
        earliestShipmentAt: null,
        items: [],
        procurementItems: [],
        seenProc: new Set(),
      });
    }
    const g = groups.get(key);
    for (const o of it.sourceOrders) {
      const mp = o?.marketplace;
      const oid = o?.orderId ?? o?.order_id;
      const procKey = `${mp}|${oid}`;
      if (mp != null && oid != null && !g.seenProc.has(procKey)) {
        g.seenProc.add(procKey);
        g.procurementItems.push({ marketplace: mp, orderId: oid });
      }
      const shipRaw = o?.shipmentDate ?? o?.shipment_date;
      if (shipRaw) {
        const shipAt = shipRaw instanceof Date ? shipRaw : new Date(shipRaw);
        if (!Number.isNaN(shipAt.getTime())) {
          if (!g.earliestShipmentAt || shipAt < g.earliestShipmentAt) {
            g.earliestShipmentAt = shipAt;
          }
        }
      }
    }
    const existing = g.items.find((x) => x.productId === it.productId);
    if (existing) {
      existing.quantity += it.quantity;
      existing.sourceOrders.push(...it.sourceOrders);
    } else {
      g.items.push({
        productId: it.productId,
        quantity: it.quantity,
        sourceOrders: [...it.sourceOrders],
      });
    }
  }

  let purchased = 0;
  let submitted = 0;
  let cancelled = 0;
  /** Только позиции, которые закрыть некем — их можно отменять на МП. */
  const cancelCandidates = [...noNext];

  for (const g of groups.values()) {
    if (!g.items.length) continue;
    try {
      const result = await procureGroupForSupplierOrder(g, {
        profileId,
        userId,
        organizationId,
        warehouseId,
        now,
        warehouseWeekendDays,
        submitToSupplier: true,
      });
      if (!result?.ok) {
        if (result?.error === 'below_min_order_amount') {
          logger.info('[AutoProcurement] failover: ниже мин. суммы, ждём накопления', {
            profileId,
            supplierId: g.supplierId,
            min: result.minOrderAmount,
          });
          // Не отменяем — накопление или другой поставщик на следующем прогоне.
        } else {
          cancelCandidates.push(...g.items);
        }
        continue;
      }
      if (result?.purchaseId) purchased += 1;
      if (result?.supplierSubmit?.submitted) submitted += 1;

      const submit = result?.supplierSubmit;
      if (
        result?.rolledBack ||
        shouldFailoverAfterSupplierSubmit(submit, { apiSubmitRequired: true })
      ) {
        const retryItems =
          Array.isArray(result?.rollbackItems) && result.rollbackItems.length
            ? result.rollbackItems
            : rollbackDemandItemsForFailover(g.items, submit);
        if (retryItems.length) {
          logger.info('[AutoProcurement] failover → следующий поставщик', {
            profileId,
            failedSupplierId: g.supplierId,
            items: retryItems.length,
            depth,
          });
          const nested = await failoverRejectedDemand({
            items: retryItems,
            failedSupplierId: g.supplierId,
            triedSupplierIds: tried,
            autoSuppliers,
            profileId,
            userId,
            organizationId,
            warehouseId,
            warehouseWeekendDays,
            now,
            depth: depth + 1,
          });
          purchased += nested.purchased || 0;
          submitted += nested.submitted || 0;
          cancelled += nested.cancelled || 0;
        }
      }
    } catch (e) {
      logger.warn('[AutoProcurement] failover procure failed', {
        profileId,
        supplierId: g.supplierId,
        message: e?.message || String(e),
      });
      cancelCandidates.push(...g.items);
    }
  }

  if (cancelCandidates.length) {
    cancelled += await cancelUnfulfillableMarketplaceOrders({
      items: cancelCandidates,
      profileId,
      reason: 'Нет другого поставщика со свободным остатком после отказа',
    });
  }

  return {
    purchased,
    submitted,
    cancelled,
    unresolved: cancelCandidates.length,
  };
}

async function cancelUnfulfillableMarketplaceOrders({ items, profileId, reason }) {
  const refs = unfulfillableOrderRefs(items);
  if (!refs.length) return 0;

  const productIds = [
    ...new Set(
      (items || [])
        .map((it) => Number(it.productId ?? it.product_id))
        .filter((id) => Number.isFinite(id) && id > 0)
    ),
  ];

  let cancelled = 0;
  const cancelledRefs = [];

  for (const ref of refs) {
    try {
      const rows = await query(
        `SELECT id, status, marketplace, order_id
           FROM orders
          WHERE profile_id = $1
            AND marketplace = $2
            AND order_id = $3
          LIMIT 1`,
        [profileId, ref.marketplace, ref.orderId]
      );
      const row = rows.rows?.[0];
      if (!row) continue;
      const st = String(row.status || '').toLowerCase();
      if (['cancelled', 'canceled', 'delivered', 'shipped', 'in_transit'].includes(st)) {
        continue;
      }
      // Уже в закупке / на сборке — часть позиций могла уйти другому поставщику; не трогаем.
      if (['in_procurement', 'in_assembly', 'wb_assembly', 'assembled'].includes(st)) {
        continue;
      }

      await ordersService.cancelOrderOnMarketplace(ref.marketplace, ref.orderId);
      cancelled += 1;
      cancelledRefs.push(ref);
      logger.info('[AutoProcurement] заказ отменён: закрыть поставщиком некем', {
        profileId,
        marketplace: ref.marketplace,
        orderId: ref.orderId,
        reason,
      });
    } catch (e) {
      logger.warn('[AutoProcurement] не удалось отменить заказ на МП', {
        profileId,
        marketplace: ref.marketplace,
        orderId: ref.orderId,
        message: e?.message || String(e),
      });
    }
  }

  if (productIds.length) {
    import('./marketplaceWarehouseStockSync.service.js')
      .then(({ scheduleWarehouseStockMarketplaceSync }) => {
        for (const id of productIds) {
          scheduleWarehouseStockMarketplaceSync(id, { source: 'supplier_failover_unfulfillable' });
        }
      })
      .catch(() => {});
  }

  if (cancelledRefs.length) {
    const label = cancelledRefs.map((r) => r.orderId).join(', ');
    try {
      await addRuntimeNotification({
        type: 'supplier_order_unfulfillable_cancelled',
        severity: 'error',
        source: 'auto_procurement',
        profileId,
        dedupeKey: `supplier_unfulfillable|${profileId}|${cancelledRefs
          .map((r) => orderRefKey(r.marketplace, r.orderId))
          .sort()
          .join(',')}`,
        title: 'Заказы отменены: поставщик не принял, замены нет',
        message: `${reason}. Отменены на маркетплейсе: ${label}. Остаток на витрине обновлён.`,
        meta: {
          url: '/orders?status=cancelled',
          order_ids: cancelledRefs.map((r) => r.orderId),
          product_ids: productIds,
          reason,
        },
      });
    } catch (_) {
      /* ignore */
    }
  }

  return cancelled;
}

class AutoProcurementService {
  /**
   * Прогон автозакупки для одного профиля: дефицит → открытая закупка → API поставщика.
   * @returns {Promise<{ groups: number, purchases: number, items: number, skipped: number, submitted: number }>}
   */
  async runForProfile(profileId, { userId = null, now = new Date() } = {}) {
    const pid = normalizeProfileId(profileId);
    if (pid == null) {
      return { groups: 0, purchases: 0, items: 0, skipped: 0, submitted: 0, error: 'no_profile' };
    }
    if (!repositoryFactory.isUsingPostgreSQL()) {
      return { groups: 0, purchases: 0, items: 0, skipped: 0, submitted: 0, error: 'not_pg' };
    }

    const profilesRepo = repositoryFactory.getProfilesRepository?.();
    const profileRow =
      profilesRepo && typeof profilesRepo.findById === 'function'
        ? await profilesRepo.findById(pid)
        : null;
    if (!isProfileSupplierSyncEnabled(profileRow)) {
      return {
        groups: 0,
        purchases: 0,
        items: 0,
        skipped: 0,
        submitted: 0,
        error: 'supplier_sync_disabled',
      };
    }

    const autoSuppliers = await loadAutoSuppliers(pid);
    if (!autoSuppliers.length) {
      return { groups: 0, purchases: 0, items: 0, skipped: 0, submitted: 0, suppliers: 0 };
    }

    const { organizationId: defaultOrganizationId, warehouseId: defaultWarehouseId } =
      await resolveDefaultOrgAndWarehouse(pid);
    if (!defaultOrganizationId || !defaultWarehouseId) {
      logger.warn('[AutoProcurement] skip profile: no org/warehouse', { profileId: pid });
      return { groups: 0, purchases: 0, items: 0, skipped: 0, submitted: 0, error: 'no_org_warehouse' };
    }

    const warehouseCtxById = new Map();
    const loadWarehouseCtx = async (warehouseId) => {
      if (!warehouseCtxById.has(warehouseId)) {
        warehouseCtxById.set(warehouseId, {
          warehouseId,
          organizationId: await resolveWarehouseOrganizationId(warehouseId, defaultOrganizationId),
          warehouseWeekendDays: await loadWarehouseWeekendDays(warehouseId, pid),
        });
      }
      return warehouseCtxById.get(warehouseId);
    };

    const ordersRes = await query(
      `SELECT o.id, o.marketplace, o.order_id, o.order_group_id, o.product_id, o.quantity, o.status,
              o.offer_id, o.marketplace_sku, o.product_name, o.profile_id, o.warehouse_id,
              o.delivery_address, o.shipment_date
       FROM orders o
       WHERE o.profile_id = $1
         AND (
           o.product_id IS NOT NULL
           OR NULLIF(BTRIM(COALESCE(o.offer_id::text, '')), '') IS NOT NULL
           OR NULLIF(BTRIM(COALESCE(o.marketplace_sku::text, '')), '') IS NOT NULL
         )
         AND ${ELIGIBLE_STATUS_SQL}
       ORDER BY o.created_at ASC NULLS LAST, o.id ASC
       LIMIT 300`,
      [pid]
    );

    const groups = new Map();
    let skipped = 0;

    for (const row of ordersRes.rows || []) {
      const resolvedRow = await resolveOrderProductForAuto(row);
      if (!resolvedRow) {
        skipped += 1;
        continue;
      }
      const productId = Number(resolvedRow.product_id);
      if (!Number.isFinite(productId) || productId < 1) {
        skipped += 1;
        continue;
      }
      const mp = resolvedRow.marketplace;
      const orderId = resolvedRow.order_id;

      const already = await transaction(async (client) =>
        orderAlreadyInOpenPurchase(client, pid, mp, orderId, resolvedRow.order_group_id)
      );
      if (already) {
        skipped += 1;
        continue;
      }

      try {
        await ordersService._applyReserveForOrderIfAbsent(resolvedRow);
      } catch (e) {
        logger.warn('[AutoProcurement] reserve failed', {
          orderId,
          message: e?.message || String(e),
        });
      }

      const orderWarehouseId = await resolveOrderWarehouseId([resolvedRow], defaultWarehouseId);
      const whCtx = await loadWarehouseCtx(orderWarehouseId);
      const pickOpts = { warehouseWeekendDays: whCtx.warehouseWeekendDays, now };

      const demandLines = await expandDemandForOrderRow(resolvedRow, autoSuppliers, pickOpts);
      if (!demandLines.length) {
        skipped += 1;
        continue;
      }

      let anyAdded = false;
      for (const line of demandLines) {
        const deficit = await deficitQtyForDemandLine(line, pid);
        if (deficit <= 0) continue;

        const supplier = await pickSupplierForProduct(
          line.productId,
          autoSuppliers,
          deficit,
          pickOpts
        );
        if (!supplier) {
          skipped += 1;
          continue;
        }

        const supplierWarehouseName = await resolveSupplierWarehouseNameForMainWarehouse(
          whCtx.warehouseId,
          supplier.id,
          { profileId: pid }
        );
        const arrivalBucket = resolveProcurementArrivalBucketFromApiConfig(
          supplier.apiConfig,
          now,
          whCtx.warehouseWeekendDays,
          supplier.code,
          supplierWarehouseName
        );
        const key = groupKey(supplier.id, arrivalBucket, whCtx.warehouseId);
        if (!groups.has(key)) {
          groups.set(key, {
            supplierId: supplier.id,
            arrivalBucket,
            warehouseId: whCtx.warehouseId,
            organizationId: whCtx.organizationId,
            warehouseWeekendDays: whCtx.warehouseWeekendDays,
            minOrderAmount: supplier.minOrderAmount,
            supplierRow: supplier,
            apiConfig: supplier.apiConfig,
            supplierCode: supplier.code,
            supplierWarehouseName,
            earliestShipmentAt: null,
            items: [],
            procurementItems: [],
            seenProc: new Set(),
          });
        }
        const g = groups.get(key);
        const shipRaw = resolvedRow.shipment_date ?? resolvedRow.shipmentDate;
        if (shipRaw) {
          const shipAt = shipRaw instanceof Date ? shipRaw : new Date(shipRaw);
          if (!Number.isNaN(shipAt.getTime())) {
            if (!g.earliestShipmentAt || shipAt < g.earliestShipmentAt) {
              g.earliestShipmentAt = shipAt;
            }
          }
        }
        const procKey = `${mp}|${orderId}`;
        if (!g.seenProc.has(procKey)) {
          g.seenProc.add(procKey);
          g.procurementItems.push({ marketplace: mp, orderId });
        }
        const existing = g.items.find((it) => it.productId === line.productId);
        if (existing) {
          existing.quantity += deficit;
          existing.sourceOrders.push({ marketplace: mp, orderId, quantity: deficit });
        } else {
          g.items.push({
            productId: line.productId,
            quantity: deficit,
            sourceOrders: [{ marketplace: mp, orderId, quantity: deficit }],
          });
        }
        anyAdded = true;
      }
      if (!anyAdded) skipped += 1;
    }

    let purchasesTouched = 0;
    let itemsAdded = 0;
    let submitted = 0;

    for (const g of groups.values()) {
      if (!g.items.length) continue;

      let purchaseId = await transaction(async (client) =>
        findOpenAutoPurchaseId(client, {
          profileId: pid,
          supplierId: g.supplierId,
          arrivalBucket: g.arrivalBucket,
          warehouseId: g.warehouseId,
          now,
          warehouseWeekendDays: g.warehouseWeekendDays,
        })
      );

      if (!purchaseId && g.minOrderAmount != null) {
        const gate = await resolveMinOrderGate(g, {
          now,
          warehouseWeekendDays: g.warehouseWeekendDays,
          profileId: pid,
        });
        if (gate === 'wait') {
          const est = await transaction(async (client) =>
            estimateGroupTotal(client, g.supplierId, g.items)
          );
          logger.info('[AutoProcurement] skip new purchase: below minOrderAmount', {
            supplierId: g.supplierId,
            bucket: g.arrivalBucket,
            est,
            min: g.minOrderAmount,
          });
          // Срок ещё позволяет копить — без отмены на МП пробуем другого поставщика
          // (без мин. суммы или с уже открытой закупкой).
          const alt = await tryAlternateSupplierForMinOrder({
            items: g.items,
            excludeSupplierId: g.supplierId,
            earliestShipmentAt: g.earliestShipmentAt,
            autoSuppliers,
            profileId: pid,
            userId,
            organizationId: g.organizationId,
            warehouseId: g.warehouseId,
            warehouseWeekendDays: g.warehouseWeekendDays,
            now,
          });
          if (alt.purchased || alt.submitted) {
            purchasesTouched += alt.purchased || 0;
            submitted += alt.submitted || 0;
          } else {
            skipped += g.items.length;
          }
          continue;
        }
        // gate === 'bypass' | 'ok' — создаём закупку даже ниже мин. суммы
      }

      const note = autoArrivalNoteText(g.arrivalBucket);
      const payload = {
        procurementItems: g.procurementItems,
        items: g.items.map((it) => ({
          productId: it.productId,
          quantity: it.quantity,
          sourceOrders: it.sourceOrders,
        })),
        note,
      };

      if (purchaseId) {
        payload.existingPurchaseId = purchaseId;
      } else {
        payload.supplierId = g.supplierId;
        payload.organizationId = g.organizationId;
        payload.warehouseId = g.warehouseId;
      }

      try {
        const result = await purchasesService.procureFromOrders(payload, {
          userId,
          profileId: pid,
          submitToSupplier: true,
        });
        if (result?.purchaseId) purchasesTouched += 1;
        itemsAdded += g.items.length;
        if (result?.supplierSubmit?.submitted) submitted += 1;
        else if (
          result?.supplierSubmit &&
          !result.supplierSubmit.skipped &&
          result.supplierSubmit.reason !== 'already_submitted'
        ) {
          logger.warn('[AutoProcurement] supplier submit not completed', {
            profileId: pid,
            supplierId: g.supplierId,
            purchaseId: result?.purchaseId,
            reason: result.supplierSubmit.reason,
            message: result.supplierSubmit.message,
            rolledBack: Boolean(result?.rolledBack),
          });
        }

        const submit = result?.supplierSubmit;
        if (
          result?.rolledBack ||
          shouldFailoverAfterSupplierSubmit(submit, { apiSubmitRequired: true })
        ) {
          const retryItems =
            Array.isArray(result?.rollbackItems) && result.rollbackItems.length
              ? result.rollbackItems
              : rollbackDemandItemsForFailover(g.items, submit);
          if (retryItems.length) {
            const failover = await failoverRejectedDemand({
              items: retryItems,
              failedSupplierId: g.supplierId,
              triedSupplierIds: [g.supplierId],
              autoSuppliers,
              profileId: pid,
              userId,
              organizationId: g.organizationId,
              warehouseId: g.warehouseId,
              warehouseWeekendDays: g.warehouseWeekendDays,
              now,
            });
            purchasesTouched += failover.purchased || 0;
            submitted += failover.submitted || 0;
            if (failover.cancelled) {
              logger.info('[AutoProcurement] failover: отменены заказы без поставщика', {
                profileId: pid,
                cancelled: failover.cancelled,
              });
            }
          }
        }
      } catch (e) {
        const msg = e?.message || String(e);
        logger.warn('[AutoProcurement] procure failed', {
          profileId: pid,
          supplierId: g.supplierId,
          bucket: g.arrivalBucket,
          message: msg,
        });
        // Нет свободного остатка / ошибка создания — сразу другой поставщик, не ждём следующий cron.
        const noStock =
          e?.statusCode === 409 ||
          /не осталось свободного остатка/i.test(msg);
        if (noStock && g.items.length) {
          const failover = await failoverRejectedDemand({
            items: g.items,
            failedSupplierId: g.supplierId,
            triedSupplierIds: [g.supplierId],
            autoSuppliers,
            profileId: pid,
            userId,
            organizationId: g.organizationId,
            warehouseId: g.warehouseId,
            warehouseWeekendDays: g.warehouseWeekendDays,
            now,
          });
          purchasesTouched += failover.purchased || 0;
          submitted += failover.submitted || 0;
          if (!(failover.purchased || failover.submitted || failover.cancelled)) {
            skipped += g.items.length;
          }
        } else {
          skipped += g.items.length;
        }
      }
    }

    const retry = await retryPendingAutoSubmits(pid, autoSuppliers);
    submitted += retry.submitted || 0;

    return {
      groups: groups.size,
      purchases: purchasesTouched,
      items: itemsAdded,
      skipped,
      submitted,
      suppliers: autoSuppliers.length,
      retryChecked: retry.checked,
    };
  }

  /**
   * Ручной тест: один заказ (или группа WB) → открытая закупка у поставщика.
   * @returns {Promise<object>}
   */
  async runForMarketplaceOrder(
    marketplace,
    orderId,
    { profileId, userId = null, now = new Date(), manualTest = true } = {}
  ) {
    const pid = normalizeProfileId(profileId);
    if (pid == null) {
      return { ok: false, error: 'no_profile', message: 'Профиль не определён' };
    }
    if (!repositoryFactory.isUsingPostgreSQL()) {
      return { ok: false, error: 'not_pg', message: 'Доступно только с PostgreSQL' };
    }

    const suppliers = await loadActiveSuppliers(pid, {
      requireAutoOrdersEnabled: !manualTest,
    });
    if (!suppliers.length) {
      return {
        ok: false,
        error: 'no_suppliers',
        message: manualTest
          ? 'Нет активных поставщиков в аккаунте'
          : 'Нет поставщиков с включённым автозаказом',
      };
    }

    const { organizationId: defaultOrganizationId, warehouseId: defaultWarehouseId } =
      await resolveDefaultOrgAndWarehouse(pid);
    if (!defaultOrganizationId || !defaultWarehouseId) {
      return {
        ok: false,
        error: 'no_org_warehouse',
        message: 'Укажите организацию и склад (хотя бы по одному на аккаунт)',
      };
    }

    const orderRows = await loadOrderRowsForSupplierOrder(pid, marketplace, orderId);
    if (!orderRows.length) {
      return { ok: false, error: 'order_not_found', message: 'Заказ не найден' };
    }

    const warehouseId = await resolveOrderWarehouseId(orderRows, defaultWarehouseId);
    const organizationId = await resolveWarehouseOrganizationId(warehouseId, defaultOrganizationId);
    const warehouseWeekendDays = await loadWarehouseWeekendDays(warehouseId, pid);
    const pickOpts = { warehouseWeekendDays, now };

    const ineligible = orderRows.filter((row) => {
      const st = String(row.status ?? '').trim().toLowerCase();
      const mp = String(row.marketplace ?? '').toLowerCase();
      if (st === 'in_procurement') return false;
      if (['new', 'in_assembly', 'wb_assembly'].includes(st)) return false;
      if (mp === 'wb' && (row.status === '__wb_status_pending__' || st === 'wb_status_unknown')) {
        return false;
      }
      return true;
    });
    if (ineligible.length === orderRows.length) {
      return {
        ok: false,
        error: 'ineligible_status',
        message:
          'Заказать у поставщика можно для «Новый», «На сборке», «В закупке» или у WB — пока статус не получен',
        status: orderRows[0]?.status ?? null,
      };
    }

    let supplier = null;
    let supplierRow = null;
    const items = [];
    const procurementItems = [];
    const seenProc = new Set();
    let skippedAlreadyInPurchase = 0;
    let skippedNoProduct = 0;
    let skippedNoSupplierStock = 0;

    await transaction(async (client) => {
      for (const row of orderRows) {
        const productId = Number(row.product_id);
        if (!Number.isFinite(productId) || productId < 1) {
          skippedNoProduct += 1;
          continue;
        }
        const mp = row.marketplace;
        const oid = row.order_id;
        if (await orderAlreadyInOpenPurchase(client, pid, mp, oid, row.order_group_id)) {
          skippedAlreadyInPurchase += 1;
          continue;
        }

        const qty = Math.max(1, parseInt(row.quantity, 10) || 1);

        const picked = await pickSupplierForProduct(productId, suppliers, qty, pickOpts);
        if (!picked) {
          skippedNoSupplierStock += 1;
          continue;
        }
        if (!supplier) {
          supplier = picked;
          supplierRow = suppliers.find((s) => s.id === picked.id) || picked;
        } else if (picked.id !== supplier.id) {
          skippedNoSupplierStock += 1;
          continue;
        }

        const procKey = `${mp}|${oid}`;
        if (!seenProc.has(procKey)) {
          seenProc.add(procKey);
          procurementItems.push({ marketplace: mp, orderId: oid });
        }
        const existing = items.find((it) => it.productId === productId);
        if (existing) {
          existing.quantity += qty;
          existing.sourceOrders.push({ marketplace: mp, orderId: oid, quantity: qty });
        } else {
          items.push({
            productId,
            quantity: qty,
            sourceOrders: [{ marketplace: mp, orderId: oid, quantity: qty }],
          });
        }
      }
    });

    if (!supplier || !items.length) {
      if (skippedAlreadyInPurchase > 0 && skippedNoSupplierStock === 0 && skippedNoProduct === 0) {
        return {
          ok: false,
          error: 'already_in_purchase',
          message: 'Заказ уже добавлен в открытую закупку',
        };
      }
      return {
        ok: false,
        error: 'no_supplier_stock',
        message:
          skippedNoSupplierStock > 0
            ? 'Нет остатка у поставщиков по товарам заказа (обновите остатки поставщиков)'
            : 'Не удалось собрать позиции для закупки',
        skippedAlreadyInPurchase,
        skippedNoProduct,
        skippedNoSupplierStock,
      };
    }

    const arrivalBucket = resolveProcurementArrivalBucketFromApiConfig(
      supplierRow.apiConfig,
      now,
      warehouseWeekendDays,
      supplierRow.code
    );
    const procResult = await procureGroupForSupplierOrder(
      {
        supplierId: supplier.id,
        arrivalBucket,
        minOrderAmount: supplierRow.minOrderAmount,
        items,
        procurementItems,
      },
      { profileId: pid, userId, organizationId, warehouseId, manualTest, now, warehouseWeekendDays }
    );

    if (!procResult.ok) return { ok: false, ...procResult };

    return {
      ok: true,
      purchaseId: procResult.purchaseId,
      supplierId: supplier.id,
      supplierName: supplierRow.name || null,
      supplierCode: supplierRow.code || null,
      arrivalBucket: procResult.arrivalBucket,
      procurement: procResult.procurement,
      appendedToExisting: procResult.appendedToExisting,
      itemsCount: items.length,
      skippedAlreadyInPurchase,
    };
  }

  async runForAllProfiles({ userId = null } = {}) {
    if (_runInProgress) {
      return { profiles: 0, results: [], skipped: true, reason: 'in_progress' };
    }
    _runInProgress = true;
    try {
      return await this._runForAllProfilesInner({ userId });
    } finally {
      _runInProgress = false;
    }
  }

  /**
   * Поставить автозакупку+отправку поставщику в очередь планировщика сразу
   * (после синка заказов / по крону). coalesce — не копить дубликаты.
   */
  scheduleImmediateRun({ reason = 'manual' } = {}) {
    return runSchedulerDbJob(
      'auto-procurement',
      async () => {
        const out = await this.runForAllProfiles();
        if (out?.skipped && out.reason === 'in_progress') {
          logger.info('[AutoProcurement] scheduleImmediateRun: already in progress', { reason });
          return out;
        }
        const purchased = (out.results || []).reduce((s, r) => s + (r.purchases || 0), 0);
        const submitted = (out.results || []).reduce((s, r) => s + (r.submitted || 0), 0);
        if (purchased > 0 || submitted > 0) {
          logger.info(
            `[AutoProcurement] immediate(${reason}): profiles=${out.profiles || 0} purchases=${purchased} submitted=${submitted}`
          );
        }
        return out;
      },
      { coalesce: true, priority: true }
    ).catch((e) => {
      logger.warn('[AutoProcurement] scheduleImmediateRun failed', {
        reason,
        message: e?.message || String(e),
      });
      return { error: e?.message || String(e) };
    });
  }

  async _runForAllProfilesInner({ userId = null } = {}) {
    if (!repositoryFactory.isUsingPostgreSQL()) {
      return { profiles: 0, results: [] };
    }
    const rows = await repositoryFactory.getProfilesRepository().findAll();
    const profiles = rows?.length ? rows : [];
    const results = [];
    for (const p of profiles) {
      const id = p?.id ?? null;
      if (id == null) continue;
      try {
        const out = await this.runForProfile(id, { userId });
        results.push({ profileId: id, ...out });
      } catch (e) {
        logger.warn('[AutoProcurement] profile failed', { profileId: id, message: e?.message || String(e) });
        results.push({ profileId: id, error: e?.message || String(e) });
      }
    }
    return { profiles: results.length, results };
  }
}

export default new AutoProcurementService();
