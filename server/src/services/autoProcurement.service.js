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
import {
  autoArrivalNoteText,
  resolveProcurementArrivalBucketFromApiConfig,
} from '../utils/supplierProcurementArrival.js';
import { findOpenAutoPurchaseId } from '../utils/openPurchaseLookup.js';
import { loadWarehouseWeekendDays } from '../utils/warehouseProcurementCalendar.js';
import { computeProcurementDeficit } from '../utils/orderProcurementCoverage.js';
import { isProfileSupplierSyncEnabled } from '../utils/profileSupplierSync.js';
import { isKitProductId, getKitComponents } from './kitStock.service.js';
import {
  supplierPreSubmitRequired,
  trySubmitPurchaseToSupplier,
} from './supplierOrderPlacement.service.js';
import { runSchedulerDbJob } from '../utils/schedulerDbMutex.js';

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
       AND p.status = 'open'
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

/** Сколько уже в открытых закупках по заказу и товару (антидубль автозакупки). */
async function purchasedQtyInOpenPurchases(profileId, orderDbId, productId) {
  const oid = Number(orderDbId);
  const pid = Number(productId);
  if (!Number.isFinite(oid) || oid < 1 || !Number.isFinite(pid) || pid < 1) return 0;
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
    [profileId, oid, pid]
  );
  return Math.max(0, Number(r.rows?.[0]?.qty) || 0);
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

async function pickSupplierForProduct(productId, autoSuppliers, qty = 1) {
  const ids = autoSuppliers.map((s) => s.id);
  if (!ids.length) return null;
  const need = Math.max(1, Math.floor(Number(qty) || 1));
  const r = await query(
    `SELECT ss.supplier_id, ss.price, ss.stock,
            COALESCE((s.api_config->>'isPriority')::boolean, (s.api_config->>'is_priority')::boolean, false) AS is_priority
     FROM supplier_stocks ss
     INNER JOIN suppliers s ON s.id = ss.supplier_id
     WHERE ss.product_id = $1
       AND ss.supplier_id = ANY($2::bigint[])
       AND ss.stock IS NOT NULL
       AND ss.stock >= $3
     ORDER BY ss.price ASC NULLS LAST,
              COALESCE(ss.delivery_days, 999) ASC,
              CASE WHEN COALESCE((s.api_config->>'isPriority')::boolean, (s.api_config->>'is_priority')::boolean, false)
                THEN 0 ELSE 1 END,
              ss.stock DESC NULLS LAST
     LIMIT 1`,
    [productId, ids, need]
  );
  const row = r.rows?.[0];
  if (!row) return null;
  const sid = Number(row.supplier_id);
  return autoSuppliers.find((s) => s.id === sid) || { id: sid };
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
async function expandDemandForOrderRow(row, autoSuppliers) {
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
    const whole = await pickSupplierForProduct(productId, autoSuppliers, qty);
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
    } else if (out?.reason && out.reason !== 'already_submitted' && !out?.skipped) {
      logger.warn('[AutoProcurement] retry submit failed', {
        profileId,
        purchaseId,
        supplierId,
        reason: out.reason,
        message: out.message,
      });
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

function groupKey(supplierId, arrivalBucket) {
  return `${supplierId}|${arrivalBucket}`;
}

async function loadOrderRowsForSupplierOrder(profileId, marketplace, orderId) {
  const dbMp = orderMarketplaceToDb(marketplace);
  const oid = String(orderId ?? '').trim();
  if (!dbMp || !oid) return [];

  const head = await query(
    `SELECT o.id, o.marketplace, o.order_id, o.order_group_id, o.product_id, o.quantity, o.status
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
      `SELECT o.id, o.marketplace, o.order_id, o.order_group_id, o.product_id, o.quantity, o.status
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
      now,
      warehouseWeekendDays,
    })
  );

  if (!manualTest && !purchaseId && g.minOrderAmount != null) {
    const est = await transaction(async (client) => {
      let sum = 0;
      for (const it of g.items) {
        const pr = await client.query(
          `SELECT price FROM supplier_stocks WHERE supplier_id = $1 AND product_id = $2`,
          [g.supplierId, it.productId]
        );
        const price = pr.rows?.[0]?.price != null ? Number(pr.rows[0].price) : 0;
        if (price > 0) sum += price * it.quantity;
      }
      return sum;
    });
    if (est < g.minOrderAmount) {
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
    appendedToExisting: Boolean(purchaseId),
    arrivalBucket: g.arrivalBucket,
  };
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

    const { organizationId, warehouseId } = await resolveDefaultOrgAndWarehouse(pid);
    if (!organizationId || !warehouseId) {
      logger.warn('[AutoProcurement] skip profile: no org/warehouse', { profileId: pid });
      return { groups: 0, purchases: 0, items: 0, skipped: 0, submitted: 0, error: 'no_org_warehouse' };
    }
    const warehouseWeekendDays = await loadWarehouseWeekendDays(warehouseId, pid);

    const ordersRes = await query(
      `SELECT o.id, o.marketplace, o.order_id, o.order_group_id, o.product_id, o.quantity, o.status,
              o.offer_id, o.marketplace_sku, o.product_name, o.profile_id, o.warehouse_id
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

      const demandLines = await expandDemandForOrderRow(resolvedRow, autoSuppliers);
      if (!demandLines.length) {
        skipped += 1;
        continue;
      }

      let anyAdded = false;
      for (const line of demandLines) {
        const deficit = await deficitQtyForDemandLine(line, pid);
        if (deficit <= 0) continue;

        const supplier = await pickSupplierForProduct(line.productId, autoSuppliers, deficit);
        if (!supplier) {
          skipped += 1;
          continue;
        }

        const arrivalBucket = resolveProcurementArrivalBucketFromApiConfig(
          supplier.apiConfig,
          now,
          warehouseWeekendDays,
          supplier.code
        );
        const key = groupKey(supplier.id, arrivalBucket);
        if (!groups.has(key)) {
          groups.set(key, {
            supplierId: supplier.id,
            arrivalBucket,
            minOrderAmount: supplier.minOrderAmount,
            items: [],
            procurementItems: [],
            seenProc: new Set(),
          });
        }
        const g = groups.get(key);
        const procKey = `${mp}|${orderId}`;
        if (!g.seenProc.has(procKey)) {
          g.seenProc.add(procKey);
          g.procurementItems.push({ marketplace: mp, orderId });
        }
        const existing = g.items.find((it) => it.productId === line.productId);
        if (existing) {
          existing.quantity += deficit;
          existing.sourceOrders.push({ marketplace: mp, orderId });
        } else {
          g.items.push({
            productId: line.productId,
            quantity: deficit,
            sourceOrders: [{ marketplace: mp, orderId }],
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
          now,
          warehouseWeekendDays,
        })
      );

      if (!purchaseId && g.minOrderAmount != null) {
        const est = await transaction(async (client) => {
          let sum = 0;
          for (const it of g.items) {
            const pr = await client.query(
              `SELECT price FROM supplier_stocks WHERE supplier_id = $1 AND product_id = $2`,
              [g.supplierId, it.productId]
            );
            const price = pr.rows?.[0]?.price != null ? Number(pr.rows[0].price) : 0;
            if (price > 0) sum += price * it.quantity;
          }
          return sum;
        });
        if (est < g.minOrderAmount) {
          logger.info('[AutoProcurement] skip new purchase: below minOrderAmount', {
            supplierId: g.supplierId,
            bucket: g.arrivalBucket,
            est,
            min: g.minOrderAmount,
          });
          skipped += g.items.length;
          continue;
        }
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
        payload.organizationId = organizationId;
        payload.warehouseId = warehouseId;
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
          });
        }
      } catch (e) {
        logger.warn('[AutoProcurement] procure failed', {
          profileId: pid,
          supplierId: g.supplierId,
          bucket: g.arrivalBucket,
          message: e?.message || String(e),
        });
        skipped += g.items.length;
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

    const { organizationId, warehouseId } = await resolveDefaultOrgAndWarehouse(pid);
    if (!organizationId || !warehouseId) {
      return {
        ok: false,
        error: 'no_org_warehouse',
        message: 'Укажите организацию и склад (хотя бы по одному на аккаунт)',
      };
    }
    const warehouseWeekendDays = await loadWarehouseWeekendDays(warehouseId, pid);

    const orderRows = await loadOrderRowsForSupplierOrder(pid, marketplace, orderId);
    if (!orderRows.length) {
      return { ok: false, error: 'order_not_found', message: 'Заказ не найден' };
    }

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

        const picked = await pickSupplierForProduct(productId, suppliers, qty);
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
          existing.sourceOrders.push({ marketplace: mp, orderId: oid });
        } else {
          items.push({
            productId,
            quantity: qty,
            sourceOrders: [{ marketplace: mp, orderId: oid }],
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
