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
    `SELECT pi.product_id, pi.expected_quantity, p.sku, p.brand, p.name
     FROM purchase_items pi
     INNER JOIN products p ON p.id = pi.product_id
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

  let integrationConfig = {};
  try {
    integrationConfig = await integrationsService.getSupplierConfig(apiCode, {
      profileId: ctx.purchase.profile_id ?? profileId,
    });
  } catch (e) {
    logger.warn('[SupplierOrderPlacement] integration config load failed', {
      apiCode,
      message: e?.message || String(e),
    });
  }

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

export default { trySubmitPurchaseToSupplier };
