/**
 * Отправка закупки поставщику через внешний API (Mikado / Moskvorechie).
 */

import { query, transaction } from '../config/database.js';
import logger from '../utils/logger.js';
import integrationsService from './integrations.service.js';
import { canonicalSupplierApiCode } from '../repositories/suppliers.repository.pg.js';
import {
  resolveSupplierOrderAdapter,
  supportedSupplierOrderApiCodes,
  deleteMikadoBasketItems,
} from './supplierOrderAdapters/index.js';
import {
  markOrderSourceOrdersSubmitted,
  markPurchaseLinesSourceOrdersSubmitted,
  selectLinesForOrderSupplierSubmit,
  parseSourceOrdersEntries,
  isSourceEntrySupplierSubmitted,
  pendingSupplierSubmitQuantity,
} from '../utils/orderSupplierSubmitScope.js';
import { basketItemIdsForRollback } from '../utils/supplierSubmitRollback.js';
import { rememberSupplierAccept } from '../utils/recentSupplierAccept.js';
import { orderMarketplaceToDb } from '../utils/orderPurchaseLookup.js';

function normalizeProfileId(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'string' ? parseInt(v, 10) : Number(v);
  return Number.isNaN(n) ? null : n;
}

/** Запомнить антидубль после успешного приёма позиций поставщиком. */
async function rememberAcceptsFromSubmittedLines(profileId, lines, submittedResults) {
  const pid = normalizeProfileId(profileId);
  if (pid == null) return;

  const acceptedProducts = new Set();
  for (const sl of submittedResults || []) {
    const productId = Number(sl?.productId ?? sl?.product_id);
    if (Number.isFinite(productId) && productId > 0) acceptedProducts.add(productId);
  }
  const useAll = acceptedProducts.size === 0;

  for (const line of lines || []) {
    const productId = Number(line?.product_id ?? line?.productId);
    if (!Number.isFinite(productId) || productId < 1) continue;
    if (!useAll && !acceptedProducts.has(productId)) continue;

    const entries = parseSourceOrdersEntries(line?.source_orders ?? line?.sourceOrders);
    for (const ent of entries) {
      const mp = orderMarketplaceToDb(ent.marketplace);
      const oid = String(ent.orderId || '').trim();
      if (!mp || !oid) continue;
      try {
        const r = await query(
          `SELECT id FROM orders WHERE marketplace = $1 AND order_id = $2 LIMIT 1`,
          [mp, oid]
        );
        const orderDbId = Number(r.rows?.[0]?.id);
        if (Number.isFinite(orderDbId) && orderDbId > 0) {
          rememberSupplierAccept(pid, orderDbId, productId);
        }
      } catch {
        /* ignore — антидубль best-effort */
      }
    }
  }
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

function hasSupplierCredentials(config, apiCode = null) {
  if (!config || typeof config !== 'object') return false;
  const code = String(apiCode || '').toLowerCase();
  const apiKey = config.apiKey || config.password || config.api_key;
  if (code === 'moskvorechie' && apiKey) return true;
  if (!config.user_id) return false;
  return Boolean(apiKey);
}

async function loadIntegrationConfigForOrder(apiCode, profileId) {
  let integrationConfig = {};
  try {
    integrationConfig = await integrationsService.getSupplierConfig(apiCode, { profileId });
  } catch (e) {
    logger.warn('[SupplierOrderPlacement] integration config load failed', {
      apiCode,
      profileId,
      message: e?.message || String(e),
    });
  }

  if (!hasSupplierCredentials(integrationConfig, apiCode)) {
    try {
      const fallback = await integrationsService.getSupplierConfig(apiCode, { profileId: null });
      if (hasSupplierCredentials(fallback, apiCode)) {
        logger.info('[SupplierOrderPlacement] using shared supplier credentials', {
          apiCode,
          profileId,
        });
        return fallback;
      }
    } catch (e) {
      logger.warn('[SupplierOrderPlacement] shared integration config load failed', {
        apiCode,
        message: e?.message || String(e),
      });
    }
  }

  return integrationConfig;
}

function submitEnabledForSupplier(apiConfig, integrationConfig) {
  const supplierFlag = apiConfig?.submitOrdersEnabled ?? apiConfig?.submit_orders_enabled;
  const integrationFlag =
    integrationConfig?.submitOrdersEnabled ?? integrationConfig?.submit_orders_enabled;
  if (supplierFlag === false || integrationFlag === false) return false;
  return true;
}

const SUPPLIER_SUBMIT_LOCK_NS = 8843211;
const ORDER_SUBMIT_LOCK_NS = 8843212;

function hashAdvisoryLockKey(str) {
  let hash = 0;
  const s = String(str ?? '');
  for (let i = 0; i < s.length; i += 1) {
    hash = (hash * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 2147483647;
}

function orderScopeSessionLockKey(orderScope) {
  const oid = String(orderScope?.orderId ?? '').trim().toLowerCase();
  const mp = String(
    orderScope?.marketplaceVariants?.[0] ?? orderScope?.marketplace ?? ''
  ).toLowerCase();
  return hashAdvisoryLockKey(`${mp}|${oid}`);
}

async function tryAcquireSessionLock(ns, key) {
  const r = await query('SELECT pg_try_advisory_lock($1::integer, $2::integer) AS ok', [ns, key]);
  return r.rows?.[0]?.ok === true;
}

async function releaseSessionLock(ns, key) {
  await query('SELECT pg_advisory_unlock($1::integer, $2::integer)', [ns, key]).catch(() => {});
}

/** Все source_orders строки уже с supplierSubmittedAt (антидубль повторной отправки). */
export function purchaseLinesFullySubmitted(lines) {
  const list = Array.isArray(lines) ? lines : [];
  if (!list.length) return false;
  return list.every((line) => {
    const entries = parseSourceOrdersEntries(line?.source_orders);
    if (!entries.length) return false;
    return entries.every((e) => isSourceEntrySupplierSubmitted(e));
  });
}

/** Не отправлять повторно, если закупка уже ушла поставщику (без force). */
export function shouldSkipSupplierSubmit(purchase, { force = false } = {}) {
  if (force) return false;
  const at = purchase?.supplier_submitted_at ?? purchase?.supplierSubmittedAt;
  return at != null && String(at).trim() !== '';
}

/** Закупку помечаем отправленной, если API принял хотя бы одну позицию. */
export function shouldMarkPurchaseSupplierSubmitted(result) {
  if (!result || typeof result !== 'object') return false;
  if (result.submitted === true) return true;
  if (Array.isArray(result.lines) && result.lines.length > 0) return true;
  if (Array.isArray(result.supplierOrderIds) && result.supplierOrderIds.length > 0) return true;
  return false;
}

/** Позиции, добавленные в закупку после последней отправки поставщику (или с новыми source_orders). */
export function filterPendingSupplierSubmitLines(purchase, lines) {
  const list = Array.isArray(lines) ? lines : [];
  const submittedAt = purchase?.supplier_submitted_at ?? purchase?.supplierSubmittedAt;
  const cutoff = submittedAt ? new Date(submittedAt) : null;
  const cutoffOk = cutoff && !Number.isNaN(cutoff.getTime());

  const out = [];
  for (const line of list) {
    const entries = parseSourceOrdersEntries(line?.source_orders);

    if (entries.length > 0) {
      const pendingEntries = entries.filter((e) => !isSourceEntrySupplierSubmitted(e));
      if (pendingEntries.length > 0) {
        const qty = pendingSupplierSubmitQuantity(line, pendingEntries);
        out.push({
          ...line,
          expected_quantity: qty,
        });
      }
      continue;
    }

    // Строка без source_orders — legacy / ручная позиция.
    if (!cutoffOk) {
      out.push(line);
      continue;
    }
    const created = line.created_at ?? line.createdAt;
    if (!created) continue;
    const t = new Date(created);
    if (!Number.isNaN(t.getTime()) && t.getTime() > cutoff.getTime()) {
      out.push(line);
    }
  }
  return out;
}

async function markSubmittedAfterAmbiguous({
  purchaseId,
  lines,
  orderScope,
  orderScoped,
  appendOnly,
}) {
  const pid = Number(purchaseId);
  if (!Number.isFinite(pid) || pid < 1) return;
  if (orderScoped) {
    await markOrderSourceOrdersSubmitted(pid, orderScope, []);
    return;
  }
  await markPurchaseSupplierSubmitted(pid, { append: appendOnly });
  await markPurchaseLinesSourceOrdersSubmitted(pid, lines, []);
}

async function claimPurchaseForSupplierSubmit(
  purchaseId,
  { force = false, appendOnly = false, orderScoped = false } = {}
) {
  const pid = Number(purchaseId);
  if (!Number.isFinite(pid) || pid < 1) return { claimed: false, reason: 'invalid_args' };

  return transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1::integer, $2::integer)', [
      SUPPLIER_SUBMIT_LOCK_NS,
      pid % 2147483647,
    ]);
    if (orderScoped) {
      return { claimed: true, orderScoped: true };
    }
    const head = await client.query(
      `SELECT supplier_submitted_at, supplier_order_ref
       FROM purchases WHERE id = $1 FOR UPDATE`,
      [pid]
    );
    const row = head.rows?.[0];
    if (!row) return { claimed: false, reason: 'purchase_not_found' };
    if (appendOnly) {
      return {
        claimed: true,
        appendOnly: true,
        supplierSubmittedAt: row.supplier_submitted_at,
        supplierOrderRef: row.supplier_order_ref,
      };
    }
    if (shouldSkipSupplierSubmit(row, { force })) {
      return {
        claimed: false,
        reason: 'already_submitted',
        supplierSubmittedAt: row.supplier_submitted_at,
        supplierOrderRef: row.supplier_order_ref,
      };
    }
    if (force) {
      return { claimed: true, force: true };
    }
    const claim = await client.query(
      `UPDATE purchases SET
         supplier_submitted_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND supplier_submitted_at IS NULL
       RETURNING id`,
      [pid]
    );
    if (!claim.rows?.length) {
      return { claimed: false, reason: 'already_submitted' };
    }
    return { claimed: true, force: false };
  });
}

async function releasePurchaseSupplierSubmitClaim(purchaseId) {
  const pid = Number(purchaseId);
  if (!Number.isFinite(pid) || pid < 1) return;
  await query(
    `UPDATE purchases SET
       supplier_submitted_at = NULL,
       updated_at = CURRENT_TIMESTAMP
     WHERE id = $1
       AND supplier_order_ref IS NULL
       AND supplier_submitted_at IS NOT NULL`,
    [pid]
  );
}

export async function markPurchaseSupplierSubmitted(
  purchaseId,
  { supplierOrderRef = null, force = false, append = false } = {}
) {
  const pid = Number(purchaseId);
  if (!Number.isFinite(pid) || pid < 1) return;
  // purchases.supplier_order_ref = varchar(255): длинный список basket id ломал UPDATE
  // и из-за этого не ставился supplierSubmittedAt в source_orders → дубли в корзине.
  const REF_MAX = 255;
  const clipRef = (value) => {
    if (value == null) return null;
    const s = String(value).trim();
    if (!s) return null;
    return s.length > REF_MAX ? s.slice(0, REF_MAX) : s;
  };
  const ref = clipRef(supplierOrderRef);
  if (append && ref) {
    await query(
      `UPDATE purchases SET
         supplier_submitted_at = CURRENT_TIMESTAMP,
         supplier_order_ref = CASE
           WHEN supplier_order_ref IS NULL OR TRIM(supplier_order_ref) = '' THEN $2
           WHEN supplier_order_ref LIKE '%' || $2 || '%' THEN left(supplier_order_ref, $3)
           ELSE left(supplier_order_ref || ',' || $2, $3)
         END,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [pid, ref, REF_MAX]
    );
    return;
  }
  if (force) {
    await query(
      `UPDATE purchases SET
         supplier_submitted_at = CURRENT_TIMESTAMP,
         supplier_order_ref = left(COALESCE($2, supplier_order_ref), $3),
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [pid, ref, REF_MAX]
    );
    return;
  }
  await query(
    `UPDATE purchases SET
       supplier_submitted_at = COALESCE(supplier_submitted_at, CURRENT_TIMESTAMP),
       supplier_order_ref = left(COALESCE(supplier_order_ref, $2), $3),
       updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [pid, ref, REF_MAX]
  );
}

async function loadPurchaseSubmitContext(purchaseId, supplierId, profileId) {
  const prof = profileId != null ? Number(profileId) : null;
  const purchaseRes = await query(
    `SELECT pu.id, pu.supplier_id, pu.profile_id, pu.note, pu.supplier_warehouse_name,
            pu.supplier_submitted_at, pu.supplier_order_ref,
            s.id AS supplier_id, s.name AS supplier_name, s.code AS supplier_code, s.api_config
     FROM purchases pu
     INNER JOIN suppliers s ON s.id = pu.supplier_id
     WHERE pu.id = $1
       AND ($2::bigint IS NULL OR pu.profile_id = $2::bigint)
     LIMIT 1`,
    [purchaseId, prof]
  );
  const row = purchaseRes.rows?.[0];
  if (!row) return null;

  const sid = supplierId != null ? Number(supplierId) : Number(row.supplier_id);
  if (sid !== Number(row.supplier_id)) {
    return null;
  }

  const items = await query(
    `SELECT pi.id AS purchase_item_id, pi.product_id, pi.expected_quantity, pi.created_at,
            pi.source_orders,
            p.sku, p.name, b.name AS brand
     FROM purchase_items pi
     INNER JOIN products p ON p.id = pi.product_id
     LEFT JOIN brands b ON b.id = p.brand_id
     WHERE pi.purchase_id = $1
     ORDER BY pi.id ASC`,
    [purchaseId]
  );

  return {
    purchase: {
      id: row.id,
      supplier_id: row.supplier_id,
      profile_id: row.profile_id,
      note: row.note,
      supplier_warehouse_name: row.supplier_warehouse_name,
      supplier_submitted_at: row.supplier_submitted_at,
      supplier_order_ref: row.supplier_order_ref,
    },
    supplier: {
      id: row.supplier_id,
      name: row.supplier_name,
      code: row.supplier_code,
      apiConfig: parseApiConfig(row.api_config),
    },
    lines: items.rows || [],
  };
}

async function loadSupplierRow(supplierId, profileId) {
  const sid = Number(supplierId);
  const prof = profileId != null ? Number(profileId) : null;
  if (!Number.isFinite(sid) || sid < 1) return null;

  if (Number.isFinite(prof)) {
    const r = await query(
      `SELECT id, name, code, api_config, profile_id FROM suppliers WHERE id = $1 AND profile_id = $2 LIMIT 1`,
      [sid, prof]
    );
    if (r.rows?.[0]) return r.rows[0];
  }

  // Общий поставщик другого профиля (например Москворечье profile_id=1 для «Док Трейд»).
  const fallback = await query(
    `SELECT id, name, code, api_config, profile_id FROM suppliers WHERE id = $1 LIMIT 1`,
    [sid]
  );
  const row = fallback.rows?.[0];
  if (!row) return null;
  const apiCode = canonicalSupplierApiCode(row.code);
  if (!resolveSupplierOrderAdapter(apiCode)) return null;
  return row;
}

/**
 * Нужна ли обязательная отправка в API поставщика до создания закупки.
 */
export async function supplierPreSubmitRequired(supplierId, profileId) {
  const row = await loadSupplierRow(supplierId, profileId);
  if (!row) {
    return { required: false, reason: 'supplier_not_found' };
  }
  const apiCode = canonicalSupplierApiCode(row.code);
  const adapter = resolveSupplierOrderAdapter(apiCode);
  if (!adapter) {
    return { required: false, reason: 'no_adapter', supplierName: row.name, supplierCode: apiCode };
  }

  const apiConfig = parseApiConfig(row.api_config);
  const integrationConfig = await loadIntegrationConfigForOrder(apiCode, profileId);

  if (!submitEnabledForSupplier(apiConfig, integrationConfig)) {
    return {
      required: false,
      reason: 'submit_disabled',
      supplierName: row.name,
      supplierCode: apiCode,
    };
  }

  return {
    required: true,
    apiCode,
    supplier: row,
    apiConfig,
    integrationConfig,
  };
}

/** Схлопнуть дубли productId в одну строку (сумма quantity) перед отправкой поставщику. */
export function mergeProcurementItemsByProductId(items) {
  const byId = new Map();
  for (const it of items || []) {
    const pid = Number(it?.productId);
    if (!Number.isFinite(pid) || pid < 1) continue;
    const qty = Math.max(1, parseInt(it?.quantity ?? it?.qty, 10) || 1);
    const existing = byId.get(pid);
    if (existing) {
      existing.quantity += qty;
    } else {
      byId.set(pid, { ...it, productId: pid, quantity: qty });
    }
  }
  return [...byId.values()];
}

/** Позиции для адаптера API из productId + quantity. */
export async function buildSubmitLinesFromItems(items) {
  const merged = mergeProcurementItemsByProductId(items);
  const pids = merged.map((it) => Number(it.productId)).filter((id) => Number.isFinite(id) && id > 0);
  if (!pids.length) return [];

  const r = await query(
    `SELECT p.id, p.sku, p.name, b.name AS brand
     FROM products p
     LEFT JOIN brands b ON b.id = p.brand_id
     WHERE p.id = ANY($1::bigint[])`,
    [pids]
  );
  const byId = new Map((r.rows || []).map((p) => [Number(p.id), p]));

  return merged.map((it) => {
    const p = byId.get(Number(it.productId)) || {};
    return {
      product_id: it.productId,
      expected_quantity: it.quantity,
      sku: p.sku,
      brand: p.brand,
      name: p.name,
    };
  });
}

/**
 * Отправка позиций поставщику до создания закупки в ERP.
 */
export async function trySubmitLinesToSupplier({
  supplierId,
  profileId,
  lines = [],
  purchaseMeta = {},
  force = false,
} = {}) {
  const sid = supplierId != null ? Number(supplierId) : null;
  if (!Number.isFinite(sid) || sid < 1) {
    return {
      submitted: false,
      reason: 'invalid_args',
      message: 'Не указан поставщик',
    };
  }
  if (!lines.length) {
    return { submitted: false, reason: 'no_lines', message: 'Нет позиций для отправки' };
  }

  const pre = await supplierPreSubmitRequired(sid, profileId);
  if (!pre.required) {
    return {
      submitted: false,
      skipped: true,
      reason: pre.reason || 'pre_submit_not_required',
      supplierName: pre.supplierName,
      supplierCode: pre.supplierCode,
    };
  }

  const adapter = resolveSupplierOrderAdapter(pre.apiCode);
  const purchase = {
    id: null,
    supplier_warehouse_name: purchaseMeta.supplier_warehouse_name || null,
    note: purchaseMeta.note || null,
  };

  logger.info('[SupplierOrderPlacement] pre-submit lines to supplier', {
    supplierId: sid,
    supplierCode: pre.apiCode,
    lines: lines.length,
    profileId,
  });

  try {
    const result = await adapter({
      purchase,
      lines,
      config: pre.integrationConfig,
      integrationConfig: pre.integrationConfig,
      supplier: {
        id: pre.supplier.id,
        name: pre.supplier.name,
        code: pre.supplier.code,
        apiConfig: pre.apiConfig,
      },
    });
    return {
      ...result,
      supplierName: pre.supplier.name,
      supplierCode: pre.apiCode,
      lineCount: lines.length,
    };
  } catch (e) {
    logger.error('[SupplierOrderPlacement] pre-submit adapter error', {
      supplierId: sid,
      supplierCode: pre.apiCode,
      message: e?.message || String(e),
    });
    return {
      submitted: false,
      reason: 'submit_error',
      message: e?.message || 'Ошибка отправки заказа поставщику',
      supplierName: pre.supplier.name,
      supplierCode: pre.apiCode,
    };
  }
}

export async function trySubmitPurchaseToSupplier({
  purchaseId,
  supplierId,
  profileId,
  force = false,
  orderScope = null,
} = {}) {
  const pid = purchaseId != null ? Number(purchaseId) : null;
  const sid = supplierId != null ? Number(supplierId) : null;
  if (!Number.isFinite(pid) || pid < 1 || !Number.isFinite(sid) || sid < 1) {
    return {
      submitted: false,
      reason: 'invalid_args',
      message: 'Не указана закупка или поставщик',
    };
  }

  const ctx = await loadPurchaseSubmitContext(pid, sid, profileId);
  if (!ctx) {
    return { submitted: false, reason: 'purchase_not_found', message: 'Закупка не найдена' };
  }
  if (!ctx.lines.length) {
    return { submitted: false, reason: 'no_lines', message: 'В закупке нет позиций для отправки' };
  }

  const orderScoped = Boolean(orderScope?.orderId);
  let linesToSubmit;
  if (orderScoped) {
    linesToSubmit = selectLinesForOrderSupplierSubmit(ctx.lines, orderScope, { force });
    if (!linesToSubmit.length) {
      const oid = String(orderScope.orderId ?? '').trim();
      return {
        submitted: false,
        skipped: true,
        reason: 'already_submitted',
        message: oid
          ? `Заказ ${oid} уже отправлен поставщику`
          : 'Заказ уже отправлен поставщику',
        supplierName: ctx.supplier.name,
        supplierCode: ctx.supplier.code,
        purchaseId: pid,
        orderScope,
      };
    }
  } else {
    linesToSubmit = force
      ? ctx.lines
      : filterPendingSupplierSubmitLines(ctx.purchase, ctx.lines);
    if (!linesToSubmit.length) {
      if (shouldSkipSupplierSubmit(ctx.purchase, { force })) {
        logger.info('[SupplierOrderPlacement] skip duplicate submit — all lines already sent', {
          purchaseId: pid,
          supplierId: sid,
          submittedAt: ctx.purchase.supplier_submitted_at,
        });
        return {
          submitted: false,
          skipped: true,
          reason: 'already_submitted',
          message: `Закупка №${pid} уже отправлена поставщику${
            ctx.purchase.supplier_order_ref
              ? ` (№${ctx.purchase.supplier_order_ref})`
              : ctx.purchase.supplier_submitted_at
                ? ` (${new Date(ctx.purchase.supplier_submitted_at).toLocaleString('ru-RU')})`
                : ''
          }. Новых позиций для отправки нет. Повтор всей закупки — кнопкой «Повторить отправку».`,
          supplierName: ctx.supplier.name,
          supplierCode: ctx.supplier.code,
          purchaseId: pid,
          supplierSubmittedAt: ctx.purchase.supplier_submitted_at,
          supplierOrderRef: ctx.purchase.supplier_order_ref,
        };
      }
      return { submitted: false, reason: 'no_lines', message: 'Нет позиций для отправки поставщику' };
    }
    if (purchaseLinesFullySubmitted(ctx.lines)) {
      logger.info('[SupplierOrderPlacement] skip duplicate submit — all source_orders marked', {
        purchaseId: pid,
        supplierId: sid,
      });
      return {
        submitted: false,
        skipped: true,
        reason: 'already_submitted',
        message: `Все заказы в закупке №${pid} уже отправлены поставщику`,
        supplierName: ctx.supplier.name,
        supplierCode: ctx.supplier.code,
        purchaseId: pid,
      };
    }
  }

  const purchaseLockKey = pid % 2147483647;
  let purchaseLockHeld = false;
  let orderLockKey = null;
  let orderLockHeld = false;

  const releaseSubmitSessionLocks = async () => {
    if (orderLockHeld && orderLockKey != null) {
      await releaseSessionLock(ORDER_SUBMIT_LOCK_NS, orderLockKey);
      orderLockHeld = false;
    }
    if (purchaseLockHeld) {
      await releaseSessionLock(SUPPLIER_SUBMIT_LOCK_NS, purchaseLockKey);
      purchaseLockHeld = false;
    }
  };

  purchaseLockHeld = await tryAcquireSessionLock(SUPPLIER_SUBMIT_LOCK_NS, purchaseLockKey);
  if (!purchaseLockHeld) {
    return {
      submitted: false,
      skipped: true,
      reason: 'submit_in_progress',
      message: `Отправка закупки №${pid} уже выполняется`,
      supplierName: ctx.supplier.name,
      supplierCode: ctx.supplier.code,
      purchaseId: pid,
    };
  }

  if (orderScoped) {
    orderLockKey = orderScopeSessionLockKey(orderScope);
    orderLockHeld = await tryAcquireSessionLock(ORDER_SUBMIT_LOCK_NS, orderLockKey);
    if (!orderLockHeld) {
      await releaseSubmitSessionLocks();
      const oid = String(orderScope.orderId ?? '').trim();
      return {
        submitted: false,
        skipped: true,
        reason: 'submit_in_progress',
        message: oid
          ? `Отправка заказа ${oid} поставщику уже выполняется`
          : 'Отправка заказа поставщику уже выполняется',
        supplierName: ctx.supplier.name,
        supplierCode: ctx.supplier.code,
        purchaseId: pid,
        orderScope,
      };
    }
  }

  try {
    const fresh = await loadPurchaseSubmitContext(pid, sid, profileId);
    if (fresh) {
      ctx.lines = fresh.lines;
      ctx.purchase = fresh.purchase;
      if (orderScoped) {
        linesToSubmit = selectLinesForOrderSupplierSubmit(ctx.lines, orderScope, { force });
        if (!linesToSubmit.length) {
          return {
            submitted: false,
            skipped: true,
            reason: 'already_submitted',
            message: `Заказ ${String(orderScope.orderId ?? '').trim()} уже отправлен поставщику`,
            supplierName: ctx.supplier.name,
            supplierCode: ctx.supplier.code,
            purchaseId: pid,
            orderScope,
          };
        }
      } else {
        linesToSubmit = force
          ? ctx.lines
          : filterPendingSupplierSubmitLines(ctx.purchase, ctx.lines);
        if (!linesToSubmit.length) {
          return {
            submitted: false,
            skipped: true,
            reason: 'already_submitted',
            message: `Нет новых позиций для отправки в закупке №${pid}`,
            supplierName: ctx.supplier.name,
            supplierCode: ctx.supplier.code,
            purchaseId: pid,
          };
        }
      }
    }

  const appendOnly = !orderScoped && Boolean(ctx.purchase.supplier_submitted_at) && !force;

  const claim = await claimPurchaseForSupplierSubmit(pid, {
    force: Boolean(force),
    appendOnly,
    orderScoped,
  });
  if (!claim.claimed) {
    if (claim.reason === 'already_submitted') {
      logger.info('[SupplierOrderPlacement] skip duplicate submit', {
        purchaseId: pid,
        supplierId: sid,
        submittedAt: claim.supplierSubmittedAt ?? ctx.purchase.supplier_submitted_at,
      });
      return {
        submitted: false,
        skipped: true,
        reason: 'already_submitted',
        message: orderScoped
          ? `Заказ ${orderScope.orderId} уже отправлен поставщику`
          : `Закупка №${pid} уже отправлена поставщику${
              claim.supplierOrderRef ?? ctx.purchase.supplier_order_ref
                ? ` (№${claim.supplierOrderRef ?? ctx.purchase.supplier_order_ref})`
                : claim.supplierSubmittedAt ?? ctx.purchase.supplier_submitted_at
                  ? ` (${new Date(claim.supplierSubmittedAt ?? ctx.purchase.supplier_submitted_at).toLocaleString('ru-RU')})`
                  : ''
            }. Повтор — только кнопкой «Повторить отправку».`,
        supplierName: ctx.supplier.name,
        supplierCode: ctx.supplier.code,
        purchaseId: pid,
        supplierSubmittedAt: claim.supplierSubmittedAt ?? ctx.purchase.supplier_submitted_at,
        supplierOrderRef: claim.supplierOrderRef ?? ctx.purchase.supplier_order_ref,
        orderScope: orderScoped ? orderScope : undefined,
      };
    }
    return {
      submitted: false,
      reason: claim.reason || 'claim_failed',
      message: 'Не удалось зарезервировать закупку для отправки поставщику',
      purchaseId: pid,
    };
  }

  const apiCode = canonicalSupplierApiCode(ctx.supplier.code);
  const adapter = resolveSupplierOrderAdapter(apiCode);
  const releaseClaimIfNeeded = async () => {
    if (claim.claimed && !force && !appendOnly && !orderScoped) {
      await releasePurchaseSupplierSubmitClaim(pid).catch(() => {});
    }
  };

  if (!adapter) {
    await releaseClaimIfNeeded();
    return {
      submitted: false,
      reason: 'supplier_api_not_configured',
      message: `API заказа не настроен для поставщика «${ctx.supplier.name}» (код: ${ctx.supplier.code})`,
      supplierName: ctx.supplier.name,
      supplierCode: ctx.supplier.code,
      supportedCodes: supportedSupplierOrderApiCodes(),
    };
  }

  const integrationConfig = await loadIntegrationConfigForOrder(
    apiCode,
    ctx.purchase.profile_id ?? profileId
  );

  if (!force && !submitEnabledForSupplier(ctx.supplier.apiConfig, integrationConfig)) {
    await releaseClaimIfNeeded();
    return {
      submitted: false,
      reason: 'submit_disabled',
      message: 'Отправка заказа поставщику отключена в настройках',
      supplierName: ctx.supplier.name,
      supplierCode: apiCode,
    };
  }

  logger.info('[SupplierOrderPlacement] submitting purchase', {
    purchaseId: pid,
    supplierId: sid,
    supplierCode: apiCode,
    lines: linesToSubmit.length,
    totalLines: ctx.lines.length,
    appendOnly,
    orderScoped,
    orderId: orderScope?.orderId ?? null,
    profileId: ctx.purchase.profile_id ?? profileId,
  });

  let claimedWithoutForce = claim.claimed && !claim.force && !claim.appendOnly && !claim.orderScoped;
  let adapterResult = null;
  let ambiguousMarked = false;
  try {
    adapterResult = await adapter({
      purchase: ctx.purchase,
      lines: linesToSubmit,
      config: integrationConfig,
      integrationConfig,
      supplier: ctx.supplier,
    });
    if (shouldMarkPurchaseSupplierSubmitted(adapterResult)) {
      await rememberAcceptsFromSubmittedLines(
        ctx.purchase.profile_id ?? profileId,
        linesToSubmit,
        adapterResult.lines
      );
      try {
        // Сначала source_orders (антидубль), потом ref закупки — иначе overflow varchar(255)
        // на supplier_order_ref блокирует отметку и корзина дублируется каждые N минут.
        if (orderScoped) {
          await markOrderSourceOrdersSubmitted(pid, orderScope, adapterResult.lines);
        } else {
          await markPurchaseLinesSourceOrdersSubmitted(pid, linesToSubmit, adapterResult.lines);
          const orderRef =
            adapterResult.supplierOrderId ??
            adapterResult.supplierOrderIds?.[0] ??
            (Array.isArray(adapterResult.supplierOrderIds) && adapterResult.supplierOrderIds.length
              ? adapterResult.supplierOrderIds.join(',')
              : null);
          try {
            await markPurchaseSupplierSubmitted(pid, {
              supplierOrderRef: orderRef,
              force: Boolean(force),
              append: appendOnly,
            });
          } catch (refErr) {
            logger.warn('[SupplierOrderPlacement] purchase ref mark failed (source_orders already marked)', {
              purchaseId: pid,
              supplierCode: apiCode,
              message: refErr?.message || String(refErr),
            });
          }
        }
      } catch (markErr) {
        // Позиции уже у поставщика — нельзя вернуть submitted:false (иначе откат → дубли в корзине).
        logger.error('[SupplierOrderPlacement] mark submitted failed after supplier accept', {
          purchaseId: pid,
          supplierCode: apiCode,
          message: markErr?.message || String(markErr),
          acceptedLines: adapterResult?.lines?.length || 0,
        });
      }
      claimedWithoutForce = false;
    } else if (adapterResult?.ambiguousSuccess) {
      await rememberAcceptsFromSubmittedLines(
        ctx.purchase.profile_id ?? profileId,
        linesToSubmit,
        linesToSubmit.map((l) => ({
          productId: l.product_id ?? l.productId,
        }))
      );
      try {
        await markSubmittedAfterAmbiguous({
          purchaseId: pid,
          lines: linesToSubmit,
          orderScope,
          orderScoped,
          appendOnly,
        });
        claimedWithoutForce = false;
        ambiguousMarked = true;
        logger.warn('[SupplierOrderPlacement] ambiguous supplier response — marked submitted', {
          purchaseId: pid,
          supplierCode: apiCode,
          orderId: orderScope?.orderId ?? null,
          lines: linesToSubmit.length,
        });
      } catch (markErr) {
        logger.error('[SupplierOrderPlacement] ambiguous mark failed', {
          purchaseId: pid,
          supplierCode: apiCode,
          message: markErr?.message || String(markErr),
        });
      }
    } else if (claimedWithoutForce) {
      await releasePurchaseSupplierSubmitClaim(pid);
      claimedWithoutForce = false;
    }
    const oid = orderScope?.orderId ? String(orderScope.orderId) : null;
    let msg = adapterResult?.message;
    if (orderScoped && shouldMarkPurchaseSupplierSubmitted(adapterResult)) {
      msg = oid
        ? `Заказ ${oid} отправлен поставщику (${linesToSubmit.length} поз.)`
        : `Отправлено поставщику: ${linesToSubmit.length} поз.`;
    } else if (appendOnly && shouldMarkPurchaseSupplierSubmitted(adapterResult)) {
      msg = `Дополнительно отправлено поставщику: ${linesToSubmit.length} поз. (закупка №${pid})`;
    }
    if (adapterResult?.ambiguousSuccess && ambiguousMarked) {
      return {
        ...adapterResult,
        submitted: false,
        skipped: true,
        reason: 'ambiguous_assumed_submitted',
        message:
          msg ||
          'Таймаут Mikado — позиция помечена отправленной, повтор не выполняется (проверьте корзину)',
        appendOnly,
        orderScoped,
        orderId: oid,
        supplierName: ctx.supplier.name,
        supplierCode: apiCode,
        lineCount: linesToSubmit.length,
        purchaseId: pid,
      };
    }
    return {
      ...adapterResult,
      message: msg,
      submitted: shouldMarkPurchaseSupplierSubmitted(adapterResult),
      appendOnly,
      orderScoped,
      orderId: oid,
      supplierName: ctx.supplier.name,
      supplierCode: apiCode,
      lineCount: linesToSubmit.length,
      purchaseId: pid,
    };
  } catch (e) {
    if (claimedWithoutForce) {
      await releasePurchaseSupplierSubmitClaim(pid).catch(() => {});
    }
    // Если адаптер уже принял позиции, не маскируем это под полный провал.
    if (adapterResult && shouldMarkPurchaseSupplierSubmitted(adapterResult)) {
      logger.error('[SupplierOrderPlacement] error after supplier accept', {
        purchaseId: pid,
        supplierCode: apiCode,
        message: e?.message || String(e),
      });
      return {
        ...adapterResult,
        submitted: true,
        markError: e?.message || String(e),
        supplierName: ctx.supplier.name,
        supplierCode: apiCode,
        lineCount: linesToSubmit.length,
        purchaseId: pid,
      };
    }
    logger.error('[SupplierOrderPlacement] adapter error', {
      purchaseId: pid,
      supplierCode: apiCode,
      message: e?.message || String(e),
    });
    return {
      submitted: false,
      reason: 'submit_error',
      message: e?.message || 'Ошибка отправки заказа поставщику',
      supplierName: ctx.supplier.name,
      supplierCode: apiCode,
    };
  }
  } finally {
    await releaseSubmitSessionLocks();
  }
}

/**
 * Снять принятые позиции из корзины поставщика при откате локальной закупки.
 */
export async function cleanupSupplierBasketOnRollback({
  supplierId,
  profileId,
  supplierSubmit,
  rollbackItems,
} = {}) {
  const basketIds = basketItemIdsForRollback(supplierSubmit, rollbackItems);
  if (!basketIds.length) return { deleted: [], failed: [], skipped: true };

  const sid = Number(supplierId);
  if (!Number.isFinite(sid) || sid < 1) {
    return { deleted: [], failed: basketIds.map((id) => ({ id, message: 'no_supplier' })) };
  }

  const supplierRow = await query(
    `SELECT code FROM suppliers WHERE id = $1 LIMIT 1`,
    [sid]
  );
  const apiCode = canonicalSupplierApiCode(supplierRow.rows?.[0]?.code);
  if (apiCode !== 'mikado') {
    return { deleted: [], failed: [], skipped: true, reason: 'unsupported_supplier' };
  }

  const config = await loadIntegrationConfigForOrder(apiCode, profileId);
  if (!config?.user_id || !config?.password) {
    logger.warn('[SupplierOrderPlacement] Basket_Delete skipped — no Mikado credentials', {
      supplierId: sid,
      basketIds,
    });
    return { deleted: [], failed: basketIds.map((id) => ({ id, message: 'no_credentials' })) };
  }

  const out = await deleteMikadoBasketItems(config, basketIds);
  if (out.deleted.length || out.failed.length) {
    logger.info('[SupplierOrderPlacement] Basket_Delete on rollback', {
      supplierId: sid,
      deleted: out.deleted,
      failed: out.failed,
    });
  }
  return out;
}

export default {
  trySubmitPurchaseToSupplier,
  trySubmitLinesToSupplier,
  supplierPreSubmitRequired,
  buildSubmitLinesFromItems,
  mergeProcurementItemsByProductId,
  shouldSkipSupplierSubmit,
  shouldMarkPurchaseSupplierSubmitted,
  filterPendingSupplierSubmitLines,
  purchaseLinesFullySubmitted,
  markPurchaseSupplierSubmitted,
  cleanupSupplierBasketOnRollback,
};
