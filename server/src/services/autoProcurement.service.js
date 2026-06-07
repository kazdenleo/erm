/**
 * Автозакупка: позиции в открытые закупки по поставщику и bucket приезда (сегодня / завтра).
 */

import { query, transaction } from '../config/database.js';
import repositoryFactory from '../config/repository-factory.js';
import purchasesService from './purchases.service.js';
import logger from '../utils/logger.js';
import { autoOrderSettingsFromApiConfig } from '../utils/supplierAutoOrderSettings.js';
import {
  autoArrivalNoteMarker,
  autoArrivalNoteText,
  parseArrivalBucketFromPurchaseNote,
  resolveProcurementArrivalBucketFromApiConfig,
} from '../utils/supplierProcurementArrival.js';
import { loadWarehouseWeekendDays } from '../utils/warehouseProcurementCalendar.js';

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

async function orderAlreadyInOpenPurchase(client, profileId, marketplace, orderId) {
  const dbMp = orderMarketplaceToDb(marketplace);
  const oid = String(orderId ?? '').trim();
  if (!dbMp || !oid) return false;
  const r = await client.query(
    `SELECT 1
     FROM purchase_items pi
     INNER JOIN purchases p ON p.id = pi.purchase_id
     CROSS JOIN LATERAL jsonb_array_elements(COALESCE(pi.source_orders, '[]'::jsonb)) AS elem
     WHERE p.profile_id = $1
       AND p.status = 'open'
       AND elem->>'orderId' = $3
       AND (
         CASE
           WHEN LOWER(COALESCE(elem->>'marketplace', '')) IN ('wb', 'wildberries') THEN 'wb'
           WHEN LOWER(COALESCE(elem->>'marketplace', '')) IN ('ym', 'yandex', 'yandexmarket') THEN 'ym'
           WHEN LOWER(COALESCE(elem->>'marketplace', '')) = 'manual' THEN 'manual'
           ELSE 'ozon'
         END
       ) = $2
     LIMIT 1`,
    [profileId, dbMp, oid]
  );
  return (r.rows?.length ?? 0) > 0;
}

async function findOpenAutoPurchaseId(client, { profileId, supplierId, arrivalBucket }) {
  const marker = `${autoArrivalNoteMarker(arrivalBucket)}%`;
  const r = await client.query(
    `SELECT id, note
     FROM purchases
     WHERE profile_id = $1
       AND supplier_id = $2
       AND status = 'open'
       AND note LIKE $3
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
    [profileId, supplierId, marker]
  );
  const row = r.rows?.[0];
  if (!row) return null;
  const parsed = parseArrivalBucketFromPurchaseNote(row.note);
  if (parsed && parsed !== arrivalBucket) return null;
  return Number(row.id);
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

async function pickSupplierForProduct(productId, autoSuppliers) {
  const ids = autoSuppliers.map((s) => s.id);
  if (!ids.length) return null;
  const r = await query(
    `SELECT ss.supplier_id, ss.price, ss.stock,
            COALESCE((s.api_config->>'isPriority')::boolean, (s.api_config->>'is_priority')::boolean, false) AS is_priority
     FROM supplier_stocks ss
     INNER JOIN suppliers s ON s.id = ss.supplier_id
     WHERE ss.product_id = $1
       AND ss.supplier_id = ANY($2::bigint[])
     ORDER BY
       CASE WHEN COALESCE((s.api_config->>'isPriority')::boolean, (s.api_config->>'is_priority')::boolean, false)
         THEN 0 ELSE 1 END,
       ss.price ASC NULLS LAST,
       ss.stock DESC NULLS LAST
     LIMIT 1`,
    [productId, ids]
  );
  const row = r.rows?.[0];
  if (!row) return null;
  const sid = Number(row.supplier_id);
  return autoSuppliers.find((s) => s.id === sid) || { id: sid };
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
  { profileId, userId, organizationId, warehouseId, manualTest = false, now = new Date() }
) {
  if (!g?.items?.length) {
    return { ok: false, error: 'no_items', message: 'Нет позиций для закупки' };
  }

  let purchaseId = await transaction(async (client) =>
    findOpenAutoPurchaseId(client, {
      profileId,
      supplierId: g.supplierId,
      arrivalBucket: g.arrivalBucket,
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
  });

  return {
    ok: true,
    purchaseId: result?.purchaseId ?? purchaseId ?? null,
    procurement: result?.procurement ?? null,
    appendedToExisting: Boolean(purchaseId),
    arrivalBucket: g.arrivalBucket,
  };
}

class AutoProcurementService {
  /**
   * Прогон автозакупки для одного профиля.
   * @returns {Promise<{ groups: number, purchases: number, items: number, skipped: number }>}
   */
  async runForProfile(profileId, { userId = null, now = new Date() } = {}) {
    const pid = normalizeProfileId(profileId);
    if (pid == null) {
      return { groups: 0, purchases: 0, items: 0, skipped: 0, error: 'no_profile' };
    }
    if (!repositoryFactory.isUsingPostgreSQL()) {
      return { groups: 0, purchases: 0, items: 0, skipped: 0, error: 'not_pg' };
    }

    const autoSuppliers = await loadAutoSuppliers(pid);
    if (!autoSuppliers.length) {
      return { groups: 0, purchases: 0, items: 0, skipped: 0, suppliers: 0 };
    }

    const { organizationId, warehouseId } = await resolveDefaultOrgAndWarehouse(pid);
    if (!organizationId || !warehouseId) {
      logger.warn('[AutoProcurement] skip profile: no org/warehouse', { profileId: pid });
      return { groups: 0, purchases: 0, items: 0, skipped: 0, error: 'no_org_warehouse' };
    }
    const warehouseWeekendDays = await loadWarehouseWeekendDays(warehouseId, pid);

    const ordersRes = await query(
      `SELECT o.id, o.marketplace, o.order_id, o.product_id, o.quantity, o.status
       FROM orders o
       WHERE o.profile_id = $1
         AND o.product_id IS NOT NULL
         AND ${ELIGIBLE_STATUS_SQL}
       ORDER BY o.created_at ASC NULLS LAST, o.id ASC`,
      [pid]
    );

    const groups = new Map();
    let skipped = 0;

    await transaction(async (client) => {
      for (const row of ordersRes.rows || []) {
        const productId = Number(row.product_id);
        if (!Number.isFinite(productId) || productId < 1) {
          skipped += 1;
          continue;
        }
        const mp = row.marketplace;
        const orderId = row.order_id;
        if (await orderAlreadyInOpenPurchase(client, pid, mp, orderId)) {
          skipped += 1;
          continue;
        }

        const supplier = await pickSupplierForProduct(productId, autoSuppliers);
        if (!supplier) {
          skipped += 1;
          continue;
        }

        const arrivalBucket = resolveProcurementArrivalBucketFromApiConfig(
          supplier.apiConfig,
          now,
          warehouseWeekendDays
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
        const qty = Math.max(1, parseInt(row.quantity, 10) || 1);
        const procKey = `${mp}|${orderId}`;
        if (!g.seenProc.has(procKey)) {
          g.seenProc.add(procKey);
          g.procurementItems.push({ marketplace: mp, orderId });
        }
        const existing = g.items.find((it) => it.productId === productId);
        if (existing) {
          existing.quantity += qty;
          existing.sourceOrders.push({ marketplace: mp, orderId });
        } else {
          g.items.push({
            productId,
            quantity: qty,
            sourceOrders: [{ marketplace: mp, orderId }],
          });
        }
      }
    });

    let purchasesTouched = 0;
    let itemsAdded = 0;

    for (const g of groups.values()) {
      if (!g.items.length) continue;

      let purchaseId = await transaction(async (client) =>
        findOpenAutoPurchaseId(client, {
          profileId: pid,
          supplierId: g.supplierId,
          arrivalBucket: g.arrivalBucket,
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
        });
        if (result?.purchaseId) purchasesTouched += 1;
        itemsAdded += g.items.length;
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

    return {
      groups: groups.size,
      purchases: purchasesTouched,
      items: itemsAdded,
      skipped,
      suppliers: autoSuppliers.length,
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
        if (await orderAlreadyInOpenPurchase(client, pid, mp, oid)) {
          skippedAlreadyInPurchase += 1;
          continue;
        }

        const picked = await pickSupplierForProduct(productId, suppliers);
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

        const qty = Math.max(1, parseInt(row.quantity, 10) || 1);
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
      warehouseWeekendDays
    );
    const procResult = await procureGroupForSupplierOrder(
      {
        supplierId: supplier.id,
        arrivalBucket,
        minOrderAmount: supplierRow.minOrderAmount,
        items,
        procurementItems,
      },
      { profileId: pid, userId, organizationId, warehouseId, manualTest, now }
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
