/**
 * Инвентаризация: список документов и атомарное применение пересчёта
 */

import { query, transaction } from '../config/database.js';
import stockMovementsRepositoryPG from '../repositories/stock_movements.repository.pg.js';
import { runWithDbRetry } from '../utils/dbRetry.js';
import logger from '../utils/logger.js';

/** Инвентаризация: много строк FOR UPDATE — дольше обычных транзакций. */
const INVENTORY_TX_OPTS = { lockTimeoutMs: 120000, statementTimeoutMs: 600000 };

/** Ключ advisory xact_lock по складу (не пересекается с product_id > 0). */
function inventoryWarehouseLockKey(whId) {
  return -1_000_000_000 - Math.abs(Number(whId) || 0);
}

function normalizeProfileId(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'string' ? parseInt(v, 10) : Number(v);
  return Number.isNaN(n) ? null : n;
}

async function assertProductAllowedInProfile(client, productId, profileId) {
  const pid = normalizeProfileId(profileId);
  if (pid == null) return;
  const res = await client.query(
    `SELECT 1 FROM products p
     WHERE p.id = $1
       AND p.profile_id = $2::bigint`,
    [productId, pid]
  );
  if (!res.rows?.length) {
    const err = new Error('Товар недоступен в вашем аккаунте');
    err.statusCode = 403;
    throw err;
  }
}

/** Склад инвентаризации обязателен (без подстановки «первого попавшегося»). */
async function requireInventoryWarehouseId(client, warehouseId) {
  let wid =
    warehouseId != null && warehouseId !== ''
      ? typeof warehouseId === 'string'
        ? parseInt(warehouseId, 10)
        : Number(warehouseId)
      : null;
  if (wid == null || Number.isNaN(wid) || wid < 1) {
    const err = new Error('Укажите склад инвентаризации');
    err.statusCode = 400;
    throw err;
  }
  const ok = await client.query(
    `SELECT id FROM warehouses WHERE id = $1 AND type = 'warehouse' AND supplier_id IS NULL`,
    [wid]
  );
  if (!ok.rows?.length) {
    const err = new Error('Склад не найден или недоступен для инвентаризации');
    err.statusCode = 400;
    throw err;
  }
  return wid;
}

async function getPwsQuantity(client, productId, whId) {
  // Без FOR UPDATE: на складе уже pg_advisory_xact_lock — меньше deadlock с резервом по заказам.
  const pwsRow = await client.query(
    `SELECT quantity FROM product_warehouse_stock WHERE product_id = $1 AND warehouse_id = $2`,
    [productId, whId]
  );
  return pwsRow.rows?.[0] ? Number(pwsRow.rows[0].quantity) : 0;
}

async function setPwsQuantity(client, productId, whId, quantity) {
  await client.query(
    `INSERT INTO product_warehouse_stock (product_id, warehouse_id, quantity)
     VALUES ($1, $2, $3)
     ON CONFLICT (product_id, warehouse_id) DO UPDATE SET quantity = EXCLUDED.quantity`,
    [productId, whId, quantity]
  );
}

/** Нормализация списка ID категорий из body / БД. */
function normalizeCategoryIds(raw) {
  if (raw == null || raw === '') return [];
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? (() => {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return String(raw).split(',');
    }
  })() : [];
  const out = [];
  const seen = new Set();
  for (const x of list) {
    const n = typeof x === 'string' ? parseInt(x, 10) : Number(x);
    if (!Number.isFinite(n) || n < 1 || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

/**
 * Выбранные категории + все потомки по parent_id (в рамках профиля).
 * @returns {Promise<number[]>}
 */
async function expandCategoryIds(client, profileId, categoryIds) {
  const roots = normalizeCategoryIds(categoryIds);
  if (roots.length === 0) return [];
  const pid = normalizeProfileId(profileId);
  const res = await client.query(
    `WITH RECURSIVE tree AS (
       SELECT id, parent_id
       FROM user_categories
       WHERE id = ANY($1::bigint[])
         AND ($2::bigint IS NULL OR profile_id = $2::bigint)
       UNION ALL
       SELECT c.id, c.parent_id
       FROM user_categories c
       INNER JOIN tree t ON c.parent_id = t.id
       WHERE ($2::bigint IS NULL OR c.profile_id = $2::bigint)
     )
     SELECT DISTINCT id FROM tree`,
    [roots, pid]
  );
  return (res.rows || [])
    .map((r) => Number(r.id))
    .filter((n) => Number.isFinite(n) && n > 0);
}

/** Позиции с остатком на складе, не попавшие в пересчёт (опционально — только выбранные категории). */
async function findUnlistedWithStock(client, whId, profileId, listedIds, categoryIds = null) {
  const pid = normalizeProfileId(profileId);
  const ids = [...listedIds]
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id) && id > 0);
  const catIds = Array.isArray(categoryIds)
    ? categoryIds.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0)
    : [];
  const hasCats = catIds.length > 0;
  const res = await client.query(
    `SELECT pws.product_id, pws.quantity,
            p.sku, p.name, p.cost, p.user_category_id,
            c.name AS category_name
     FROM product_warehouse_stock pws
     INNER JOIN products p ON p.id = pws.product_id
     LEFT JOIN user_categories c ON c.id = p.user_category_id
     WHERE pws.warehouse_id = $1 AND pws.quantity > 0
       AND ($2::bigint IS NULL OR p.profile_id = $2::bigint)
       AND (CARDINALITY($3::bigint[]) = 0 OR NOT (pws.product_id = ANY($3::bigint[])))
       AND ($4::bigint[] IS NULL OR p.user_category_id = ANY($4::bigint[]))
     ORDER BY c.name NULLS LAST, p.sku NULLS LAST, p.id
     LIMIT 5000`,
    [whId, pid, ids, hasCats ? catIds : null]
  );
  return res.rows || [];
}

/** Если задан scope категорий — все товары в lines должны в него входить. */
async function assertProductsInCategoryScope(client, profileId, productIds, expandedCategoryIds) {
  const cats = Array.isArray(expandedCategoryIds) ? expandedCategoryIds : [];
  if (cats.length === 0) return;
  const ids = [...new Set(
    (productIds || [])
      .map((x) => Number(x))
      .filter((n) => Number.isFinite(n) && n > 0)
  )];
  if (ids.length === 0) return;
  const res = await client.query(
    `SELECT p.id, p.sku, p.user_category_id
     FROM products p
     WHERE p.id = ANY($1::bigint[])
       AND (
         p.user_category_id IS NULL
         OR NOT (p.user_category_id = ANY($2::bigint[]))
       )
       AND ($3::bigint IS NULL OR p.profile_id = $3::bigint)`,
    [ids, cats, normalizeProfileId(profileId)]
  );
  const bad = res.rows || [];
  if (bad.length === 0) return;
  const sample = bad.slice(0, 3).map((r) => r.sku || `#${r.id}`).join(', ');
  const err = new Error(
    bad.length === 1
      ? `Товар ${sample} не из выбранных категорий инвентаризации`
      : `Товары не из выбранных категорий инвентаризации: ${sample}${bad.length > 3 ? '…' : ''}`
  );
  err.statusCode = 400;
  throw err;
}

function parseLineProductId(raw) {
  const v = raw?.productId ?? raw?.product_id;
  if (v == null || v === '') return null;
  const n = typeof v === 'string' ? parseInt(v, 10) : Number(v);
  return Number.isNaN(n) || n < 1 ? null : n;
}

function parseLineQuantityAfter(raw) {
  const v = raw?.quantityAfter ?? raw?.quantity_after;
  if (v == null || v === '') return 0;
  const n = typeof v === 'string' ? parseInt(v, 10) : Number(v);
  return Number.isNaN(n) || n < 0 ? 0 : n;
}

/** Слияние дублей product_id: берём максимальный quantityAfter. */
function mergeInventoryLinesInput(linesInput) {
  const merged = new Map();
  for (const raw of linesInput || []) {
    const productId = parseLineProductId(raw);
    const quantityAfter = parseLineQuantityAfter(raw);
    if (!productId) continue;
    merged.set(productId, Math.max(merged.get(productId) ?? -1, quantityAfter));
  }
  return [...merged.entries()].map(([productId, quantityAfter]) => ({ productId, quantityAfter }));
}

async function applyInventoryLine(client, {
  sessionId,
  productId,
  quantityAfter,
  whId,
  profileId,
  reasonBase,
  lineReasonSuffix = null,
}) {
  await assertProductAllowedInProfile(client, productId, profileId);

  const { isKitProductId } = await import('./kitStock.service.js');
  const isKit = await isKitProductId(productId);

  const before = await getPwsQuantity(client, productId, whId);

  await client.query(
    `INSERT INTO inventory_session_lines (session_id, product_id, quantity_before, quantity_after)
     VALUES ($1, $2, $3, $4)`,
    [sessionId, productId, before, quantityAfter]
  );

  if (before === quantityAfter) {
    return { applied: false, productId, counted: true };
  }

  await setPwsQuantity(client, productId, whId, quantityAfter);

  const delta = quantityAfter - before;
  const reason = lineReasonSuffix ? `${reasonBase}: ${lineReasonSuffix}` : reasonBase;
  const unlistedZero = Boolean(lineReasonSuffix && String(lineReasonSuffix).includes('не пересчитан'));
  await stockMovementsRepositoryPG.insertSnapshotAfterProduct(client, {
    productId,
    type: 'inventory',
    quantityChange: delta,
    reason,
    meta: {
      inventory_session_id: sessionId,
      warehouse_id: whId,
      ...(unlistedZero ? { unlisted_zero: true } : {}),
      ...(isKit ? { kit_inventory: true } : {}),
    },
    warehouseId: whId,
    profileId: null,
    skipReservedQtySync: true,
  });

  return { applied: true, productId, counted: true };
}

/**
 * Редактирование инвентаризации: нетто-изменение от текущего остатка, одна запись в журнале на позицию.
 */
async function applyInventoryEditLine(client, {
  sessionId,
  productId,
  quantityAfter,
  whId,
  profileId,
  sessionIdLabel,
  previousFactAfter = null,
}) {
  await assertProductAllowedInProfile(client, productId, profileId);

  const { isKitProductId } = await import('./kitStock.service.js');
  const isKit = await isKitProductId(productId);

  const currentPws = await getPwsQuantity(client, productId, whId);
  const newAfter = Math.max(0, parseInt(quantityAfter, 10) || 0);
  const prevFact =
    previousFactAfter != null && previousFactAfter !== ''
      ? Math.max(0, Number(previousFactAfter) || 0)
      : currentPws;

  await client.query(
    `INSERT INTO inventory_session_lines (session_id, product_id, quantity_before, quantity_after)
     VALUES ($1, $2, $3, $4)`,
    [sessionId, productId, currentPws, newAfter]
  );

  if (currentPws === newAfter) {
    return { applied: false, productId, counted: true };
  }

  await setPwsQuantity(client, productId, whId, newAfter);

  const delta = newAfter - currentPws;
  const reason = `Изменение инвентаризации №${sessionIdLabel}: ${prevFact} → ${newAfter}`;
  await stockMovementsRepositoryPG.insertSnapshotAfterProduct(client, {
    productId,
    type: 'inventory',
    quantityChange: delta,
    reason,
    meta: {
      inventory_session_id: sessionId,
      inventory_edit: true,
      warehouse_id: whId,
      quantity_before: prevFact,
      quantity_after: newAfter,
      ...(isKit ? { kit_inventory: true } : {}),
    },
    warehouseId: whId,
    profileId: null,
    skipReservedQtySync: true,
  });

  return { applied: true, productId, counted: true };
}

async function runInventoryUpdateLines(client, {
  sessionId,
  whId,
  profileId,
  linesInput,
  zeroUnlisted,
  oldLines,
  expandedCategoryIds = null,
}) {
  const mergedLines = mergeInventoryLinesInput(linesInput);
  const oldFactByProduct = new Map();
  for (const line of oldLines || []) {
    const productId = parseInt(line.product_id, 10);
    if (!productId || Number.isNaN(productId)) continue;
    oldFactByProduct.set(productId, Math.max(0, Number(line.quantity_after) || 0));
  }

  const listedIds = new Set();
  let applied = 0;
  const affectedProductIds = new Set();

  const sortedLines = [...mergedLines].sort((a, b) => a.productId - b.productId);
  await assertProductsInCategoryScope(
    client,
    profileId,
    sortedLines.map((x) => x.productId),
    expandedCategoryIds
  );
  for (const { productId, quantityAfter } of sortedLines) {
    listedIds.add(productId);
    const { applied: lineApplied, productId: pid } = await applyInventoryEditLine(client, {
      sessionId,
      productId,
      quantityAfter,
      whId,
      profileId,
      sessionIdLabel: sessionId,
      previousFactAfter: oldFactByProduct.has(productId)
        ? oldFactByProduct.get(productId)
        : null,
    });
    if (lineApplied) applied++;
    if (pid) affectedProductIds.add(pid);
  }

  if (zeroUnlisted && listedIds.size > 0) {
    const unlisted = (await findUnlistedWithStock(client, whId, profileId, listedIds, expandedCategoryIds)).sort(
      (a, b) => Number(a.product_id) - Number(b.product_id)
    );
    for (const row of unlisted) {
      const productId = parseInt(row.product_id, 10);
      if (!productId || Number.isNaN(productId)) continue;
      const { applied: lineApplied, productId: pid } = await applyInventoryEditLine(client, {
        sessionId,
        productId,
        quantityAfter: 0,
        whId,
        profileId,
        sessionIdLabel: sessionId,
        previousFactAfter: oldFactByProduct.has(productId)
          ? oldFactByProduct.get(productId)
          : Math.max(0, Number(row.quantity) || 0),
      });
      if (lineApplied) applied++;
      if (pid) affectedProductIds.add(pid);
    }
  }

  return {
    applied,
    productIds: [...affectedProductIds],
  };
}

async function runInventoryLines(client, {
  sessionId,
  whId,
  profileId,
  linesInput,
  zeroUnlisted,
  reasonBase,
  expandedCategoryIds = null,
}) {
  const mergedLines = mergeInventoryLinesInput(linesInput);
  const listedIds = new Set();
  let applied = 0;
  const affectedProductIds = new Set();

  const sortedLines = [...mergedLines].sort((a, b) => {
    const pa = parseLineProductId(a) ?? 0;
    const pb = parseLineProductId(b) ?? 0;
    return pa - pb;
  });

  const productIdsForScope = [];
  for (const raw of sortedLines) {
    const productId = parseLineProductId(raw);
    if (productId) productIdsForScope.push(productId);
  }
  await assertProductsInCategoryScope(client, profileId, productIdsForScope, expandedCategoryIds);

  for (const raw of sortedLines) {
    const productId = parseLineProductId(raw);
    const quantityAfter = parseLineQuantityAfter(raw);
    if (!productId) continue;

    listedIds.add(productId);
    const { applied: lineApplied, productId: pid } = await applyInventoryLine(client, {
      sessionId,
      productId,
      quantityAfter,
      whId,
      profileId,
      reasonBase,
    });
    if (lineApplied) {
      applied++;
    }
    if (pid) {
      affectedProductIds.add(pid);
    }
  }

  // Без хотя бы одной пересчитанной позиции не обнуляем весь склад (защита от пустого/битого lines).
  if (zeroUnlisted && listedIds.size > 0) {
    const unlisted = (await findUnlistedWithStock(client, whId, profileId, listedIds, expandedCategoryIds)).sort(
      (a, b) => Number(a.product_id) - Number(b.product_id)
    );
    for (const row of unlisted) {
      const productId = parseInt(row.product_id, 10);
      if (!productId || Number.isNaN(productId)) continue;
      const { applied: lineApplied, productId: pid } = await applyInventoryLine(client, {
        sessionId,
        productId,
        quantityAfter: 0,
        whId,
        profileId,
        reasonBase,
        lineReasonSuffix: 'не пересчитан — списание до 0',
      });
      if (lineApplied) {
        applied++;
        affectedProductIds.add(pid);
      }
    }
  }

  return {
    applied,
    productIds: [...affectedProductIds],
  };
}

async function afterInventoryTouch(sessionId, productIds) {
  if (!sessionId || !Array.isArray(productIds) || productIds.length === 0) return;
  const ids = [...productIds];
  setImmediate(() => {
    afterInventoryTouchBackground(sessionId, ids).catch(() => {});
  });
}

/** Синхронизация products.quantity и резервов после успешной инвентаризации. */
async function syncProductsAfterInventory(sessionId, productIds) {
  if (!Array.isArray(productIds) || productIds.length === 0) return;
  const { syncProductQuantityFromWarehouseStock } =
    await import('./productWarehouseQuantity.service.js');
  const { syncProductReservedQuantityFromJournal } =
    await import('./sellableQuantity.service.js');
  const { scheduleWarehouseStockMarketplaceSync } = await import(
    './marketplaceWarehouseStockSync.service.js'
  );
  let whId = null;
  if (sessionId != null) {
    try {
      const pr = await query(`SELECT warehouse_id FROM inventory_sessions WHERE id = $1`, [sessionId]);
      whId = pr.rows?.[0]?.warehouse_id ?? null;
    } catch {
      whId = null;
    }
  }
  const unique = [...new Set(productIds.map((id) => Number(id)).filter((n) => Number.isFinite(n) && n > 0))];
  for (const pid of unique) {
    await syncProductQuantityFromWarehouseStock(pid);
    await syncProductReservedQuantityFromJournal(pid);
    scheduleWarehouseStockMarketplaceSync(pid, {
      source: 'inventory',
      warehouseId: whId,
      strictWarehouse: whId != null && String(whId).trim() !== '',
    });
  }
}

async function afterInventoryTouchBackground(sessionId, productIds) {
  try {
    const { default: ordersService } = await import('./orders.service.js');
    const { default: fboSupplyReserveService } = await import('./fboSupplyReserve.service.js');
    const { recalculateKitsForComponent } = await import('./kitStock.service.js');
    let profId = null;
    try {
      const pr = await query(`SELECT profile_id FROM inventory_sessions WHERE id = $1`, [sessionId]);
      profId = pr.rows?.[0]?.profile_id ?? null;
    } catch {
      profId = null;
    }
    const unique = [...new Set(productIds.map((id) => Number(id)).filter((n) => Number.isFinite(n) && n > 0))];
    for (const pid of unique) {
      await ordersService.trimExcessReservesForProduct(pid, {
        reason: `После инвентаризации №${sessionId}`,
        meta: { inventory_session_id: sessionId },
      });
      await ordersService.ensureReservesForProductIfSupplyAvailable(pid);
      await fboSupplyReserveService.onSupplyStockEvent(pid, null, { profileId: profId });
      await recalculateKitsForComponent(pid, {});
      try {
        const { scheduleWarehouseStockMarketplaceSync } = await import(
          './marketplaceWarehouseStockSync.service.js'
        );
        let whId = null;
        try {
          const pr = await query(`SELECT warehouse_id FROM inventory_sessions WHERE id = $1`, [
            sessionId,
          ]);
          whId = pr.rows?.[0]?.warehouse_id ?? null;
        } catch {
          whId = null;
        }
        scheduleWarehouseStockMarketplaceSync(pid, {
          source: 'inventory_background',
          warehouseId: whId,
          strictWarehouse: whId != null && String(whId).trim() !== '',
        });
      } catch {
        /* ignore */
      }
    }
    try {
      const parents = await query(
        `SELECT DISTINCT kit_product_id FROM kit_components WHERE component_product_id = ANY($1::bigint[])`,
        [unique]
      );
      for (const row of parents.rows || []) {
        const kid = Number(row.kit_product_id);
        if (!Number.isFinite(kid) || kid < 1) continue;
        await ordersService.trimExcessReservesForProduct(kid, {
          reason: `После инвентаризации №${sessionId} (комплект)`,
          meta: { inventory_session_id: sessionId, kit_parent_trim: true },
        });
      }
    } catch {
      /* ignore */
    }
  } catch (e) {
    logger.warn('[Inventory] afterInventoryTouchBackground failed', {
      sessionId,
      message: e?.message || String(e),
    });
  }
}

class InventorySessionsService {
  async list({ profileId, limit = 200 } = {}) {
    const lim = Math.min(Math.max(1, parseInt(limit, 10) || 200), 500);
    const pid = normalizeProfileId(profileId);
    const whLabel = `COALESCE(NULLIF(TRIM(w.address), ''), 'Склад #' || w.id::text)`;
    /* Итог в ₽: Σ (после − до) × себестоимость, только строки с известной cost (как в UI деталей). */
    const netRub = `(
      SELECT SUM((l.quantity_after - l.quantity_before)::numeric * p.cost::numeric)
      FROM inventory_session_lines l
      INNER JOIN products p ON p.id = l.product_id
      WHERE l.session_id = s.id
        AND p.cost IS NOT NULL
    ) AS net_amount_rub`;
    if (pid != null) {
      const res = await query(
        `SELECT s.id, s.created_at, s.lines_count, s.note, s.profile_id, s.warehouse_id,
                s.category_ids, s.created_by_user_id,
                u.email AS created_by_email,
                u.full_name AS created_by_full_name,
                ${whLabel} AS warehouse_label,
                ${netRub}
         FROM inventory_sessions s
         LEFT JOIN users u ON u.id = s.created_by_user_id
         LEFT JOIN warehouses w ON w.id = s.warehouse_id
         WHERE s.profile_id = $1
         ORDER BY s.created_at DESC, s.id DESC
         LIMIT $2`,
        [pid, lim]
      );
      return res.rows || [];
    }
    const res = await query(
      `SELECT s.id, s.created_at, s.lines_count, s.note, s.profile_id, s.warehouse_id,
              s.category_ids, s.created_by_user_id,
              u.email AS created_by_email,
              u.full_name AS created_by_full_name,
              ${whLabel} AS warehouse_label,
              ${netRub}
       FROM inventory_sessions s
       LEFT JOIN users u ON u.id = s.created_by_user_id
       LEFT JOIN warehouses w ON w.id = s.warehouse_id
       WHERE s.profile_id IS NULL
       ORDER BY s.created_at DESC, s.id DESC
       LIMIT $1`,
      [lim]
    );
    return res.rows || [];
  }

  async getById(sessionId, { profileId } = {}) {
    const sid = parseInt(sessionId, 10);
    if (!sid || Number.isNaN(sid)) {
      const err = new Error('Некорректный ID');
      err.statusCode = 400;
      throw err;
    }
    const head = await query(
      `SELECT s.id, s.created_at, s.lines_count, s.note, s.profile_id, s.warehouse_id,
              s.category_ids, s.created_by_user_id,
              u.email AS created_by_email,
              u.full_name AS created_by_full_name,
              COALESCE(NULLIF(TRIM(w.address), ''), 'Склад #' || w.id::text) AS warehouse_label
       FROM inventory_sessions s
       LEFT JOIN users u ON u.id = s.created_by_user_id
       LEFT JOIN warehouses w ON w.id = s.warehouse_id
       WHERE s.id = $1`,
      [sid]
    );
    const session = head.rows?.[0];
    if (!session) {
      const err = new Error('Инвентаризация не найдена');
      err.statusCode = 404;
      throw err;
    }
    const pid = normalizeProfileId(profileId);
    if (pid != null) {
      const sidPid = session.profile_id != null ? Number(session.profile_id) : null;
      if (sidPid !== pid) {
        const err = new Error('Инвентаризация не найдена');
        err.statusCode = 404;
        throw err;
      }
    }
    const lines = await query(
      `SELECT l.id, l.product_id, l.quantity_before, l.quantity_after,
              p.sku AS product_sku, p.name AS product_name, p.cost AS product_cost,
              COALESCE(z.is_unlisted_zero, false) AS is_unlisted_zero
       FROM inventory_session_lines l
       JOIN products p ON p.id = l.product_id
       LEFT JOIN LATERAL (
         SELECT true AS is_unlisted_zero
         FROM stock_movements sm
         WHERE sm.product_id = l.product_id
           AND (
             (sm.meta->>'inventory_session_id') = ($1::bigint)::text
             OR NULLIF(sm.meta->>'inventory_session_id', '')::bigint = $1::bigint
           )
           AND (
             sm.meta->>'unlisted_zero' = 'true'
             OR sm.reason ILIKE '%не пересчитан%'
           )
         LIMIT 1
       ) z ON true
       WHERE l.session_id = $1::bigint
       ORDER BY COALESCE(z.is_unlisted_zero, false) DESC, l.id ASC`,
      [sid]
    );
    return { session, lines: lines.rows || [] };
  }

  /**
   * Превью позиций, которые будут обнулены при zeroUnlisted (не в списке пересчёта).
   * @param {{ warehouseId: number|string, profileId?: number|string|null, categoryIds?: number[], excludeProductIds?: number[] }} opts
   */
  async previewUnlisted({
    warehouseId,
    profileId = null,
    categoryIds = null,
    excludeProductIds = [],
  } = {}) {
    const whId = await requireInventoryWarehouseId(
      { query: (...args) => query(...args) },
      warehouseId
    );
    const pid = normalizeProfileId(profileId);
    const roots = normalizeCategoryIds(categoryIds);
    const expanded = await this.expandCategoryIds(pid, roots);
    const listed = new Set(
      (excludeProductIds || [])
        .map((x) => Number(x))
        .filter((n) => Number.isFinite(n) && n > 0)
    );
    const rows = await findUnlistedWithStock(
      { query: (...args) => query(...args) },
      whId,
      pid,
      listed,
      expanded
    );
    return (rows || []).map((r) => ({
      productId: Number(r.product_id),
      sku: r.sku || null,
      name: r.name || null,
      cost: r.cost != null ? Number(r.cost) : null,
      quantity: Math.max(0, Number(r.quantity) || 0),
      userCategoryId: r.user_category_id != null ? Number(r.user_category_id) : null,
      categoryName: r.category_name || null,
    }));
  }

  /**
   * @param {Array<{ productId: number|string, quantityAfter: number }>} linesInput
   * @param {{ userId: number|null, profileId: number|string|null, note?: string, warehouseId?: number|string|null, zeroUnlisted?: boolean, categoryIds?: number[] }} ctx
   */
  async apply(linesInput, {
    userId = null,
    profileId = null,
    note = null,
    warehouseId = null,
    zeroUnlisted = true,
    categoryIds = null,
  } = {}) {
    if (!Array.isArray(linesInput) || linesInput.length === 0) {
      const err = new Error('Передайте непустой массив lines');
      err.statusCode = 400;
      throw err;
    }
    const uid = userId != null ? parseInt(userId, 10) : null;
    const pid = normalizeProfileId(profileId);
    const zeroUnlistedFlag = zeroUnlisted !== false;
    const rootCategoryIds = normalizeCategoryIds(categoryIds);

    const result = await runWithDbRetry(
      () =>
        transaction(async (client) => {
      const whId = await requireInventoryWarehouseId(client, warehouseId);
      await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [inventoryWarehouseLockKey(whId)]);
      const expandedCategoryIds = await expandCategoryIds(client, pid, rootCategoryIds);

      const ins = await client.query(
        `INSERT INTO inventory_sessions (created_by_user_id, profile_id, lines_count, note, warehouse_id, category_ids)
         VALUES ($1, $2, 0, $3, $4, $5::jsonb)
         RETURNING id`,
        [
          uid && !Number.isNaN(uid) ? uid : null,
          pid,
          note || null,
          whId,
          rootCategoryIds.length ? JSON.stringify(rootCategoryIds) : null,
        ]
      );
      const sessionId = ins.rows[0].id;
      const reasonBase = `Инвентаризация №${sessionId}`;

      const { applied, productIds } = await runInventoryLines(client, {
        sessionId,
        whId,
        profileId: pid,
        linesInput,
        zeroUnlisted: zeroUnlistedFlag,
        reasonBase,
        expandedCategoryIds,
      });

      const linesRecorded = await client.query(
        `SELECT COUNT(*)::int AS c FROM inventory_session_lines WHERE session_id = $1`,
        [sessionId]
      );
      const linesCount = linesRecorded.rows?.[0]?.c ?? 0;

      if (linesCount === 0) {
        await client.query('DELETE FROM inventory_sessions WHERE id = $1', [sessionId]);
        return {
          sessionId: null,
          linesApplied: 0,
          productIds: [],
          message: 'Нет пересчитанных позиций — документ не создан',
        };
      }

      await client.query(`UPDATE inventory_sessions SET lines_count = $1 WHERE id = $2`, [linesCount, sessionId]);

      if (applied === 0) {
        return {
          sessionId,
          linesApplied: 0,
          productIds,
          message: 'Расхождений нет, пересчитанные позиции зафиксированы',
        };
      }

      return { sessionId, linesApplied: applied, productIds };
    }, INVENTORY_TX_OPTS),
      { label: 'inventory-apply' }
    );

    if (result?.sessionId && result.productIds?.length) {
      await syncProductsAfterInventory(result.sessionId, result.productIds);
      afterInventoryTouch(result.sessionId, result.productIds);
    }

    return result;
  }

  /**
   * Редактирование сохранённой инвентаризации: откат старых строк, применение нового списка.
   */
  async updateSession(sessionId, linesInput, { profileId = null, zeroUnlisted = true, categoryIds = undefined } = {}) {
    if (!Array.isArray(linesInput) || linesInput.length === 0) {
      const err = new Error('Передайте непустой массив lines');
      err.statusCode = 400;
      throw err;
    }
    const { session, lines: oldLines } = await this.getById(sessionId, { profileId });
    const sid = session.id;
    const whId = session.warehouse_id;
    if (!whId) {
      const err = new Error('У документа не указан склад');
      err.statusCode = 400;
      throw err;
    }
    const pid = normalizeProfileId(profileId);
    const zeroUnlistedFlag = zeroUnlisted !== false;
    const rootCategoryIds =
      categoryIds !== undefined
        ? normalizeCategoryIds(categoryIds)
        : normalizeCategoryIds(session.category_ids);

    const revertProductIds = new Set();
    const result = await runWithDbRetry(
      () =>
        transaction(async (client) => {
      const whNum = Number(whId);
      if (Number.isFinite(whNum) && whNum > 0) {
        await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [inventoryWarehouseLockKey(whNum)]);
      }
      const expandedCategoryIds = await expandCategoryIds(client, pid, rootCategoryIds);

      await client.query('DELETE FROM inventory_session_lines WHERE session_id = $1', [sid]);

      const { applied, productIds } = await runInventoryUpdateLines(client, {
        sessionId: sid,
        whId,
        profileId: pid,
        linesInput,
        zeroUnlisted: zeroUnlistedFlag,
        oldLines: oldLines || [],
        expandedCategoryIds,
      });

      await client.query(
        `UPDATE inventory_sessions SET category_ids = $1::jsonb WHERE id = $2`,
        [rootCategoryIds.length ? JSON.stringify(rootCategoryIds) : null, sid]
      );

      for (const line of oldLines || []) {
        const productId = parseInt(line.product_id, 10);
        if (productId && !Number.isNaN(productId)) revertProductIds.add(productId);
      }
      for (const x of productIds) revertProductIds.add(x);

      const linesRecorded = await client.query(
        `SELECT COUNT(*)::int AS c FROM inventory_session_lines WHERE session_id = $1`,
        [sid]
      );
      const linesCount = linesRecorded.rows?.[0]?.c ?? 0;
      await client.query(`UPDATE inventory_sessions SET lines_count = $1 WHERE id = $2`, [linesCount, sid]);

      if (linesCount === 0) {
        return {
          sessionId: sid,
          linesApplied: 0,
          productIds: [...revertProductIds],
          message: 'Нет пересчитанных позиций в документе',
        };
      }

      return {
        sessionId: sid,
        linesApplied: applied,
        productIds: [...revertProductIds],
      };
    }, INVENTORY_TX_OPTS),
      { label: 'inventory-update' }
    );

    if (result?.sessionId && result.productIds?.length) {
      await syncProductsAfterInventory(result.sessionId, result.productIds);
      afterInventoryTouch(result.sessionId, result.productIds);
    }

    return result;
  }

  /**
   * Удалить документ инвентаризации: откатить изменения остатков на складе документа.
   */
  async deleteSession(sessionId, { profileId } = {}) {
    const { session, lines } = await this.getById(sessionId, { profileId });
    const sid = session.id;
    const whId = session.warehouse_id;
    const pid = normalizeProfileId(profileId);
    const reason = `Аннулирование инвентаризации №${sid}`;

    const del = await runWithDbRetry(
      () =>
        transaction(async (client) => {
      const whNum = Number(whId);
      if (Number.isFinite(whNum) && whNum > 0) {
        await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [inventoryWarehouseLockKey(whNum)]);
      }
      const touchedIds = [];
      const linesSorted = [...(lines || [])].sort(
        (a, b) => Number(a.product_id) - Number(b.product_id)
      );
      for (const line of linesSorted) {
        const productId = parseInt(line.product_id, 10);
        const qb = line.quantity_before != null ? Number(line.quantity_before) : 0;
        const qa = line.quantity_after != null ? Number(line.quantity_after) : 0;
        if (!productId || Number.isNaN(productId) || qb === qa) continue;

        if (pid != null) {
          await assertProductAllowedInProfile(client, productId, pid);
        }

        if (whId) {
          await client.query(
            `INSERT INTO product_warehouse_stock (product_id, warehouse_id, quantity)
             VALUES ($1, $2, $3)
             ON CONFLICT (product_id, warehouse_id) DO UPDATE SET quantity = EXCLUDED.quantity`,
            [productId, whId, qb]
          );
        }

        const reverseDelta = qb - qa;

        await stockMovementsRepositoryPG.insertSnapshotAfterProduct(client, {
          productId,
          type: 'manual',
          quantityChange: reverseDelta,
          reason,
          meta: { inventory_session_id: sid, deleted: true, warehouse_id: whId },
          warehouseId: whId || null,
          profileId: null,
        });
        touchedIds.push(productId);
      }

      await client.query('DELETE FROM inventory_sessions WHERE id = $1', [sid]);
      return { deleted: true, id: sid, productIds: [...new Set(touchedIds)] };
    }, INVENTORY_TX_OPTS),
      { label: 'inventory-delete' }
    );

    if (del?.productIds?.length) {
      await syncProductsAfterInventory(sid, del.productIds);
      afterInventoryTouch(sid, del.productIds);
    }

    return del;
  }

  /** Корневые ID категорий → включая потомков (для live-скана и UI). */
  async expandCategoryIds(profileId, categoryIds) {
    const roots = normalizeCategoryIds(categoryIds);
    if (roots.length === 0) return [];
    const pid = normalizeProfileId(profileId);
    const res = await query(
      `WITH RECURSIVE tree AS (
         SELECT id, parent_id
         FROM user_categories
         WHERE id = ANY($1::bigint[])
           AND ($2::bigint IS NULL OR profile_id = $2::bigint)
         UNION ALL
         SELECT c.id, c.parent_id
         FROM user_categories c
         INNER JOIN tree t ON c.parent_id = t.id
         WHERE ($2::bigint IS NULL OR c.profile_id = $2::bigint)
       )
       SELECT DISTINCT id FROM tree`,
      [roots, pid]
    );
    return (res.rows || [])
      .map((r) => Number(r.id))
      .filter((n) => Number.isFinite(n) && n > 0);
  }

  normalizeCategoryIds(raw) {
    return normalizeCategoryIds(raw);
  }
}

export default new InventorySessionsService();
