/**
 * Отправка закупки поставщику через внешний API (Mikado / Moskvorechie).
 */

import { query } from '../config/database.js';
import logger from '../utils/logger.js';
import integrationsService from './integrations.service.js';
import { canonicalSupplierApiCode } from '../repositories/suppliers.repository.pg.js';
import {
  resolveSupplierOrderAdapter,
  supportedSupplierOrderApiCodes,
} from './supplierOrderAdapters/index.js';

function parseApiConfig(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function hasSupplierCredentials(config) {
  if (!config?.user_id) return false;
  return Boolean(config.password || config.apiKey);
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

  if (!hasSupplierCredentials(integrationConfig)) {
    try {
      const fallback = await integrationsService.getSupplierConfig(apiCode, { profileId: null });
      if (hasSupplierCredentials(fallback)) {
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

async function loadPurchaseSubmitContext(purchaseId, supplierId, profileId) {
  const prof = profileId != null ? Number(profileId) : null;
  const purchaseRes = await query(
    `SELECT pu.id, pu.supplier_id, pu.profile_id, pu.note, pu.supplier_warehouse_name,
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
    `SELECT pi.product_id, pi.expected_quantity, p.sku, p.name, b.name AS brand
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

  const apiCode = canonicalSupplierApiCode(ctx.supplier.code);
  const adapter = resolveSupplierOrderAdapter(apiCode);
  if (!adapter) {
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
    lines: ctx.lines.length,
    profileId: ctx.purchase.profile_id ?? profileId,
  });

  try {
    const result = await adapter({
      purchase: ctx.purchase,
      lines: ctx.lines,
      config: integrationConfig,
      integrationConfig,
      supplier: ctx.supplier,
    });
    return {
      ...result,
      supplierName: ctx.supplier.name,
      supplierCode: apiCode,
      lineCount: ctx.lines.length,
      purchaseId: pid,
    };
  } catch (e) {
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
}

export default {
  trySubmitPurchaseToSupplier,
  trySubmitLinesToSupplier,
  supplierPreSubmitRequired,
  buildSubmitLinesFromItems,
  mergeProcurementItemsByProductId,
};
