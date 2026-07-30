/**
 * Планировщик закупок по заказу: резерв со склада → закупка в ERM → резерв под заказ.
 */

import { query, transaction } from '../config/database.js';
import repositoryFactory from '../config/repository-factory.js';
import ordersService from './orders.service.js';
import purchasesService from './purchases.service.js';
import logger from '../utils/logger.js';
import { addRuntimeNotification } from '../utils/runtime-notifications.js';
import { isProfileSupplierSyncEnabled } from '../utils/profileSupplierSync.js';
import { isProfileProductSupplierBindingEnabled } from '../utils/profileProductSupplierBinding.js';
import { autoOrderSettingsFromApiConfig } from '../utils/supplierAutoOrderSettings.js';
import {
  autoArrivalNoteText,
  computeProcurementDates,
  resolveProcurementArrivalBucketFromApiConfig,
} from '../utils/supplierProcurementArrival.js';
import { sortSupplierCandidatesByProcurementRules } from '../utils/supplierCandidateSort.js';
import { loadWarehouseWeekendDays } from '../utils/warehouseProcurementCalendar.js';
import {
  computeProcurementDeficit,
  fulfillmentLineStatusFromQuantities,
} from '../utils/orderProcurementCoverage.js';
import {
  buildOrderSupplierSubmitScope,
  marketplaceVariantsForLookup,
  orderIdsForPurchaseLookup,
  orderMarketplaceToDb,
} from '../utils/orderPurchaseLookup.js';
import { findOpenAutoPurchaseId } from '../utils/openPurchaseLookup.js';
import { isKitProductId, getKitComponents } from './kitStock.service.js';
import { canonicalSupplierApiCode } from '../repositories/suppliers.repository.pg.js';
import { resolveSupplierOrderAdapter } from './supplierOrderAdapters/index.js';
import {
  supplierPreSubmitRequired,
  trySubmitPurchaseToSupplier,
} from './supplierOrderPlacement.service.js';

function supplierSupportsApiOrder(supplier) {
  const code = canonicalSupplierApiCode(supplier?.code);
  return Boolean(resolveSupplierOrderAdapter(code));
}
function normalizeProfileId(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'string' ? parseInt(v, 10) : Number(v);
  return Number.isNaN(n) ? null : n;
}

function parseApiConfig(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

const ELIGIBLE_STATUS = new Set([
  'new',
  'in_assembly',
  'wb_assembly',
  'in_procurement',
  '__wb_status_pending__',
  'wb_status_unknown',
]);

function isEligibleOrderRow(row) {
  const st = String(row.status ?? '').trim().toLowerCase();
  if (ELIGIBLE_STATUS.has(st) || row.status === '__wb_status_pending__') return true;
  return false;
}

async function loadOrderRows(profileId, marketplace, orderId) {
  const dbMp = orderMarketplaceToDb(marketplace);
  const oid = String(orderId ?? '').trim();
  if (!dbMp || !oid) return [];

  const head = await query(
    `SELECT o.id, o.marketplace, o.order_id, o.order_group_id, o.product_id, o.quantity, o.status,
            o.profile_id, o.offer_id, o.marketplace_sku, o.product_name
     FROM orders o
     WHERE o.profile_id = $1 AND o.marketplace = $2 AND o.order_id = $3
     LIMIT 1`,
    [profileId, dbMp, oid]
  );
  const row = head.rows?.[0];
  if (!row) return [];

  const gid = row.order_group_id != null ? String(row.order_group_id).trim() : '';
  if (gid) {
    const group = await query(
      `SELECT o.id, o.marketplace, o.order_id, o.order_group_id, o.product_id, o.quantity, o.status,
              o.profile_id, o.offer_id, o.marketplace_sku, o.product_name
       FROM orders o
       WHERE o.profile_id = $1 AND o.order_group_id = $2
       ORDER BY o.id ASC`,
      [profileId, gid]
    );
    return group.rows || [];
  }
  return [row];
}

/** Сопоставить product_id по offer_id / SKU (как при резерве). */
async function resolveOrderRowProductId(row) {
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
  };
  const resolved = await ordersService._resolveProductIdForOrderStock(orderRowForResolve);
  const pid = resolved != null ? Number(resolved) : null;
  if (!Number.isFinite(pid) || pid < 1) return null;
  return { ...row, product_id: pid, productId: pid };
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
     WHERE organization_id = $1 AND type = 'warehouse' AND supplier_id IS NULL
     ORDER BY id ASC`,
    [organizationId]
  );
  const rows = whRes.rows || [];
  const warehouseId = rows[0] ? Number(rows[0].id) : null;
  return { organizationId, warehouseId };
}

async function resolveOrderWarehouseId(orderRows, defaultWarehouseId) {
  for (const row of orderRows) {
    const mapped = await ordersService._resolveWarehouseIdForOrderReserve(row, row.product_id);
    if (mapped != null && Number(mapped) > 0) return Number(mapped);
  }
  return defaultWarehouseId;
}

async function mapSupplierRows(rows, { priorityFrom = 'index' } = {}) {
  return (rows || []).map((row, idx) => {
    const apiConfig = parseApiConfig(row.api_config);
    const warehousePriority =
      priorityFrom === 'column' && row.priority != null
        ? Number(row.priority) || 0
        : idx;
    return {
      id: Number(row.supplier_id ?? row.id),
      name: row.name,
      code: row.code,
      apiConfig,
      warehousePriority,
      supplierWarehouseId:
        row.supplier_warehouse_id != null ? Number(row.supplier_warehouse_id) : null,
      ...autoOrderSettingsFromApiConfig(apiConfig),
    };
  });
}

/**
 * Поставщики, доступные для закупки на склад заказа:
 * 1) warehouse_suppliers — явные переопределения (priority);
 * 2) warehouses.type = 'supplier' + main_warehouse_id (как в UI «Склады»);
 * 3) все активные поставщики профиля.
 */
async function loadSuppliersForWarehouse(profileId, warehouseId) {
  const pid = normalizeProfileId(profileId);
  const wid = Number(warehouseId);
  if (pid == null || !Number.isFinite(wid) || wid < 1) return [];

  try {
    const wsRes = await query(
      `SELECT ws.supplier_id, ws.priority, s.id, s.name, s.code, s.api_config
       FROM warehouse_suppliers ws
       INNER JOIN suppliers s ON s.id = ws.supplier_id
       WHERE ws.profile_id = $1 AND ws.warehouse_id = $2
         AND COALESCE(s.is_active, true) = true
       ORDER BY ws.priority ASC, s.id ASC`,
      [pid, wid]
    );
    if (wsRes.rows?.length) {
      return mapSupplierRows(
        wsRes.rows.map((row) => ({
          ...row,
          id: row.supplier_id,
          priority: row.priority,
        })),
        { priorityFrom: 'column' }
      );
    }
  } catch (e) {
    logger.warn('[OrderProcurement] warehouse_suppliers lookup skipped', {
      warehouseId: wid,
      message: e?.message || String(e),
    });
  }

  const linkedRes = await query(
    `SELECT DISTINCT ON (s.id)
            s.id AS supplier_id,
            s.name,
            s.code,
            s.api_config,
            w.id AS supplier_warehouse_id
     FROM warehouses w
     INNER JOIN suppliers s ON s.id = w.supplier_id
     WHERE w.type = 'supplier'
       AND w.main_warehouse_id = $2
       AND w.supplier_id IS NOT NULL
       AND COALESCE(s.is_active, true) = true
       AND (w.profile_id = $1 OR w.profile_id IS NULL)
     ORDER BY s.id ASC, w.id ASC`,
    [pid, wid]
  );
  if (linkedRes.rows?.length) {
    return mapSupplierRows(linkedRes.rows, { priorityFrom: 'index' });
  }

  const all = await query(
    `SELECT id, name, code, api_config FROM suppliers
     WHERE profile_id = $1 AND COALESCE(is_active, true) = true
     ORDER BY id ASC`,
    [pid]
  );
  return mapSupplierRows(
    (all.rows || []).map((row) => ({ ...row, supplier_id: row.id })),
    { priorityFrom: 'index' }
  ).map((s) => ({ ...s, warehousePriority: 999 }));
}

async function loadSupplierForProfile(supplierId, profileId) {
  const sid = Number(supplierId);
  const pid = normalizeProfileId(profileId);
  if (!Number.isFinite(sid) || sid < 1) return null;
  if (pid != null) {
    const r = await query(
      `SELECT id, name, code, api_config, profile_id FROM suppliers WHERE id = $1 AND profile_id = $2 LIMIT 1`,
      [sid, pid]
    );
    if (r.rows?.[0]) return r.rows[0];
  }
  const fallback = await query(
    `SELECT id, name, code, api_config, profile_id FROM suppliers WHERE id = $1 LIMIT 1`,
    [sid]
  );
  return fallback.rows?.[0] || null;
}

async function loadProductBoundSupplierId(productId) {
  const pid = Number(productId);
  if (!Number.isFinite(pid) || pid < 1) return null;
  const r = await query(`SELECT supplier_id FROM products WHERE id = $1 LIMIT 1`, [pid]);
  const sid = r.rows?.[0]?.supplier_id;
  if (sid == null) return null;
  const n = Number(sid);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function suppliersForProductBinding(productId, suppliers, profileRow) {
  if (!isProfileProductSupplierBindingEnabled(profileRow)) return suppliers;
  const boundId = await loadProductBoundSupplierId(productId);
  if (boundId == null) return suppliers;
  const filtered = suppliers.filter((s) => Number(s.id) === boundId);
  return filtered.length ? filtered : suppliers;
}

async function rankSupplierCandidates(
  productId,
  suppliers,
  qty,
  { profileRow, warehouseWeekendDays = null, now = new Date() } = {}
) {
  const scoped = await suppliersForProductBinding(productId, suppliers, profileRow);
  const ids = scoped.map((s) => s.id);
  if (!ids.length) return [];
  const need = Math.max(1, Math.floor(Number(qty) || 1));
  const r = await query(
    `SELECT ss.supplier_id, ss.price, ss.stock,
            COALESCE(ss.delivery_days, 0)::int AS delivery_days,
            COALESCE((s.api_config->>'isPriority')::boolean,
                     (s.api_config->>'is_priority')::boolean, false) AS is_priority,
            s.name, s.api_config
     FROM supplier_stocks ss
     INNER JOIN suppliers s ON s.id = ss.supplier_id
     WHERE ss.product_id = $1 AND ss.supplier_id = ANY($2::bigint[])
     ORDER BY ss.price ASC NULLS LAST,
              COALESCE(ss.delivery_days, 999) ASC,
              CASE WHEN COALESCE((s.api_config->>'isPriority')::boolean,
                                 (s.api_config->>'is_priority')::boolean, false)
                THEN 0 ELSE 1 END,
              ss.stock DESC NULLS LAST`,
    [productId, ids]
  );

  const supplierById = new Map(scoped.map((s) => [s.id, s]));
  const out = [];
  for (const row of r.rows || []) {
    const sid = Number(row.supplier_id);
    const stock = row.stock != null ? Number(row.stock) : null;
    const base = supplierById.get(sid);
    if (!base) continue;
    if (stock == null || !Number.isFinite(stock) || stock < need) {
      continue;
    }
    out.push({
      ...base,
      price: row.price != null ? Number(row.price) : null,
      stock,
      deliveryDays: Number(row.delivery_days) || 0,
      isPriority: Boolean(row.is_priority),
    });
  }
  return sortSupplierCandidatesByProcurementRules(out, { now, warehouseWeekendDays });
}

async function supplierHasKitStock(suppliers, kitProductId, qty, { profileRow } = {}) {
  const candidates = await rankSupplierCandidates(kitProductId, suppliers, qty, { profileRow });
  return candidates.length > 0 ? candidates[0] : null;
}

async function expandOrderRowToDemandLines(row, suppliers, { profileRow } = {}) {
  const productId = Number(row.product_id);
  const qty = Math.max(1, parseInt(row.quantity, 10) || 1);
  const orderDbId = Number(row.id);
  const marketplace = row.marketplace;
  const orderId = row.order_id;
  if (!Number.isFinite(productId) || productId < 1) return [];

  const base = { orderDbId, marketplace, orderId, orderRow: row };

  if (await isKitProductId(productId)) {
    const kitSupplier = await supplierHasKitStock(suppliers, productId, qty, { profileRow });
    if (kitSupplier) {
      return [
        {
          ...base,
          lineKey: `kit:${productId}:whole`,
          productId,
          kitProductId: productId,
          quantityNeeded: qty,
          mode: 'whole_kit',
        },
      ];
    }
    const components = await getKitComponents(productId);
    if (!components.length) {
      return [
        {
          ...base,
          lineKey: `kit:${productId}:whole`,
          productId,
          kitProductId: productId,
          quantityNeeded: qty,
          mode: 'whole_kit',
        },
      ];
    }
    return components.map((c) => {
      const compId = Number(c.component_product_id);
      const perKit = Math.max(1, parseInt(c.quantity, 10) || 1);
      return {
        ...base,
        lineKey: `kit:${productId}:component:${compId}`,
        productId: compId,
        kitProductId: productId,
        quantityNeeded: perKit * qty,
        mode: 'component',
      };
    });
  }

  return [
    {
      ...base,
      lineKey: `product:${productId}`,
      productId,
      kitProductId: null,
      quantityNeeded: qty,
      mode: 'product',
    },
  ];
}

async function getFulfillmentLine(client, profileId, orderDbId, lineKey) {
  const r = await client.query(
    `SELECT * FROM order_fulfillment_lines
     WHERE profile_id = $1 AND order_db_id = $2 AND line_key = $3`,
    [profileId, orderDbId, lineKey]
  );
  return r.rows?.[0] || null;
}

async function upsertFulfillmentLine(
  client,
  {
    profileId,
    orderDbId,
    marketplace,
    orderId,
    lineKey,
    productId,
    kitProductId,
    quantityNeeded,
    quantityReserved,
    quantityPurchased,
    purchaseItemId,
    status,
    manualReason,
  }
) {
  const run = client && typeof client.query === 'function' ? client.query.bind(client) : query;
  await run(
    `INSERT INTO order_fulfillment_lines (
       profile_id, order_db_id, marketplace, order_id, line_key, product_id, kit_product_id,
       quantity_needed, quantity_reserved, quantity_purchased, purchase_item_id, status, manual_reason
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (profile_id, order_db_id, line_key) DO UPDATE SET
       quantity_needed = EXCLUDED.quantity_needed,
       quantity_reserved = EXCLUDED.quantity_reserved,
       quantity_purchased = EXCLUDED.quantity_purchased,
       purchase_item_id = COALESCE(EXCLUDED.purchase_item_id, order_fulfillment_lines.purchase_item_id),
       status = EXCLUDED.status,
       manual_reason = EXCLUDED.manual_reason,
       updated_at = CURRENT_TIMESTAMP`,
    [
      profileId,
      orderDbId,
      marketplace,
      orderId,
      lineKey,
      productId,
      kitProductId,
      quantityNeeded,
      quantityReserved,
      quantityPurchased,
      purchaseItemId,
      status,
      manualReason,
    ]
  );
}

async function findOpenPurchasesForOrder(profileId, marketplace, orderId) {
  const oid = String(orderId ?? '').trim();
  if (!oid) return [];
  const lookupIds = await orderIdsForPurchaseLookup(profileId, marketplace, orderId);
  const mpVariants = marketplaceVariantsForLookup(marketplace);
  const orderRows = await loadOrderRows(profileId, marketplace, orderId);
  const orderDbIds = orderRows.map((r) => Number(r.id)).filter((id) => id > 0);

  const bySource = await query(
    `SELECT DISTINCT p.id AS purchase_id, p.supplier_id, s.name AS supplier_name, s.code AS supplier_code
     FROM purchases p
     INNER JOIN purchase_items pi ON pi.purchase_id = p.id
     LEFT JOIN suppliers s ON s.id = p.supplier_id
     CROSS JOIN LATERAL jsonb_array_elements(COALESCE(pi.source_orders, '[]'::jsonb)) AS elem
     WHERE p.profile_id = $1
       AND p.status = 'open'
       AND p.supplier_id IS NOT NULL
       AND LOWER(TRIM(elem->>'orderId')) = ANY($2::text[])
       AND LOWER(TRIM(elem->>'marketplace')) = ANY($3::text[])`,
    [profileId, lookupIds, mpVariants]
  );

  let viaFulfillment = { rows: [] };
  if (orderDbIds.length) {
    viaFulfillment = await query(
      `SELECT DISTINCT p.id AS purchase_id, p.supplier_id, s.name AS supplier_name, s.code AS supplier_code
       FROM order_fulfillment_lines fl
       INNER JOIN purchase_items pi ON pi.id = fl.purchase_item_id
       INNER JOIN purchases p ON p.id = pi.purchase_id
       LEFT JOIN suppliers s ON s.id = p.supplier_id
       WHERE fl.profile_id = $1
         AND fl.order_db_id = ANY($2::bigint[])
         AND p.status = 'open'
         AND p.supplier_id IS NOT NULL`,
      [profileId, orderDbIds]
    );
  }

  const map = new Map();
  for (const row of [...(bySource.rows || []), ...(viaFulfillment.rows || [])]) {
    const purchaseId = Number(row.purchase_id);
    if (Number.isFinite(purchaseId) && purchaseId > 0) {
      map.set(purchaseId, row);
    }
  }
  return [...map.values()];
}

/** Повторная отправка в API поставщика, если закупка уже есть, но заказ не ушёл (дефицит = 0). */
async function retrySupplierSubmitForOpenOrderPurchases(profileId, marketplace, orderId) {
  const pid = normalizeProfileId(profileId);
  const oid = String(orderId ?? '').trim();
  if (pid == null || !oid) return [];

  const openPurchases = await findOpenPurchasesForOrder(pid, marketplace, oid);
  const touched = [];

  for (const row of openPurchases) {
    const purchaseId = Number(row.purchase_id);
    const supplierId = Number(row.supplier_id);
    if (!Number.isFinite(purchaseId) || !Number.isFinite(supplierId)) continue;
    if (!supplierSupportsApiOrder({ code: row.supplier_code })) continue;

    const pre = await supplierPreSubmitRequired(supplierId, pid);
    if (!pre.required) continue;

    logger.info('[OrderProcurement] retry supplier submit for open purchase', {
      orderId: oid,
      purchaseId,
      supplierId,
    });

    const supplierSubmit = await trySubmitPurchaseToSupplier({
      purchaseId,
      supplierId,
      profileId: pid,
      orderScope: await buildOrderSupplierSubmitScope(pid, marketplace, oid),
    }).catch((e) => ({
      submitted: false,
      reason: 'submit_error',
      message: e?.message || String(e),
    }));

    if (supplierSubmit?.skipped) {
      logger.info('[OrderProcurement] skip retry — already submitted to supplier', {
        orderId: oid,
        purchaseId,
      });
      continue;
    }

    if (supplierSubmit?.submitted) {
      await ensureOrdersMarkedInProcurement(pid, marketplace, oid, []);
    } else if (!supplierSubmit?.skipped) {
      await purchasesService
        .revertMarketplaceOrderFromPurchase(purchaseId, {
          marketplace,
          orderId: oid,
          profileId: pid,
        })
        .catch((e) => {
          logger.warn('[OrderProcurement] revert after retry submit failed', {
            orderId: oid,
            purchaseId,
            message: e?.message || String(e),
          });
        });
      await addRuntimeNotification({
        type: 'supplier_order_submit_failed',
        severity: 'error',
        source: 'supplier_order_placement',
        title: 'Заказы не отправлены поставщику',
        message: `${row.supplier_name || 'Поставщик'}: ${
          supplierSubmit?.message || 'ошибка отправки'
        }. Заказ ${oid} оставлен в статусе «Новый».`,
        meta: {
          url: '/orders?status=new',
          purchase_id: purchaseId,
          order_ids: [oid],
          supplier_name: row.supplier_name,
        },
      }).catch(() => {});
    }

    touched.push({
      purchaseId,
      supplierId,
      supplierName: row.supplier_name,
      appended: true,
      supplierSubmit,
    });
  }

  return touched;
}

/** Сверка quantity_purchased с реальными открытыми закупками; сброс устаревших записей. */
async function effectivePurchasedQty(
  profileId,
  orderDbId,
  productId,
  recordedPurchased,
  { resetStale = false, lineKey = null } = {}
) {
  const recorded = Math.max(0, Math.floor(Number(recordedPurchased) || 0));
  if (!recorded) return 0;

  const r = await query(
    `SELECT COALESCE(SUM(GREATEST(0, pi.expected_quantity - pi.received_quantity)), 0)::int AS qty
     FROM purchase_items pi
     INNER JOIN purchases p ON p.id = pi.purchase_id
     CROSS JOIN LATERAL jsonb_array_elements(COALESCE(pi.source_orders, '[]'::jsonb)) AS elem
     INNER JOIN orders o ON o.id = $2
     WHERE p.profile_id = $1
       AND pi.product_id = $3
       AND p.status = 'open'
       AND (
         LOWER(TRIM(elem->>'orderId')) = LOWER(TRIM(o.order_id))
         OR (
           o.order_group_id IS NOT NULL
           AND LOWER(TRIM(elem->>'orderId')) = LOWER(TRIM(o.order_group_id))
         )
       )`,
    [profileId, orderDbId, productId]
  );
  const fromOpen = Number(r.rows?.[0]?.qty) || 0;
  if (fromOpen >= recorded) return Math.min(recorded, fromOpen);

  if (resetStale && recorded > 0 && fromOpen === 0) {
    const params = [profileId, orderDbId, productId];
    let whereExtra = '';
    if (lineKey) {
      whereExtra = ' AND fl.line_key = $4';
      params.push(lineKey);
    }
    await query(
      `UPDATE order_fulfillment_lines fl
       SET quantity_purchased = 0,
           status = CASE
             WHEN fl.quantity_reserved >= fl.quantity_needed THEN 'reserved'
             WHEN fl.quantity_reserved > 0 THEN 'partial'
             ELSE 'pending'
           END,
           updated_at = CURRENT_TIMESTAMP
       WHERE fl.profile_id = $1 AND fl.order_db_id = $2 AND fl.product_id = $3${whereExtra}`,
      params
    );
    logger.info('[OrderProcurement] reset stale purchased qty (no open purchase)', {
      orderDbId,
      productId,
      lineKey,
      was: recorded,
    });
    return 0;
  }

  return fromOpen;
}

/** Перевести заказ(ы) в статус «В закупке» после оформления закупки или отправки поставщику. */
async function ensureOrdersMarkedInProcurement(profileId, marketplace, orderId, orderRows = []) {
  const pid = normalizeProfileId(profileId);
  const oid = String(orderId ?? '').trim();
  if (pid == null || !oid) return { updated: 0 };

  const refs = [];
  const seen = new Set();
  const dbMp = orderMarketplaceToDb(marketplace);
  for (const row of orderRows || []) {
    const mp = row.marketplace || dbMp;
    const id = row.order_id || oid;
    const key = `${mp}|${id}`;
    if (!mp || !id || seen.has(key)) continue;
    seen.add(key);
    refs.push({ marketplace: mp, orderId: id });
  }
  if (!seen.has(`${dbMp}|${oid}`)) {
    refs.push({ marketplace: dbMp, orderId: oid });
  }
  if (!refs.length) return { updated: 0 };

  try {
    return await ordersService.bulkSetToProcurement(refs, pid, { skipReserveReapply: true });
  } catch (e) {
    logger.warn('[OrderProcurement] ensureOrdersMarkedInProcurement failed', {
      orderId: oid,
      message: e?.message || String(e),
    });
    return { updated: 0, error: e?.message || String(e) };
  }
}

async function sumOpenPurchaseTotal(client, purchaseId, supplierId) {
  const r = await client.query(
    `SELECT COALESCE(SUM(
       COALESCE(pi.purchase_price, ss.price, 0) * GREATEST(0, pi.expected_quantity - pi.received_quantity)
     ), 0)::numeric AS total
     FROM purchase_items pi
     LEFT JOIN supplier_stocks ss ON ss.supplier_id = $2 AND ss.product_id = pi.product_id
     WHERE pi.purchase_id = $1`,
    [purchaseId, supplierId]
  );
  return Number(r.rows?.[0]?.total) || 0;
}

async function pickSupplierForDeficit(
  productId,
  suppliers,
  qty,
  {
    client,
    profileId,
    profileRow,
    warehouseWeekendDays = null,
    ignoreMinOrderForApiSuppliers = false,
    now = new Date(),
  } = {}
) {
  const candidates = await rankSupplierCandidates(productId, suppliers, qty, {
    profileRow,
    warehouseWeekendDays,
    now,
  });
  for (const cand of candidates) {
    const price = cand.price != null && cand.price > 0 ? cand.price : 0;
    const lineTotal = price * qty;
    const minOrder = cand.minOrderAmount;

    let openPurchaseId = null;
    let openTotal = 0;
    if (client && profileId) {
      const bucket = resolveProcurementArrivalBucketFromApiConfig(
        cand.apiConfig,
        now,
        warehouseWeekendDays,
        cand.code
      );
      openPurchaseId = await findOpenAutoPurchaseId(client, {
        profileId,
        supplierId: cand.id,
        arrivalBucket: bucket,
        now,
        warehouseWeekendDays,
      });
      if (openPurchaseId) {
        openTotal = await sumOpenPurchaseTotal(client, openPurchaseId, cand.id);
      }
    }

    if (minOrder != null && minOrder > 0) {
      const projected = (openPurchaseId ? openTotal : 0) + lineTotal;
      const apiOrderSupplier = supplierSupportsApiOrder(cand);
      if (projected < minOrder && !openPurchaseId) {
        if (!(ignoreMinOrderForApiSuppliers && apiOrderSupplier)) continue;
      }
      if (projected < minOrder && openPurchaseId) {
        // Накопление в открытой закупке — допустимо
      }
    }

    return { supplier: cand, openPurchaseId, lineTotal, price };
  }
  return null;
}

async function updatePurchaseDates(purchaseId, { shipDate, plannedDeliveryDate, supplierWarehouseName }) {
  if (!purchaseId) return;
  await query(
    `UPDATE purchases SET
       ship_date = COALESCE($2::date, ship_date),
       planned_delivery_date = COALESCE($3::date, planned_delivery_date),
       supplier_warehouse_name = COALESCE($4, supplier_warehouse_name),
       updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [purchaseId, shipDate || null, plannedDeliveryDate || null, supplierWarehouseName || null]
  );
}

function groupKey(supplierId, arrivalBucket) {
  return `${supplierId}|${arrivalBucket}`;
}

class OrderProcurementPlannerService {
  /**
   * Отправить заказ в закупку: резерв со склада → закупка дефицита → резерв (без API поставщика).
   */
  async runForMarketplaceOrder(
    marketplace,
    orderId,
    { profileId, userId = null, now = new Date() } = {}
  ) {
    const pid = normalizeProfileId(profileId);
    if (pid == null) {
      return { ok: false, error: 'no_profile', message: 'Профиль не определён' };
    }
    if (!repositoryFactory.isUsingPostgreSQL()) {
      return { ok: false, error: 'not_pg', message: 'Доступно только с PostgreSQL' };
    }

    const profilesRepo = repositoryFactory.getProfilesRepository?.();
    const profileRow =
      profilesRepo && typeof profilesRepo.findById === 'function'
        ? await profilesRepo.findById(pid)
        : null;
    if (!isProfileSupplierSyncEnabled(profileRow)) {
      return {
        ok: false,
        error: 'supplier_sync_disabled',
        message: 'Работа с поставщиками отключена для этого аккаунта',
      };
    }

    const orderRows = await loadOrderRows(pid, marketplace, orderId);
    if (!orderRows.length) {
      return { ok: false, error: 'order_not_found', message: 'Заказ не найден' };
    }

    const eligibleRows = orderRows.filter(isEligibleOrderRow);
    if (!eligibleRows.length) {
      return {
        ok: false,
        error: 'ineligible_status',
        message: 'Заказ в статусе, не допускающем отправку в закупку',
        status: orderRows[0]?.status ?? null,
      };
    }

    const { organizationId, warehouseId: defaultWarehouseId } = await resolveDefaultOrgAndWarehouse(pid);
    if (!organizationId || !defaultWarehouseId) {
      return {
        ok: false,
        error: 'no_org_warehouse',
        message: 'Укажите организацию и склад (хотя бы по одному на аккаунт)',
      };
    }

    const orderWarehouseId =
      (await resolveOrderWarehouseId(eligibleRows, defaultWarehouseId)) || defaultWarehouseId;
    const warehouseWeekendDays = await loadWarehouseWeekendDays(orderWarehouseId, pid);
    const suppliers = await loadSuppliersForWarehouse(pid, orderWarehouseId);
    if (!suppliers.length) {
      return { ok: false, error: 'no_suppliers', message: 'Нет активных поставщиков' };
    }

    const lineResults = [];
    const purchaseGroups = new Map();
    const procurementItems = [];
    const seenProc = new Set();

    // 1) Резерв из наличия / в пути (существующая логика заказов)
    for (const row of eligibleRows) {
      try {
        await ordersService._applyReserveForOrderIfAbsent(row);
      } catch (e) {
        logger.warn('[OrderProcurement] reserve failed', {
          orderId: row.order_id,
          message: e?.message || String(e),
        });
      }
    }

    // 2) Разбор потребности и расчёт дефицита
    const demandLines = [];
    const unresolvedOrders = [];
    for (const row of eligibleRows) {
      const resolvedRow = await resolveOrderRowProductId(row);
      if (!resolvedRow) {
        unresolvedOrders.push(String(row.order_id || '').trim() || row.id);
        continue;
      }
      const expanded = await expandOrderRowToDemandLines(resolvedRow, suppliers, { profileRow });
      demandLines.push(...expanded);
      const procKey = `${row.marketplace}|${row.order_id}`;
      if (!seenProc.has(procKey)) {
        seenProc.add(procKey);
        procurementItems.push({ marketplace: row.marketplace, orderId: row.order_id });
      }
    }

    if (!demandLines.length) {
      const hint =
        unresolvedOrders.length > 0
          ? 'Сопоставьте товар в каталоге (артикул Ozon / SKU в карточке товара).'
          : 'Нет позиций для закупки.';
      return {
        ok: false,
        error: unresolvedOrders.length > 0 ? 'product_not_resolved' : 'no_demand',
        message:
          unresolvedOrders.length > 0
            ? `Не определён товар в каталоге для заказа. ${hint}`
            : hint,
        unresolvedOrders,
      };
    }

    for (const line of demandLines) {
      const reservedNow = await ordersService._getReservedQtyForOrderProduct(
        line.orderDbId,
        line.productId
      );
      const existing = await query(
        `SELECT quantity_purchased, status FROM order_fulfillment_lines
         WHERE profile_id = $1 AND order_db_id = $2 AND line_key = $3`,
        [pid, line.orderDbId, line.lineKey]
      );
      const recordedPurchased = Number(existing.rows?.[0]?.quantity_purchased) || 0;
      const prevPurchased = await effectivePurchasedQty(
        pid,
        line.orderDbId,
        line.productId,
        recordedPurchased,
        { resetStale: true, lineKey: line.lineKey }
      );

      const coverage = computeProcurementDeficit({
        quantityNeeded: line.quantityNeeded,
        quantityReserved: reservedNow,
        quantityPurchased: prevPurchased,
      });

      const lineResult = {
        lineKey: line.lineKey,
        productId: line.productId,
        kitProductId: line.kitProductId,
        mode: line.mode,
        orderId: line.orderId,
        need: coverage.need,
        reserved: coverage.reserved,
        purchased: coverage.purchased,
        deficit: coverage.deficit,
        status: fulfillmentLineStatusFromQuantities({
          need: coverage.need,
          reserved: coverage.reserved,
          purchased: coverage.purchased,
          deficit: coverage.deficit,
          manual: false,
        }),
        purchaseId: null,
        manualReason: null,
      };

      if (coverage.deficit > 0) {
        const pick = await transaction(async (client) => {
          const lockKey = Number(line.orderDbId) % 2147483647;
          await client.query('SELECT pg_advisory_xact_lock($1, $2)', [pid, lockKey]);
          return pickSupplierForDeficit(line.productId, suppliers, coverage.deficit, {
            client,
            profileId: pid,
            profileRow,
            warehouseWeekendDays,
            ignoreMinOrderForApiSuppliers: true,
            now,
          });
        });

        if (!pick) {
          lineResult.status = 'manual_required';
          lineResult.manualReason = 'Не найден поставщик (остаток, мин. сумма или цена)';
          lineResults.push(lineResult);
          await upsertFulfillmentLine(null, {
            profileId: pid,
            orderDbId: line.orderDbId,
            marketplace: line.marketplace,
            orderId: line.orderId,
            lineKey: line.lineKey,
            productId: line.productId,
            kitProductId: line.kitProductId,
            quantityNeeded: coverage.need,
            quantityReserved: coverage.reserved,
            quantityPurchased: prevPurchased,
            purchaseItemId: null,
            status: lineResult.status,
            manualReason: lineResult.manualReason,
          });
          continue;
        }

        const { supplier, openPurchaseId, price } = pick;
        const dates = computeProcurementDates(
          supplier.apiConfig,
          now,
          supplier.deliveryDays,
          warehouseWeekendDays,
          supplier.code
        );
        const gKey = groupKey(supplier.id, dates.arrivalBucket);
        if (!purchaseGroups.has(gKey)) {
          purchaseGroups.set(gKey, {
            supplierId: supplier.id,
            supplierName: supplier.name,
            arrivalBucket: dates.arrivalBucket,
            minOrderAmount: supplier.minOrderAmount,
            existingPurchaseId: openPurchaseId,
            shipDate: dates.shipDate,
            plannedDeliveryDate: dates.plannedDeliveryDate,
            supplierWarehouseName: dates.supplierWarehouseName,
            items: [],
            procurementItems: [],
          });
        }
        const g = purchaseGroups.get(gKey);
        const sourceOrders = [{ marketplace: line.marketplace, orderId: line.orderId }];
        const existingItem = g.items.find(
          (it) => it.productId === line.productId && it.lineKey === line.lineKey
        );
        if (existingItem) {
          existingItem.quantity += coverage.deficit;
        } else {
          g.items.push({
            lineKey: line.lineKey,
            productId: line.productId,
            quantity: coverage.deficit,
            sourceOrders,
            purchasePrice: price > 0 ? price : null,
            orderDbId: line.orderDbId,
            coverage,
            prevPurchased,
            lineMeta: line,
          });
        }
        lineResult.purchased = coverage.purchased + coverage.deficit;
        lineResult.deficit = 0;
        lineResult.status = fulfillmentLineStatusFromQuantities({
          need: coverage.need,
          reserved: coverage.reserved,
          purchased: lineResult.purchased,
          deficit: 0,
          manual: false,
        });
      }

      lineResults.push(lineResult);
    }

    // 3) Создание / дополнение закупок
    const purchasesTouched = [];
    const supplierRejects = [];
    for (const g of purchaseGroups.values()) {
      if (!g.items.length) continue;
      const note = `${autoArrivalNoteText(g.arrivalBucket)} · отправка в закупку`;
      const payload = {
        procurementItems,
        items: g.items.map((it) => ({
          productId: it.productId,
          quantity: it.quantity,
          sourceOrders: it.sourceOrders,
          purchasePrice: it.purchasePrice,
        })),
        note,
        supplierWarehouseName: g.supplierWarehouseName,
      };
      if (g.existingPurchaseId) {
        payload.existingPurchaseId = g.existingPurchaseId;
      } else {
        payload.supplierId = g.supplierId;
        payload.organizationId = organizationId;
        payload.warehouseId = orderWarehouseId;
      }

      try {
        const result = await purchasesService.procureFromOrders(payload, {
          userId,
          profileId: pid,
          // Для любого API-поставщика сразу отправляем заказ;
          // при отказе позиции откатываются, заказы остаются в «Новых».
          submitToSupplier: true,
        });
        if (result?.rolledBack && !result?.purchaseId) {
          supplierRejects.push({
            supplierId: g.supplierId,
            supplierName: g.supplierName,
            supplierSubmit: result?.supplierSubmit ?? null,
          });
          logger.warn('[OrderProcurement] supplier rejected — purchase rolled back', {
            orderId,
            supplierId: g.supplierId,
            reason: result?.supplierSubmit?.reason,
            message: result?.supplierSubmit?.message,
          });
          continue;
        }
        const purchaseId = result?.purchaseId ?? g.existingPurchaseId;
        if (purchaseId) {
          await updatePurchaseDates(purchaseId, {
            shipDate: g.shipDate,
            plannedDeliveryDate: g.plannedDeliveryDate,
            supplierWarehouseName: g.supplierWarehouseName,
          });
          purchasesTouched.push({
            purchaseId,
            supplierId: g.supplierId,
            supplierName: g.supplierName,
            appended: Boolean(g.existingPurchaseId),
            supplierSubmit: result?.supplierSubmit ?? null,
            rolledBack: Boolean(result?.rolledBack),
          });
        }

        for (const it of g.items) {
          const lr = lineResults.find(
            (x) => x.lineKey === it.lineKey && x.productId === it.productId
          );
          if (lr) lr.purchaseId = purchaseId;
          await upsertFulfillmentLine(null, {
            profileId: pid,
            orderDbId: it.lineMeta.orderDbId,
            marketplace: it.lineMeta.marketplace,
            orderId: it.lineMeta.orderId,
            lineKey: it.lineKey,
            productId: it.productId,
            kitProductId: it.lineMeta.kitProductId,
            quantityNeeded: it.coverage.need,
            quantityReserved: it.coverage.reserved,
            quantityPurchased: it.prevPurchased + it.quantity,
            purchaseItemId: null,
            status: fulfillmentLineStatusFromQuantities({
              need: it.coverage.need,
              reserved: it.coverage.reserved,
              purchased: it.prevPurchased + it.quantity,
              deficit: 0,
              manual: false,
            }),
            manualReason: null,
          });
        }
      } catch (e) {
        logger.warn('[OrderProcurement] procure failed', {
          supplierId: g.supplierId,
          message: e?.message || String(e),
        });
        const failReason =
          e?.message || 'Ошибка оформления закупки';
        for (const it of g.items) {
          const lr = lineResults.find(
            (x) => x.lineKey === it.lineKey && x.productId === it.productId
          );
          if (lr) {
            lr.status = 'manual_required';
            lr.manualReason = failReason;
            lr.purchased = it.coverage.purchased;
            lr.deficit = it.quantity;
          }
        }
      }
    }

    // 4) Сохранить строки покрытия (резерв и manual_required после сбоя закупки)
    for (const lr of lineResults) {
      const dl = demandLines.find((d) => d.lineKey === lr.lineKey);
      if (!dl) continue;

      if (lr.status === 'manual_required' && lr.deficit > 0) {
        await upsertFulfillmentLine(null, {
          profileId: pid,
          orderDbId: dl.orderDbId,
          marketplace: dl.marketplace,
          orderId: dl.orderId,
          lineKey: lr.lineKey,
          productId: lr.productId,
          kitProductId: lr.kitProductId,
          quantityNeeded: lr.need,
          quantityReserved: lr.reserved,
          quantityPurchased: lr.purchased,
          purchaseItemId: null,
          status: lr.status,
          manualReason: lr.manualReason,
        });
        continue;
      }

      const already = await query(
        `SELECT 1 FROM order_fulfillment_lines
         WHERE profile_id = $1 AND order_db_id = $2 AND line_key = $3`,
        [pid, dl.orderDbId, lr.lineKey]
      );
      if (already.rows?.length) continue;
      await upsertFulfillmentLine(null, {
        profileId: pid,
        orderDbId: dl.orderDbId,
        marketplace: dl.marketplace,
        orderId: dl.orderId,
        lineKey: lr.lineKey,
        productId: lr.productId,
        kitProductId: lr.kitProductId,
        quantityNeeded: lr.need,
        quantityReserved: lr.reserved,
        quantityPurchased: lr.purchased,
        purchaseItemId: null,
        status: lr.status,
        manualReason: lr.manualReason,
      });
    }

    const manualLines = lineResults.filter((l) => l.status === 'manual_required');
    const totalReserved = lineResults.reduce((s, l) => s + (l.reserved || 0), 0);
    const totalPurchased = lineResults.reduce((s, l) => {
      if (l.deficit > 0) return s + Math.max(0, (l.purchased || 0));
      return s + Math.max(0, l.purchased || 0);
    }, 0);
    const allManual = lineResults.length > 0 && manualLines.length === lineResults.length;

    if (allManual && !purchasesTouched.length) {
      const reason = manualLines.find((l) => l.manualReason)?.manualReason;
      return {
        ok: false,
        error: 'manual_required',
        message: reason
          ? `Не удалось оформить закупку: ${reason}`
          : 'Не удалось автоматически закупить позиции заказа',
        lines: lineResults,
        manualLines,
      };
    }

    if (!purchasesTouched.length && supplierRejects.length) {
      const reason =
        supplierRejects.find((r) => r.supplierSubmit?.message)?.supplierSubmit?.message ||
        'Поставщик не принял заказ';
      return {
        ok: false,
        error: 'supplier_submit_failed',
        message: `${reason}. Заказы оставлены в статусе «Новый» (см. уведомления).`,
        lines: lineResults,
        manualLines,
        supplierRejects,
      };
    }

    const reserveOnly =
      !purchasesTouched.length &&
      lineResults.length > 0 &&
      lineResults.every((l) => l.deficit <= 0 && l.status !== 'manual_required');

    let message;
    if (reserveOnly) {
      message = `Зарезервировано ${totalReserved} шт. по заказу, закупка не требуется`;
    } else if (purchasesTouched.length) {
      const p = purchasesTouched[0];
      const sentToSupplier = Boolean(p.supplierSubmit?.submitted);
      if (sentToSupplier) {
        message =
          totalReserved > 0
            ? `Отправлено поставщику, закуплено ${totalPurchased} шт., зарезервировано ${totalReserved} шт. (закупка №${p.purchaseId})`
            : `Отправлено поставщику, закуплено ${totalPurchased} шт. (закупка №${p.purchaseId})`;
      } else {
        message =
          totalReserved > 0
            ? `Закуплено ${totalPurchased} шт., зарезервировано ${totalReserved} шт. (закупка №${p.purchaseId})`
            : `Закуплено ${totalPurchased} шт. (закупка №${p.purchaseId})`;
      }
      if (p.supplierSubmit?.message) {
        message += `. ${p.supplierSubmit.message}`;
      }
    } else {
      message = lineResults.length
        ? 'Обработка заказа завершена'
        : 'Нет позиций для закупки по заказу';
    }

    if (manualLines.length) {
      message += `. Требуется ручной выбор поставщика: ${manualLines.length} поз.`;
    }

    let procurementStatus = null;
    // procureFromOrders уже ставит «В закупке» при успехе; здесь не дублируем после partial/rollback.
    const canMarkProcurement =
      purchasesTouched.some((p) => p.purchaseId) &&
      !purchasesTouched.some((p) => p.rolledBack || p.supplierSubmit?.partial);
    if (canMarkProcurement) {
      procurementStatus = await ensureOrdersMarkedInProcurement(
        pid,
        marketplace,
        orderId,
        eligibleRows
      );
      if (procurementStatus?.updated > 0) {
        message += '. Статус заказа: В закупке';
      }
    }

    return {
      ok: true,
      message,
      lines: lineResults,
      manualLines,
      purchases: purchasesTouched,
      totalReserved,
      totalPurchased,
      reserveOnly,
      procurementStatus,
    };
  }

  /** Строки покрытия заказа (для ручной закупки). */
  async listFulfillmentLinesForMarketplaceOrder(
    marketplace,
    orderId,
    { profileId, includeAll = false } = {}
  ) {
    const pid = normalizeProfileId(profileId);
    if (pid == null) {
      return { ok: false, error: 'no_profile', message: 'Профиль не определён', lines: [] };
    }
    if (!repositoryFactory.isUsingPostgreSQL()) {
      return { ok: false, error: 'not_pg', message: 'Доступно только с PostgreSQL', lines: [] };
    }

    const orderRows = await loadOrderRows(pid, marketplace, orderId);
    if (!orderRows.length) {
      return { ok: false, error: 'order_not_found', message: 'Заказ не найден', lines: [] };
    }

    const orderDbIds = orderRows.map((r) => Number(r.id)).filter((id) => id > 0);
    const { warehouseId: defaultWarehouseId } = await resolveDefaultOrgAndWarehouse(pid);
    const orderWarehouseId =
      (await resolveOrderWarehouseId(orderRows, defaultWarehouseId)) || defaultWarehouseId;

    const profilesRepo = repositoryFactory.getProfilesRepository?.();
    const profileRow =
      profilesRepo && typeof profilesRepo.findById === 'function'
        ? await profilesRepo.findById(pid)
        : null;

    const r = await query(
      `SELECT fl.*,
              p.name AS product_name,
              p.sku AS product_sku,
              p.supplier_id AS product_supplier_id,
              pk.name AS kit_name,
              pk.sku AS kit_sku
       FROM order_fulfillment_lines fl
       LEFT JOIN products p ON p.id = fl.product_id
       LEFT JOIN products pk ON pk.id = fl.kit_product_id
       WHERE fl.profile_id = $1 AND fl.order_db_id = ANY($2::bigint[])
       ORDER BY fl.id ASC`,
      [pid, orderDbIds]
    );

    const lines = [];
    for (const row of r.rows || []) {
      const orderDbId = Number(row.order_db_id);
      const productId = Number(row.product_id);
      const quantityNeeded = Number(row.quantity_needed) || 0;
      const quantityPurchased = Number(row.quantity_purchased) || 0;
      const reservedNow = await ordersService._getReservedQtyForOrderProduct(orderDbId, productId);
      const effectivePurchased = await effectivePurchasedQty(
        pid,
        orderDbId,
        productId,
        quantityPurchased,
        { resetStale: false, lineKey: row.line_key }
      );
      const coverage = computeProcurementDeficit({
        quantityNeeded,
        quantityReserved: reservedNow,
        quantityPurchased:
          effectivePurchased < quantityPurchased ? effectivePurchased : quantityPurchased,
      });

      if (!includeAll && coverage.deficit <= 0) continue;

      const suppliers = await loadSuppliersForWarehouse(pid, orderWarehouseId);
      const warehouseWeekendDays = await loadWarehouseWeekendDays(orderWarehouseId, pid);
      const suggestedSuppliers = await rankSupplierCandidates(
        productId,
        suppliers,
        coverage.deficit || 1,
        { profileRow, warehouseWeekendDays, now: new Date() }
      );

      const boundSupplierId =
        row.product_supplier_id != null ? Number(row.product_supplier_id) : null;

      lines.push({
        lineKey: row.line_key,
        orderDbId,
        marketplace: row.marketplace,
        orderId: row.order_id,
        productId,
        productName: row.product_name,
        productSku: row.product_sku,
        boundSupplierId:
          Number.isFinite(boundSupplierId) && boundSupplierId > 0 ? boundSupplierId : null,
        kitProductId: row.kit_product_id != null ? Number(row.kit_product_id) : null,
        kitName: row.kit_name,
        kitSku: row.kit_sku,
        quantityNeeded: coverage.need,
        quantityReserved: coverage.reserved,
        quantityPurchased: coverage.purchased,
        deficit: coverage.deficit,
        status: row.status,
        manualReason: row.manual_reason,
        suggestedSuppliers: suggestedSuppliers.slice(0, 8).map((s) => ({
          id: s.id,
          name: s.name,
          price: s.price,
          stock: s.stock,
          deliveryDays: s.deliveryDays,
        })),
      });
    }

    return {
      ok: true,
      lines,
      manualCount: lines.filter((l) => l.deficit > 0).length,
      marketplace: orderMarketplaceToDb(marketplace),
      orderId: String(orderId),
    };
  }

  /**
   * Ручная закупка позиций с выбором поставщика.
   * @param {Array<{ lineKey: string, quantity?: number }>} items
   */
  async manualProcureForMarketplaceOrder(
    marketplace,
    orderId,
    {
      profileId,
      userId = null,
      supplierId,
      existingPurchaseId = null,
      organizationId = null,
      warehouseId = null,
      items = [],
      now = new Date(),
    } = {}
  ) {
    const pid = normalizeProfileId(profileId);
    if (pid == null) {
      return { ok: false, error: 'no_profile', message: 'Профиль не определён' };
    }
    if (!repositoryFactory.isUsingPostgreSQL()) {
      return { ok: false, error: 'not_pg', message: 'Доступно только с PostgreSQL' };
    }

    const sid = Number(supplierId);
    if (!Number.isFinite(sid) || sid < 1) {
      return { ok: false, error: 'no_supplier', message: 'Выберите поставщика' };
    }

    const list = await this.listFulfillmentLinesForMarketplaceOrder(marketplace, orderId, {
      profileId: pid,
      includeAll: true,
    });
    if (!list.ok) return list;

    const lineByKey = new Map(list.lines.map((l) => [l.lineKey, l]));
    const requested =
      Array.isArray(items) && items.length > 0
        ? items
        : list.lines.filter((l) => l.deficit > 0).map((l) => ({ lineKey: l.lineKey }));

    if (!requested.length) {
      return { ok: false, error: 'no_lines', message: 'Нет позиций для ручной закупки' };
    }

    const { organizationId: defaultOrg, warehouseId: defaultWh } =
      await resolveDefaultOrgAndWarehouse(pid);
    const orgId = Number(organizationId) || defaultOrg;
    const whId = Number(warehouseId) || defaultWh;
    if (!orgId || !whId) {
      return {
        ok: false,
        error: 'no_org_warehouse',
        message: 'Укажите организацию и склад',
      };
    }

    const supplierRow = await loadSupplierForProfile(sid, pid);
    if (!supplierRow) {
      return { ok: false, error: 'supplier_not_found', message: 'Поставщик не найден' };
    }
    const supplierApiConfig = parseApiConfig(supplierRow.api_config);

    const purchaseItems = [];
    const procurementItems = [];
    const seenProc = new Set();
    let maxDeliveryDays = 0;

    for (const req of requested) {
      const lineKey = String(req.lineKey || '').trim();
      const line = lineByKey.get(lineKey);
      if (!line) {
        return { ok: false, error: 'line_not_found', message: `Позиция не найдена: ${lineKey}` };
      }
      const qty = Math.max(1, parseInt(req.quantity, 10) || line.deficit || 1);
      if (line.deficit <= 0) {
        return {
          ok: false,
          error: 'no_deficit',
          message: `Позиция ${line.productSku || line.productName} уже покрыта`,
        };
      }
      if (qty > line.deficit) {
        return {
          ok: false,
          error: 'qty_exceeds_deficit',
          message: `Количество по ${line.productSku || line.productName} больше дефицита (${line.deficit})`,
        };
      }

      const priceRes = await query(
        `SELECT price, COALESCE(delivery_days, 0)::int AS delivery_days
         FROM supplier_stocks WHERE supplier_id = $1 AND product_id = $2`,
        [sid, line.productId]
      );
      const price = priceRes.rows?.[0]?.price != null ? Number(priceRes.rows[0].price) : null;
      maxDeliveryDays = Math.max(maxDeliveryDays, Number(priceRes.rows?.[0]?.delivery_days) || 0);

      purchaseItems.push({
        productId: line.productId,
        quantity: qty,
        sourceOrders: [{ marketplace: line.marketplace, orderId: line.orderId }],
        purchasePrice: price > 0 ? price : null,
        lineKey,
        line,
        qty,
      });

      const procKey = `${line.marketplace}|${line.orderId}`;
      if (!seenProc.has(procKey)) {
        seenProc.add(procKey);
        procurementItems.push({ marketplace: line.marketplace, orderId: line.orderId });
      }
    }

    const warehouseWeekendDays = await loadWarehouseWeekendDays(whId, pid);
    const dates = computeProcurementDates(
      supplierApiConfig,
      now,
      maxDeliveryDays,
      warehouseWeekendDays,
      supplierRow.code
    );
    const processedLines = [];

    const note = `${autoArrivalNoteText(dates.arrivalBucket)} · ручная закупка (${orderId})`;
    const payload = {
      procurementItems,
      items: purchaseItems.map((it) => ({
        productId: it.productId,
        quantity: it.quantity,
        sourceOrders: it.sourceOrders,
        purchasePrice: it.purchasePrice,
      })),
      note,
      supplierWarehouseName: dates.supplierWarehouseName,
    };

    const openId =
      existingPurchaseId != null && String(existingPurchaseId).trim() !== ''
        ? parseInt(existingPurchaseId, 10)
        : null;
    if (openId) {
      payload.existingPurchaseId = openId;
    } else {
      payload.supplierId = sid;
      payload.organizationId = orgId;
      payload.warehouseId = whId;
    }

    let purchaseId;
    let supplierSubmit = null;
    try {
      const result = await purchasesService.procureFromOrders(payload, {
        userId,
        profileId: pid,
        // Любой API-поставщик: при отказе — откат и заказы остаются «Новыми».
        submitToSupplier: true,
      });
      if (result?.rolledBack && !result?.purchaseId) {
        return {
          ok: false,
          error: 'supplier_submit_failed',
          message:
            result?.supplierSubmit?.message ||
            'Поставщик не принял заказ. Заказы оставлены в статусе «Новый» (см. уведомления).',
          supplierSubmit: result?.supplierSubmit ?? null,
        };
      }
      purchaseId = result?.purchaseId ?? openId;
      supplierSubmit = result?.supplierSubmit ?? null;
      if (purchaseId) {
        await updatePurchaseDates(purchaseId, {
          shipDate: dates.shipDate,
          plannedDeliveryDate: dates.plannedDeliveryDate,
          supplierWarehouseName: dates.supplierWarehouseName,
        });
      }
    } catch (e) {
      return {
        ok: false,
        error: 'procure_failed',
        message:
          e?.message || 'Не удалось оформить закупку',
      };
    }

    for (const it of purchaseItems) {
      const newPurchased = (it.line.quantityPurchased || 0) + it.qty;
      const status = fulfillmentLineStatusFromQuantities({
        need: it.line.quantityNeeded,
        reserved: it.line.quantityReserved,
        purchased: newPurchased,
        deficit: Math.max(0, it.line.quantityNeeded - it.line.quantityReserved - newPurchased),
        manual: false,
      });
      await upsertFulfillmentLine(null, {
        profileId: pid,
        orderDbId: it.line.orderDbId,
        marketplace: it.line.marketplace,
        orderId: it.line.orderId,
        lineKey: it.lineKey,
        productId: it.line.productId,
        kitProductId: it.line.kitProductId,
        quantityNeeded: it.line.quantityNeeded,
        quantityReserved: it.line.quantityReserved,
        quantityPurchased: newPurchased,
        purchaseItemId: null,
        status,
        manualReason: null,
      });
      processedLines.push({
        lineKey: it.lineKey,
        productId: it.line.productId,
        quantity: it.qty,
        status,
      });
    }

    let message = `Оформлена закупка №${purchaseId}`;
    if (supplierSubmit?.message) {
      message += `. ${supplierSubmit.message}`;
    }

    return {
      ok: true,
      message,
      purchaseId,
      supplierId: sid,
      supplierName: supplierRow.name,
      supplierSubmit,
      lines: processedLines,
    };
  }

  /**
   * Явная отправка открытых закупок заказа в API поставщика (кнопка у заказа).
   */
  async submitPurchasesToSupplierForOrder(
    marketplace,
    orderId,
    { profileId, userId = null, force = false } = {}
  ) {
    const pid = normalizeProfileId(profileId);
    const oid = String(orderId ?? '').trim();
    if (pid == null) {
      return { ok: false, error: 'no_profile', message: 'Профиль не определён' };
    }
    if (!oid) {
      return { ok: false, error: 'invalid_order', message: 'Не указан заказ' };
    }
    if (!repositoryFactory.isUsingPostgreSQL()) {
      return { ok: false, error: 'not_pg', message: 'Доступно только с PostgreSQL' };
    }

    const profilesRepo = repositoryFactory.getProfilesRepository?.();
    const profileRow =
      profilesRepo && typeof profilesRepo.findById === 'function'
        ? await profilesRepo.findById(pid)
        : null;
    if (!isProfileSupplierSyncEnabled(profileRow)) {
      return {
        ok: false,
        error: 'supplier_sync_disabled',
        message: 'Работа с поставщиками отключена для этого аккаунта',
      };
    }

    let openPurchases = await findOpenPurchasesForOrder(pid, marketplace, oid);
    let autoProcure = null;

    if (!openPurchases.length) {
      autoProcure = await this.runForMarketplaceOrder(marketplace, oid, {
        profileId: pid,
        userId,
      });
      if (!autoProcure?.ok) {
        return {
          ok: false,
          error: autoProcure?.error || 'procure_failed',
          message: autoProcure?.message || 'Не удалось создать закупку по заказу',
          procurement: autoProcure,
        };
      }
      openPurchases = await findOpenPurchasesForOrder(pid, marketplace, oid);
      if (!openPurchases.length) {
        if (autoProcure.reserveOnly) {
          return {
            ok: false,
            error: 'nothing_to_submit',
            message:
              autoProcure.message ||
              'Закупка не требуется — товар уже на складе, отправка поставщику не нужна',
            procurement: autoProcure,
          };
        }
        if (autoProcure.manualLines?.length) {
          return {
            ok: false,
            error: 'manual_required',
            message:
              autoProcure.message ||
              'Не удалось автоматически выбрать поставщика — требуется ручная закупка',
            procurement: autoProcure,
            manualLines: autoProcure.manualLines,
          };
        }
        return {
          ok: false,
          error: 'no_purchase',
          message:
            'Не удалось создать открытую закупку по заказу. Проверьте остатки у поставщиков или отправьте заказ в закупку вручную.',
          procurement: autoProcure,
        };
      }
    }

    const purchases = [];
    let anySubmitted = false;
    let anyAlreadySubmitted = false;
    let anyFailed = false;

    for (const row of openPurchases) {
      const purchaseId = Number(row.purchase_id);
      const supplierId = Number(row.supplier_id);
      if (!Number.isFinite(purchaseId) || !Number.isFinite(supplierId)) continue;

      const pre = await supplierPreSubmitRequired(supplierId, pid);
      if (!pre.required) {
        purchases.push({
          purchaseId,
          supplierId,
          supplierName: row.supplier_name,
          supplierSubmit: {
            submitted: false,
            skipped: true,
            reason: 'api_not_configured',
            message: 'У поставщика не настроен API-заказ',
          },
        });
        continue;
      }

      const supplierSubmit = await trySubmitPurchaseToSupplier({
        purchaseId,
        supplierId,
        profileId: pid,
        force: Boolean(force),
        orderScope: await buildOrderSupplierSubmitScope(pid, marketplace, oid),
      }).catch((e) => ({
        submitted: false,
        reason: 'submit_error',
        message: e?.message || String(e),
      }));

      if (supplierSubmit?.submitted) {
        anySubmitted = true;
      } else if (supplierSubmit?.skipped && supplierSubmit?.reason === 'already_submitted') {
        anyAlreadySubmitted = true;
      } else if (!supplierSubmit?.skipped) {
        anyFailed = true;
      }

      purchases.push({
        purchaseId,
        supplierId,
        supplierName: row.supplier_name,
        supplierSubmit,
      });
    }

    let procurementStatus = null;
    // В «В закупке» только после успешной отправки API-поставщику (или если API не требуется).
    const shouldMarkProcurement = anySubmitted || anyAlreadySubmitted;
    if (shouldMarkProcurement) {
      procurementStatus = await ensureOrdersMarkedInProcurement(pid, marketplace, oid, []);
    }

    if (!anySubmitted && !anyAlreadySubmitted && anyFailed) {
      const reason = purchases.find((p) => p.supplierSubmit?.message)?.supplierSubmit?.message;
      const failed = purchases.filter(
        (p) =>
          p.supplierSubmit &&
          !p.supplierSubmit.skipped &&
          !p.supplierSubmit.submitted &&
          p.supplierSubmit.reason !== 'already_submitted'
      );
      for (const p of failed) {
        await purchasesService
          .revertMarketplaceOrderFromPurchase(p.purchaseId, {
            marketplace,
            orderId: oid,
            profileId: pid,
          })
          .catch((e) => {
            logger.warn('[OrderProcurement] revert after submit_failed', {
              orderId: oid,
              purchaseId: p.purchaseId,
              message: e?.message || String(e),
            });
          });
      }
      await addRuntimeNotification({
        type: 'supplier_order_submit_failed',
        severity: 'error',
        source: 'supplier_order_placement',
        title: 'Заказы не отправлены поставщику',
        message: `${reason || 'Не удалось отправить заказ поставщику'}. Заказ ${oid} оставлен в статусе «Новый».`,
        meta: {
          url: '/orders?status=new',
          order_ids: [oid],
          purchase_ids: failed.map((p) => p.purchaseId),
        },
      }).catch(() => {});
      return {
        ok: false,
        error: 'submit_failed',
        message:
          (reason || 'Не удалось отправить заказ поставщику') +
          '. Заказ оставлен в статусе «Новый» (см. уведомления).',
        purchases,
      };
    }

    if (!anySubmitted && !anyAlreadySubmitted) {
      const reason = purchases.find((p) => p.supplierSubmit?.message)?.supplierSubmit?.message;
      return {
        ok: false,
        error: 'nothing_submitted',
        message:
          reason ||
          'Заказ не отправлен поставщику: уже был отправлен или API не настроен',
        purchases,
      };
    }

    const ids = purchases.map((p) => p.purchaseId).filter(Boolean);
    let message;
    if (anySubmitted) {
      message = `Заказ ${oid} отправлен поставщику (локальная закупка №${ids.join(', №')})`;
    } else {
      message = `Заказ ${oid} уже был отправлен поставщику (локальная закупка №${ids.join(', №')})`;
    }
    if (autoProcure?.purchases?.length) {
      const createdIds = autoProcure.purchases.map((p) => p.purchaseId).filter(Boolean);
      if (createdIds.length) {
        message = `Создана закупка №${createdIds.join(', №')}. ${message}`;
      }
    }
    const submitMsg = purchases.find((p) => p.supplierSubmit?.message)?.supplierSubmit?.message;
    if (submitMsg && !message.includes(submitMsg)) {
      message += `. ${submitMsg}`;
    }
    if (procurementStatus?.updated > 0) {
      message += '. Статус заказа: В закупке';
    }

    return { ok: true, message, purchases, procurementStatus };
  }
}

export default new OrderProcurementPlannerService();
