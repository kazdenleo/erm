/**
 * Планировщик закупок по заказу: резерв (склад + в пути) → закупка дефицита у поставщика.
 */

import { query, transaction } from '../config/database.js';
import repositoryFactory from '../config/repository-factory.js';
import ordersService from './orders.service.js';
import purchasesService from './purchases.service.js';
import logger from '../utils/logger.js';
import { isProfileSupplierSyncEnabled } from '../utils/profileSupplierSync.js';
import { autoOrderSettingsFromApiConfig } from '../utils/supplierAutoOrderSettings.js';
import {
  autoArrivalNoteText,
  computeProcurementDates,
  resolveProcurementArrivalBucketFromApiConfig,
} from '../utils/supplierProcurementArrival.js';
import {
  computeProcurementDeficit,
  fulfillmentLineStatusFromQuantities,
} from '../utils/orderProcurementCoverage.js';
import { isKitProductId, getKitComponents } from './kitStock.service.js';

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
            o.profile_id
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
              o.profile_id
       FROM orders o
       WHERE o.profile_id = $1 AND o.order_group_id = $2
       ORDER BY o.id ASC`,
      [profileId, gid]
    );
    return group.rows || [];
  }
  return [row];
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

async function rankSupplierCandidates(productId, suppliers, qty) {
  const ids = suppliers.map((s) => s.id);
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

  const supplierById = new Map(suppliers.map((s) => [s.id, s]));
  const out = [];
  for (const row of r.rows || []) {
    const sid = Number(row.supplier_id);
    const stock = row.stock != null ? Number(row.stock) : null;
    if (stock != null && Number.isFinite(stock) && stock < need) continue;
    const base = supplierById.get(sid);
    if (!base) continue;
    out.push({
      ...base,
      price: row.price != null ? Number(row.price) : null,
      stock,
      deliveryDays: Number(row.delivery_days) || 0,
      isPriority: Boolean(row.is_priority),
    });
  }
  out.sort((a, b) => {
    const pa = a.price != null ? a.price : Infinity;
    const pb = b.price != null ? b.price : Infinity;
    if (pa !== pb) return pa - pb;
    if (a.deliveryDays !== b.deliveryDays) return a.deliveryDays - b.deliveryDays;
    if (a.isPriority !== b.isPriority) return a.isPriority ? -1 : 1;
    return (a.warehousePriority || 999) - (b.warehousePriority || 999);
  });
  return out;
}

async function supplierHasKitStock(suppliers, kitProductId, qty) {
  const candidates = await rankSupplierCandidates(kitProductId, suppliers, qty);
  return candidates.length > 0 ? candidates[0] : null;
}

async function expandOrderRowToDemandLines(row, suppliers) {
  const productId = Number(row.product_id);
  const qty = Math.max(1, parseInt(row.quantity, 10) || 1);
  const orderDbId = Number(row.id);
  const marketplace = row.marketplace;
  const orderId = row.order_id;
  if (!Number.isFinite(productId) || productId < 1) return [];

  const base = { orderDbId, marketplace, orderId, orderRow: row };

  if (await isKitProductId(productId)) {
    const kitSupplier = await supplierHasKitStock(suppliers, productId, qty);
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

async function findOpenAutoPurchaseId(client, { profileId, supplierId, arrivalBucket }) {
  const marker = `[auto-arrival:${arrivalBucket}]%`;
  const r = await client.query(
    `SELECT id, note FROM purchases
     WHERE profile_id = $1 AND supplier_id = $2 AND status = 'open' AND note LIKE $3
     ORDER BY created_at DESC, id DESC LIMIT 1`,
    [profileId, supplierId, marker]
  );
  const row = r.rows?.[0];
  if (!row) return null;
  const note = String(row.note || '');
  if (!note.includes(`[auto-arrival:${arrivalBucket}]`)) return null;
  return Number(row.id);
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

async function pickSupplierForDeficit(productId, suppliers, qty, { client, profileId, supplierIdForOpen } = {}) {
  const candidates = await rankSupplierCandidates(productId, suppliers, qty);
  for (const cand of candidates) {
    const price = cand.price != null && cand.price > 0 ? cand.price : 0;
    const lineTotal = price * qty;
    const minOrder = cand.minOrderAmount;

    let openPurchaseId = null;
    let openTotal = 0;
    if (client && profileId) {
      const bucket = resolveProcurementArrivalBucketFromApiConfig(cand.apiConfig);
      openPurchaseId = await findOpenAutoPurchaseId(client, {
        profileId,
        supplierId: cand.id,
        arrivalBucket: bucket,
      });
      if (openPurchaseId) {
        openTotal = await sumOpenPurchaseTotal(client, openPurchaseId, cand.id);
      }
    }

    if (minOrder != null && minOrder > 0) {
      const projected = (openPurchaseId ? openTotal : 0) + lineTotal;
      if (projected < minOrder && !openPurchaseId) continue;
      if (projected < minOrder && openPurchaseId) {
        // Накопление в открытой закупке — допустимо
      }
    }

    if (cand.stock != null && cand.stock < qty) continue;

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
   * Отправить заказ в закупку: резерв → закупка дефицита.
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
    for (const row of eligibleRows) {
      const expanded = await expandOrderRowToDemandLines(row, suppliers);
      demandLines.push(...expanded);
      const procKey = `${row.marketplace}|${row.order_id}`;
      if (!seenProc.has(procKey)) {
        seenProc.add(procKey);
        procurementItems.push({ marketplace: row.marketplace, orderId: row.order_id });
      }
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
      const prevPurchased = Number(existing.rows?.[0]?.quantity_purchased) || 0;

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
        const dates = computeProcurementDates(supplier.apiConfig, now, supplier.deliveryDays);
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
        });
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
        for (const it of g.items) {
          const lr = lineResults.find(
            (x) => x.lineKey === it.lineKey && x.productId === it.productId
          );
          if (lr) {
            lr.status = 'manual_required';
            lr.manualReason = e?.message || 'Ошибка создания закупки';
            lr.purchased = it.coverage.purchased;
            lr.deficit = it.quantity;
          }
        }
      }
    }

    // 4) Сохранить строки без закупки (только резерв)
    for (const lr of lineResults) {
      if (lr.status === 'manual_required' && lr.deficit > 0) continue;
      const dl = demandLines.find((d) => d.lineKey === lr.lineKey);
      if (!dl) continue;
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
      return {
        ok: false,
        error: 'manual_required',
        message: 'Не удалось автоматически закупить позиции заказа',
        lines: lineResults,
        manualLines,
      };
    }

    const reserveOnly =
      lineResults.length > 0 &&
      lineResults.every((l) => l.deficit <= 0 && l.status !== 'manual_required');

    let message;
    if (reserveOnly) {
      message = `Зарезервировано ${totalReserved} шт. по заказу, закупка не требуется`;
    } else if (purchasesTouched.length) {
      const p = purchasesTouched[0];
      message =
        totalReserved > 0
          ? `Зарезервировано ${totalReserved} шт., закуплено ${totalPurchased} шт. (закупка №${p.purchaseId})`
          : `Закуплено ${totalPurchased} шт. (закупка №${p.purchaseId})`;
    } else {
      message = 'Обработка заказа завершена';
    }

    if (manualLines.length) {
      message += `. Требуется ручной выбор поставщика: ${manualLines.length} поз.`;
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

    const r = await query(
      `SELECT fl.*,
              p.name AS product_name,
              p.sku AS product_sku,
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
      const coverage = computeProcurementDeficit({
        quantityNeeded,
        quantityReserved: reservedNow,
        quantityPurchased,
      });

      if (!includeAll && coverage.deficit <= 0) continue;

      const suppliers = await loadSuppliersForWarehouse(pid, orderWarehouseId);
      const suggestedSuppliers = await rankSupplierCandidates(
        productId,
        suppliers,
        coverage.deficit || 1
      );

      lines.push({
        lineKey: row.line_key,
        orderDbId,
        marketplace: row.marketplace,
        orderId: row.order_id,
        productId,
        productName: row.product_name,
        productSku: row.product_sku,
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

    const supplierRes = await query(
      `SELECT id, name, api_config FROM suppliers WHERE id = $1 AND profile_id = $2`,
      [sid, pid]
    );
    const supplierRow = supplierRes.rows?.[0];
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

    const dates = computeProcurementDates(supplierApiConfig, now, maxDeliveryDays);
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
    try {
      const result = await purchasesService.procureFromOrders(payload, {
        userId,
        profileId: pid,
      });
      purchaseId = result?.purchaseId ?? openId;
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
        message: e?.message || 'Не удалось создать закупку',
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

    return {
      ok: true,
      message: `Ручная закупка оформлена (закупка №${purchaseId})`,
      purchaseId,
      supplierId: sid,
      supplierName: supplierRow.name,
      lines: processedLines,
    };
  }
}

export default new OrderProcurementPlannerService();
