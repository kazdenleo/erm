/**
 * Передача остатков склада на маркетплейсы (Ozon, Wildberries, Яндекс.Маркет).
 * Единая точка входа: перед отправкой проверяются organizations.skip_marketplace_stock_sync
 * и skip_marketplace_stock_sync у user_categories (категория товара и предки по parent_id).
 */

import repositoryFactory from '../config/repository-factory.js';
import logger from '../utils/logger.js';
import { assertMarketplaceStockPushAllowed } from '../utils/organizationMarketplaceStockSyncPolicy.js';

async function resolveOrganizationIdForProduct(productId) {
  const idNum = typeof productId === 'string' ? parseInt(productId, 10) : Number(productId);
  if (!idNum || Number.isNaN(idNum) || idNum < 1) return null;
  const repo = repositoryFactory.getProductsRepository();
  const product = await repo.findById(idNum);
  const oid = product?.organization_id ?? product?.organizationId ?? null;
  if (oid == null || oid === '') return null;
  const n = Number(oid);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Синхронизировать остаток товара на маркетплейсы (если не отключено в организации или категории).
 * @param {number|string} productId
 * @param {{ organizationId?: number|string|null, source?: string, warehouseId?: number|string|null }} [opts]
 * @returns {Promise<{ skipped: boolean, reason?: string, organizationId?: number|null, blockedBy?: string, userCategoryId?: number, userCategoryName?: string }>}
 */
export async function syncWarehouseStockToMarketplaces(productId, opts = {}) {
  const source = opts.source || 'unknown';
  let organizationId = opts.organizationId ?? null;
  if (organizationId == null) {
    organizationId = await resolveOrganizationIdForProduct(productId);
  }

  const gate = await assertMarketplaceStockPushAllowed({
    organizationId,
    productId,
    source,
    meta: { productId, warehouseId: opts.warehouseId ?? null }
  });
  if (!gate.allowed) {
    return {
      skipped: true,
      reason: 'skip_marketplace_stock_sync',
      blockedBy: gate.blockedBy,
      organizationId: gate.organizationId ?? organizationId,
      userCategoryId: gate.userCategoryId,
      userCategoryName: gate.userCategoryName
    };
  }

  // Отправка в API маркетплейсов подключается здесь (Ozon / WB / Yandex).
  logger.debug('[MP Stock Push] no outbound stock sync implementation', {
    productId,
    organizationId,
    source
  });
  return { skipped: false, reason: 'not_implemented', organizationId };
}

/**
 * Массовая синхронизация остатков организации на маркетплейсы.
 * @param {number|string} organizationId
 * @param {{ source?: string, productIds?: Array<number|string> }} [opts]
 */
export async function syncOrganizationWarehouseStockToMarketplaces(organizationId, opts = {}) {
  const productIds = Array.isArray(opts.productIds) ? opts.productIds : null;

  if (productIds && productIds.length > 0) {
    let anyPushed = false;
    for (const pid of productIds) {
      const r = await syncWarehouseStockToMarketplaces(pid, {
        organizationId,
        source: opts.source || 'bulk'
      });
      if (!r.skipped) anyPushed = true;
    }
    return {
      skipped: !anyPushed,
      reason: anyPushed ? 'not_implemented' : 'skip_marketplace_stock_sync',
      organizationId
    };
  }

  const gate = await assertMarketplaceStockPushAllowed({
    organizationId,
    source: opts.source || 'bulk',
    meta: { productIdsCount: null }
  });
  if (!gate.allowed) {
    return {
      skipped: true,
      reason: 'skip_marketplace_stock_sync',
      blockedBy: gate.blockedBy,
      organizationId: gate.organizationId
    };
  }
  logger.debug('[MP Stock Push] bulk sync not implemented', { organizationId, source: opts.source });
  return { skipped: false, reason: 'not_implemented', organizationId };
}

/**
 * Вызов после изменения остатка на складе (не блокирует транзакцию).
 */
export function scheduleWarehouseStockMarketplaceSync(productId, opts = {}) {
  setImmediate(() => {
    syncWarehouseStockToMarketplaces(productId, opts).catch((e) => {
      logger.warn('[MP Stock Push] async sync failed:', e?.message || e);
    });
  });
}

export default {
  syncWarehouseStockToMarketplaces,
  syncOrganizationWarehouseStockToMarketplaces,
  scheduleWarehouseStockMarketplaceSync
};
