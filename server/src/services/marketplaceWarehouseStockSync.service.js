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

function normalizeMpKey(marketplace) {
  const m = String(marketplace || '').toLowerCase().trim();
  if (m === 'wildberries') return 'wb';
  if (m === 'yandex' || m === 'yandexmarket' || m === 'yandex market') return 'ym';
  return m;
}

/** Связь с МП: product_links, product_skus или поля sku_ozon / sku_wb / sku_ym на товаре (как в каталоге). */
function isMarketplaceLinked(marketplace, ctx) {
  const mp = normalizeMpKey(marketplace);
  if (!mp) return false;
  if (ctx.linked[mp] === true) return true;

  const p = ctx.product || {};
  for (const row of ctx.productSkus || []) {
    const rowMp = normalizeMpKey(row.marketplace);
    if (rowMp !== mp) continue;
    if (row.sku != null && String(row.sku).trim() !== '') return true;
    if (mp === 'ozon' && row.marketplace_product_id != null && String(row.marketplace_product_id).trim() !== '') {
      return true;
    }
  }

  if (mp === 'ozon') {
    if (p.sku_ozon != null && String(p.sku_ozon).trim() !== '') return true;
    if (p.ozon_product_id != null && String(p.ozon_product_id).trim() !== '') return true;
  }
  if (mp === 'wb' && p.sku_wb != null && String(p.sku_wb).trim() !== '') return true;
  if (mp === 'ym' && p.sku_ym != null && String(p.sku_ym).trim() !== '') return true;

  return false;
}

async function loadMappingsForSync({ warehouseId, profileId, strictWarehouse = false }) {
  const repo = repositoryFactory.getWarehouseMappingsRepository();
  if (!repo) return { rows: [], mappingFallback: false };
  const wid =
    warehouseId != null && String(warehouseId).trim() !== '' ? String(warehouseId).trim() : null;

  if (wid) {
    const byWh = (await repo.findByWarehouse(wid)) || [];
    if (byWh.length > 0) {
      return { rows: byWh, mappingFallback: false };
    }
    if (strictWarehouse) {
      return { rows: [], mappingFallback: false };
    }
    const all = (await repo.findAll({ profileId: profileId ?? null })) || [];
    if (all.length > 0) {
      logger.info('[MP Stock Push] для выбранного склада нет маппинга МП — используем все сопоставления профиля', {
        warehouseId: wid,
        profileId,
        mappings: all.length
      });
      return { rows: all, mappingFallback: true };
    }
    return { rows: [], mappingFallback: false };
  }

  return {
    rows: (await repo.findAll({ profileId: profileId ?? null })) || [],
    mappingFallback: false
  };
}

function tallySyncResult(summary, r) {
  if (!r || r.skipped === true) {
    if (r?.reason === 'skip_marketplace_stock_sync') {
      summary.policySkipped = (summary.policySkipped || 0) + 1;
    }
    return;
  }
  if (r.message && (!r.results || r.results.length === 0)) {
    summary.noMappings = (summary.noMappings || 0) + 1;
    return;
  }
  summary.productsTouched = (summary.productsTouched || 0) + 1;
  for (const item of r.results || []) {
    if (item.ok) {
      summary.pushed += 1;
    } else if (item.skipped) {
      summary.skipped += 1;
      const reason = item.reason || 'unknown';
      summary.skipReasons[reason] = (summary.skipReasons[reason] || 0) + 1;
    } else {
      summary.failed += 1;
    }
  }
}

const SKIP_REASON_LABELS = {
  not_linked: 'нет связи с МП (SKU/ссылка)',
  no_credentials: 'нет API-ключей маркетплейса',
  no_warehouse_mapping: 'не указан склад МП в сопоставлении',
  no_product_sku: 'нет артикула на МП',
  no_wb_barcode: 'нет штрихкода WB',
  unsupported_marketplace: 'маркетплейс не поддерживается'
};

/** Все товары организации со связью с МП (product_links или product_skus). */
export async function findOrganizationMarketplaceLinkedProductIds(organizationId) {
  const orgId = Number(organizationId);
  if (!Number.isFinite(orgId) || orgId < 1) return [];
  const r = await query(
    `SELECT DISTINCT p.id
     FROM products p
     WHERE p.organization_id = $1
       AND (
         EXISTS (
           SELECT 1 FROM product_links pl
           WHERE pl.product_id = p.id AND pl.is_linked = true
         )
         OR EXISTS (
           SELECT 1 FROM product_skus ps
           WHERE ps.product_id = p.id
             AND (
               (ps.sku IS NOT NULL AND BTRIM(ps.sku::text) <> '')
               OR (ps.marketplace = 'ozon' AND ps.marketplace_product_id IS NOT NULL)
             )
         )
       )
     ORDER BY p.id`,
    [orgId]
  );
  return (r.rows || []).map((row) => row.id);
}

const MP_LABELS = { ozon: 'Ozon', wb: 'Wildberries', ym: 'Яндекс.Маркет' };

export function formatSkipReasonsSummary(skipReasons = {}) {
  const parts = Object.entries(skipReasons)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${SKIP_REASON_LABELS[k] || k}: ${n}`);
  return parts.length ? parts.join('\n') : '';
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
  const strictWarehouse = opts.strictWarehouse === true;
  const { rows: mappings, mappingFallback } = await loadMappingsForSync({
    warehouseId: opts.warehouseId ?? null,
    profileId,
    strictWarehouse
  });

  if (mappings.length === 0) {
    logger.info('[MP Stock Push] no warehouse_mappings', { productId, warehouseId: opts.warehouseId });
    return {
      skipped: false,
      organizationId,
      productId,
      pushed: 0,
      failed: 0,
      skippedMarketplaces: 0,
      results: [],
      noMappings: true,
      message:
        'Нет сопоставления складов ERP ↔ маркетплейс. Настройте в разделе «Склады» → сопоставление с Ozon / WB / Яндекс.'
    };
  }

  const results = [];
  for (const mapping of mappings) {
    const mp = normalizeMpKey(mapping.marketplace);
    if (!isMarketplaceLinked(mp, ctx)) {
      results.push({ marketplace: mp, ok: false, skipped: true, reason: 'not_linked' });
      continue;
    }

    const erpWarehouseId = mapping.warehouse_id;
    const whForStock =
      opts.warehouseId != null && String(opts.warehouseId).trim() !== ''
        ? opts.warehouseId
        : erpWarehouseId;
    const { available, onHand, suppliers, reserved, displayAvailable } = await computeAvailableQuantity(
      productId,
      {
        warehouseId: whForStock,
        profileId,
        forMarketplace: true
      }
    );

    logger.info('[MP Stock Push] qty breakdown', {
      productId,
      sku: ctx.product?.sku,
      marketplace: mp,
      erpWarehouseId: whForStock,
      onHand,
      suppliers,
      reserved,
      displayAvailable: displayAvailable ?? onHand + suppliers,
      pushQuantity: available
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

  const pushedOk = results.filter((r) => r.ok);
  const failed = results.filter((r) => r.ok === false && !r.skipped);
  const skippedItems = results.filter((r) => r.skipped);
  const skipReasons = {};
  for (const item of skippedItems) {
    const reason = item.reason || 'unknown';
    skipReasons[reason] = (skipReasons[reason] || 0) + 1;
  }

  return {
    skipped: false,
    organizationId,
    productId,
    pushed: pushedOk.length,
    failed: failed.length,
    skippedMarketplaces: skippedItems.length,
    skipReasons,
    mappingFallback: mappingFallback === true,
    results
  };
}

/**
 * Массовая синхронизация остатков организации на маркетплейсы.
 */
export async function syncOrganizationWarehouseStockToMarketplaces(organizationId, opts = {}) {
  let productIds = Array.isArray(opts.productIds) ? opts.productIds : null;
  const warehouseScoped = opts.warehouseScoped === true;
  const strictWarehouse = warehouseScoped || opts.strictWarehouse === true;
  const warehouseId = opts.warehouseId ?? null;

  if (warehouseScoped) {
    if (warehouseId == null || String(warehouseId).trim() === '') {
      return {
        organizationId,
        pushed: 0,
        failed: 0,
        skipped: 0,
        message:
          'Выберите склад ERP — остатки уйдут только на маркетплейсы, привязанные к этому складу в «Привязка складов маркетплейсов».'
      };
    }
    const { rows: whMappings } = await loadMappingsForSync({
      warehouseId,
      profileId: opts.profileId ?? null,
      strictWarehouse: true
    });
    if (whMappings.length === 0) {
      return {
        organizationId,
        pushed: 0,
        failed: 0,
        skipped: 0,
        noMappings: 1,
        message:
          'У выбранного склада нет привязки к маркетплейсам. Добавьте в «Склады» → «Привязка складов маркетплейсов».'
      };
    }
    const mps = [...new Set(whMappings.map((m) => normalizeMpKey(m.marketplace)).filter(Boolean))];
    opts._warehouseMarketplaces = mps;
    opts._warehouseMappingsCount = whMappings.length;

    const explicitIds = Array.isArray(opts.productIds)
      ? opts.productIds
          .map((id) => (typeof id === 'string' ? parseInt(id, 10) : Number(id)))
          .filter((n) => Number.isFinite(n) && n > 0)
      : [];
    if (explicitIds.length > 0) {
      productIds = [...new Set(explicitIds)];
    } else {
      productIds = await findOrganizationMarketplaceLinkedProductIds(organizationId);
    }
    if (productIds.length === 0) {
      return {
        organizationId,
        pushed: 0,
        failed: 0,
        skipped: 0,
        productsTotal: 0,
        warehouseId,
        marketplaces: mps.map((mp) => MP_LABELS[mp] || mp),
        message: explicitIds.length > 0
          ? 'В выбранном списке нет товаров для отправки.'
          : 'В организации нет товаров со связью с маркетплейсами (SKU / product_links).'
      };
    }
  }

  if (productIds && productIds.length > 0) {
    return runBulkWarehouseStockSync(productIds, organizationId, {
      warehouseId,
      strictWarehouse,
      warehouseScoped,
      source: opts.source || (warehouseScoped ? 'bulk_org_warehouse' : 'bulk'),
      marketplaces: opts._warehouseMarketplaces
        ? opts._warehouseMarketplaces.map((mp) => MP_LABELS[mp] || mp)
        : undefined,
      includeDetails: opts.includeDetails === true
    });
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

  const ids = await findOrganizationMarketplaceLinkedProductIds(organizationId);
  return syncOrganizationWarehouseStockToMarketplaces(organizationId, {
    ...opts,
    productIds: ids,
    source: opts.source || 'bulk_org'
  });
}

/**
 * Параллельная массовая отправка (не блокирует HTTP при фоновом job).
 */
export async function runBulkWarehouseStockSync(productIds, organizationId, opts = {}) {
  const ids = [
    ...new Set(
      (productIds || [])
        .map((id) => (typeof id === 'string' ? parseInt(id, 10) : Number(id)))
        .filter((n) => Number.isFinite(n) && n > 0)
    )
  ];

  const summary = {
    organizationId,
    pushed: 0,
    failed: 0,
    skipped: 0,
    skipReasons: {},
    noMappings: 0,
    policySkipped: 0,
    productsTouched: 0,
    productsTotal: ids.length,
    warehouseId: opts.warehouseId ?? null,
    warehouseScoped: opts.warehouseScoped === true,
    marketplaces: opts.marketplaces,
    results: opts.includeDetails === true ? [] : undefined
  };

  if (ids.length === 0) {
    return summary;
  }

  const concurrency = Math.max(
    1,
    Math.min(12, parseInt(process.env.MP_STOCK_PUSH_CONCURRENCY || '4', 10) || 4)
  );
  let index = 0;

  const worker = async () => {
    while (index < ids.length) {
      const pid = ids[index++];
      try {
        const r = await syncWarehouseStockToMarketplaces(pid, {
          organizationId,
          source: opts.source || 'bulk',
          warehouseId: opts.warehouseId ?? null,
          strictWarehouse: opts.strictWarehouse === true
        });
        tallySyncResult(summary, r);
        if (opts.includeDetails === true && Array.isArray(summary.results)) {
          summary.results.push({ productId: pid, ...r });
        }
      } catch (e) {
        summary.failed += 1;
        logger.warn(`[MP Stock Push] bulk product ${pid}:`, e?.message || e);
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, ids.length) }, () => worker())
  );

  summary.skipReasonsText = formatSkipReasonsSummary(summary.skipReasons);
  if (summary.noMappings > 0 && summary.pushed === 0 && summary.failed === 0) {
    summary.message =
      'Нет сопоставления складов ERP ↔ маркетплейс. Настройте в разделе «Склады» → сопоставление с Ozon / WB / Яндекс.';
  } else if (summary.warehouseScoped && summary.marketplaces?.length) {
    summary.message = `Склад ERP → ${summary.marketplaces.join(', ')}. Обработано товаров: ${summary.productsTotal}.`;
  }

  logger.info('[MP Stock Push] bulk sync done', {
    organizationId,
    productsTotal: ids.length,
    pushed: summary.pushed,
    failed: summary.failed,
    skipped: summary.skipped
  });

  return summary;
}

const mpSyncDebounceTimers = new Map();

export function scheduleWarehouseStockMarketplaceSync(productId, opts = {}) {
  const key = String(productId);
  const delayMs = Math.max(
    0,
    Math.min(30_000, parseInt(process.env.MP_STOCK_PUSH_DEBOUNCE_MS || '1500', 10) || 1500)
  );
  const syncOpts = {
    ...opts,
    strictWarehouse:
      opts.strictWarehouse === true ||
      (opts.warehouseId != null && String(opts.warehouseId).trim() !== '')
  };
  if (mpSyncDebounceTimers.has(key)) {
    clearTimeout(mpSyncDebounceTimers.get(key));
  }
  const timer = setTimeout(() => {
    mpSyncDebounceTimers.delete(key);
    syncWarehouseStockToMarketplaces(productId, syncOpts).catch((e) => {
      logger.warn('[MP Stock Push] async sync failed:', e?.message || e);
    });
  }, delayMs);
  mpSyncDebounceTimers.set(key, timer);
}

/**
 * Пакетная отправка на МП после массового обновления остатков поставщиков.
 * @param {Array<number|string>} productIds
 */
export async function syncMarketplaceStocksForProductIds(productIds, opts = {}) {
  const ids = [
    ...new Set(
      (productIds || [])
        .map((id) => (typeof id === 'string' ? parseInt(id, 10) : Number(id)))
        .filter((n) => Number.isFinite(n) && n > 0)
    )
  ];
  if (ids.length === 0) {
    return { total: 0, products: 0, pushed: 0, failed: 0 };
  }

  const concurrency = Math.max(
    1,
    Math.min(12, parseInt(process.env.MP_STOCK_PUSH_CONCURRENCY || '4', 10) || 4)
  );
  let index = 0;
  let productsProcessed = 0;
  let pushed = 0;
  let failed = 0;
  let skipped = 0;

  const worker = async () => {
    while (index < ids.length) {
      const pid = ids[index++];
      try {
        const r = await syncWarehouseStockToMarketplaces(pid, {
          source: opts.source || 'supplier_stocks_batch',
          warehouseId: opts.warehouseId ?? null
        });
        if (!r.skipped) {
          productsProcessed += 1;
          pushed += r.pushed || 0;
          failed += r.failed || 0;
          skipped += r.skippedMarketplaces || 0;
        }
      } catch (e) {
        failed += 1;
        logger.warn(`[MP Stock Push] batch product ${pid}:`, e?.message || e);
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, ids.length) }, () => worker())
  );

  logger.info('[MP Stock Push] batch after supplier stocks', {
    products: ids.length,
    processed: productsProcessed,
    pushed,
    failed,
    source: opts.source
  });

  return { total: ids.length, products: productsProcessed, pushed, failed, skipped };
}

export default {
  syncWarehouseStockToMarketplaces,
  syncOrganizationWarehouseStockToMarketplaces,
  runBulkWarehouseStockSync,
  syncMarketplaceStocksForProductIds,
  scheduleWarehouseStockMarketplaceSync,
  formatSkipReasonsSummary,
  findOrganizationMarketplaceLinkedProductIds
};
