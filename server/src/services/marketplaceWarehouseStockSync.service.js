/**
 * Передача остатков склада на маркетплейсы (Ozon, Wildberries, Яндекс.Маркет).
 * Количество = «Доступно» (наличие на складе + остатки поставщиков по настройкам).
 */

import { query } from '../config/database.js';
import repositoryFactory from '../config/repository-factory.js';
import logger from '../utils/logger.js';
import { assertMarketplaceStockPushAllowed } from '../utils/organizationMarketplaceStockSyncPolicy.js';
import { computeAvailableQuantity } from './sellableQuantity.service.js';
import { pushStockToMarketplace } from './marketplaceStockPush.service.js';

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

async function loadProductContext(productId) {
  const idNum = typeof productId === 'string' ? parseInt(productId, 10) : Number(productId);
  const repo = repositoryFactory.getProductsRepository();
  const product = await repo.findById(idNum);
  if (!product) return null;

  let skusRows;
  try {
    skusRows = await query(
      `SELECT marketplace, sku, marketplace_product_id, mp_extra
       FROM product_skus WHERE product_id = $1`,
      [idNum]
    );
  } catch {
    skusRows = await query(
      `SELECT marketplace, sku, marketplace_product_id FROM product_skus WHERE product_id = $1`,
      [idNum]
    );
  }

  const linksRows = await query(
    `SELECT marketplace, is_linked FROM product_links WHERE product_id = $1`,
    [idNum]
  );
  const linked = {};
  for (const row of linksRows.rows || []) {
    linked[row.marketplace] = row.is_linked === true;
  }

  return {
    product,
    productSkus: skusRows.rows || [],
    linked
  };
}

function isMarketplaceLinked(marketplace, ctx) {
  const mp = String(marketplace || '').toLowerCase();
  if (ctx.linked[mp] === true) return true;
  return (ctx.productSkus || []).some((s) => s.marketplace === mp && s.sku);
}

async function loadMappingsForSync({ warehouseId, profileId }) {
  const repo = repositoryFactory.getWarehouseMappingsRepository();
  if (!repo) return [];
  if (warehouseId != null && String(warehouseId).trim() !== '') {
    const rows = await repo.findByWarehouse(warehouseId);
    return rows || [];
  }
  return (await repo.findAll({ profileId: profileId ?? null })) || [];
}

/**
 * @param {number|string} productId
 * @param {{ organizationId?: number|string|null, source?: string, warehouseId?: number|string|null }} [opts]
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

  const ctx = await loadProductContext(productId);
  if (!ctx) {
    return { skipped: true, reason: 'product_not_found', organizationId };
  }

  const profileId = ctx.product.profile_id ?? ctx.product.profileId ?? null;
  const mappings = await loadMappingsForSync({
    warehouseId: opts.warehouseId ?? null,
    profileId
  });

  if (mappings.length === 0) {
    logger.info('[MP Stock Push] no warehouse_mappings', { productId, warehouseId: opts.warehouseId });
    return {
      skipped: false,
      organizationId,
      results: [],
      message: 'Нет сопоставления складов ERP ↔ маркетплейс'
    };
  }

  const results = [];
  for (const mapping of mappings) {
    const mp = String(mapping.marketplace || '').toLowerCase();
    if (!isMarketplaceLinked(mp, ctx)) {
      results.push({ marketplace: mp, ok: false, skipped: true, reason: 'not_linked' });
      continue;
    }

    const erpWarehouseId = mapping.warehouse_id;
    const { available, onHand, suppliers, reserved } = await computeAvailableQuantity(productId, {
      warehouseId: erpWarehouseId,
      profileId,
      forMarketplace: true
    });

    try {
      const pushResult = await pushStockToMarketplace({
        marketplace: mp,
        product: ctx.product,
        productSkus: ctx.productSkus,
        mapping,
        quantity: available,
        organizationId,
        profileId
      });
      results.push({
        ...pushResult,
        erpWarehouseId,
        available,
        onHand,
        suppliers,
        reserved
      });
    } catch (e) {
      logger.warn(`[MP Stock Push] ${mp} failed for product ${productId}:`, e?.message || e);
      results.push({
        marketplace: mp,
        ok: false,
        error: e?.message || String(e),
        erpWarehouseId,
        available,
        onHand,
        suppliers,
        reserved
      });
    }
  }

  const pushed = results.filter((r) => r.ok);
  const failed = results.filter((r) => r.ok === false && !r.skipped);

  return {
    skipped: false,
    organizationId,
    productId,
    pushed: pushed.length,
    failed: failed.length,
    results
  };
}

/**
 * Массовая синхронизация остатков организации на маркетплейсы.
 */
export async function syncOrganizationWarehouseStockToMarketplaces(organizationId, opts = {}) {
  const productIds = Array.isArray(opts.productIds) ? opts.productIds : null;

  if (productIds && productIds.length > 0) {
    const summary = { pushed: 0, failed: 0, skipped: 0, results: [] };
    for (const pid of productIds) {
      const r = await syncWarehouseStockToMarketplaces(pid, {
        organizationId,
        source: opts.source || 'bulk',
        warehouseId: opts.warehouseId ?? null
      });
      if (r.skipped && r.reason === 'skip_marketplace_stock_sync') {
        summary.skipped += 1;
        continue;
      }
      summary.pushed += r.pushed || 0;
      summary.failed += r.failed || 0;
      summary.results.push({ productId: pid, ...r });
    }
    return { skipped: false, organizationId, ...summary };
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

  const orgId = Number(organizationId);
  const rows = await query(
    `SELECT DISTINCT p.id
     FROM products p
     INNER JOIN product_links pl ON pl.product_id = p.id AND pl.is_linked = true
     WHERE p.organization_id = $1
     ORDER BY p.id`,
    [orgId]
  );
  const ids = rows.rows.map((r) => r.id);
  return syncOrganizationWarehouseStockToMarketplaces(organizationId, {
    ...opts,
    productIds: ids,
    source: opts.source || 'bulk_org'
  });
}

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
