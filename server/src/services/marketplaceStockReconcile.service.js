/**
 * Сверка остатков ERM ↔ Ozon FBS: если в ERM available > 0, а на Ozon FBS present = 0
 * (и нет block_stock_ozon) — повторный пуш.
 *
 * Ловит залипание нуля после rate-limit / сбоя API / старых alias-офферов.
 */

import { query } from '../config/database.js';
import logger from '../utils/logger.js';
import { ozonApiPostWithRetry } from '../utils/ozonSellerApi.js';
import { resolveOzonStockPushTargets } from '../utils/ozonStockPushTargets.js';
import { computeAvailableQuantity } from './sellableQuantity.service.js';
import { resolveWarehouseMarketplacePushQuantity } from '../utils/warehouseMarketplaceStockSyncPolicy.js';
import { syncWarehouseStockToMarketplaces } from './marketplaceWarehouseStockSync.service.js';
import { isMarketplaceStockPushEnabled } from './marketplaceStockPush.service.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function fbsPresentFromOzonItem(item) {
  const stocks = Array.isArray(item?.stocks) ? item.stocks : [];
  const fbs = stocks.find((s) => String(s?.type || '').toLowerCase() === 'fbs');
  if (fbs) return Math.max(0, Math.floor(Number(fbs.present) || 0));
  // если type не пришёл — берём max present
  let max = 0;
  for (const s of stocks) max = Math.max(max, Math.floor(Number(s?.present) || 0));
  return max;
}

/**
 * @param {{ profileId?: number|string|null, organizationId?: number|string|null, limit?: number, dryRun?: boolean }} [opts]
 */
export async function reconcileOzonFbsZeroStocks(opts = {}) {
  if (!isMarketplaceStockPushEnabled()) {
    return { skipped: true, reason: 'stock_push_disabled', checked: 0, mismatched: 0, pushed: 0 };
  }

  const limit = Math.min(5000, Math.max(1, Math.floor(Number(opts.limit) || 1500)));
  const dryRun = opts.dryRun === true;
  const profileFilter =
    opts.profileId != null && String(opts.profileId).trim() !== ''
      ? Number(opts.profileId)
      : null;
  const orgFilter =
    opts.organizationId != null && String(opts.organizationId).trim() !== ''
      ? Number(opts.organizationId)
      : null;

  const params = [];
  let where = `ps.marketplace = 'ozon'
    AND p.block_stock_ozon IS NOT TRUE
    AND (ps.sku IS NOT NULL AND btrim(ps.sku) <> '' OR ps.marketplace_product_id IS NOT NULL)`;
  if (Number.isFinite(profileFilter) && profileFilter > 0) {
    params.push(profileFilter);
    where += ` AND p.profile_id = $${params.length}`;
  }
  if (Number.isFinite(orgFilter) && orgFilter > 0) {
    params.push(orgFilter);
    where += ` AND p.organization_id = $${params.length}`;
  }
  params.push(limit);

  const rowsRes = await query(
    `SELECT p.id AS product_id, p.sku, p.profile_id, p.organization_id,
            ps.sku AS ozon_offer, ps.marketplace_product_id, ps.mp_extra
     FROM product_skus ps
     JOIN products p ON p.id = ps.product_id
     WHERE ${where}
     ORDER BY p.id
     LIMIT $${params.length}`,
    params
  );
  const rows = rowsRes.rows || [];
  if (rows.length === 0) {
    return { skipped: false, checked: 0, mismatched: 0, pushed: 0, failed: 0 };
  }

  // Группы по org+profile для credentials
  const byCred = new Map();
  for (const row of rows) {
    const key = `${row.organization_id || ''}::${row.profile_id || ''}`;
    if (!byCred.has(key)) byCred.set(key, []);
    byCred.get(key).push(row);
  }

  let checked = 0;
  let mismatched = 0;
  let pushed = 0;
  let failed = 0;
  const samples = [];

  for (const [, group] of byCred) {
    const organizationId = group[0].organization_id;
    const profileId = group[0].profile_id;
    const ozonApiOpts = { organizationId, profileId };

    /** @type {Map<string, { productId: number, offerId: string|null, available: number }[]>} */
    const offerOwners = new Map();
    const candidates = [];

    const whMap = await query(
      `SELECT wm.warehouse_id
       FROM warehouse_mappings wm
       JOIN warehouses w ON w.id = wm.warehouse_id
       WHERE w.profile_id = $1 AND wm.marketplace = 'ozon'
       ORDER BY wm.warehouse_id
       LIMIT 1`,
      [profileId]
    );
    const warehouseId = whMap.rows?.[0]?.warehouse_id ?? null;

    for (const row of group) {
      const targets = resolveOzonStockPushTargets({
        product: { id: row.product_id, sku: row.sku },
        productSkus: [
          {
            marketplace: 'ozon',
            sku: row.ozon_offer,
            marketplace_product_id: row.marketplace_product_id,
            mp_extra: row.mp_extra,
          },
        ],
      });
      if (targets.length === 0) continue;

      let available = 0;
      try {
        const av = await computeAvailableQuantity(row.product_id, {
          warehouseId,
          profileId,
          forMarketplace: true,
        });
        const policy = await resolveWarehouseMarketplacePushQuantity({
          warehouseId,
          productId: row.product_id,
          marketplace: 'ozon',
          available: av.available,
        });
        if (policy.forceZero || policy.quantity <= 0) continue;
        available = policy.quantity;
      } catch (e) {
        logger.warn('[Stock Reconcile] available failed', {
          productId: row.product_id,
          error: e?.message || String(e),
        });
        continue;
      }

      for (const t of targets) {
        if (!t.offerId && t.productId == null) continue;
        candidates.push({
          productId: Number(row.product_id),
          sku: row.sku,
          offerId: t.offerId,
          ozonProductId: t.productId,
          available,
          source: t.source,
        });
        if (t.offerId) {
          if (!offerOwners.has(t.offerId)) offerOwners.set(t.offerId, []);
          offerOwners.get(t.offerId).push({
            productId: Number(row.product_id),
            offerId: t.offerId,
            available,
          });
        }
      }
    }

    const offerIds = [...offerOwners.keys()];
    if (offerIds.length === 0) continue;

    /** @type {Map<string, number>} offer_id → fbs present */
    const ozonPresent = new Map();
    for (const batch of chunk(offerIds, 100)) {
      try {
        const data = await ozonApiPostWithRetry(
          '/v4/product/info/stocks',
          { filter: { offer_id: batch, visibility: 'ALL' }, limit: 100 },
          ozonApiOpts
        );
        const items = data?.result?.items || data?.items || [];
        for (const item of items) {
          const offerId = item?.offer_id != null ? String(item.offer_id) : null;
          if (!offerId) continue;
          ozonPresent.set(offerId, fbsPresentFromOzonItem(item));
        }
      } catch (e) {
        logger.warn('[Stock Reconcile] Ozon stocks fetch failed', {
          organizationId,
          profileId,
          error: e?.message || String(e),
          batchSize: batch.length,
        });
      }
      await sleep(200);
    }

    const toPush = new Map(); // productId → { available, offers: [] }
    for (const c of candidates) {
      if (!c.offerId) continue;
      checked += 1;
      const present = ozonPresent.has(c.offerId) ? ozonPresent.get(c.offerId) : null;
      // нет в ответе — не трогаем (архив / другой кабинет)
      if (present == null) continue;
      if (present > 0) continue;
      if (c.available <= 0) continue;
      mismatched += 1;
      if (samples.length < 30) {
        samples.push({
          productId: c.productId,
          sku: c.sku,
          offerId: c.offerId,
          available: c.available,
          ozonFbs: present,
          source: c.source,
        });
      }
      if (!toPush.has(c.productId)) {
        toPush.set(c.productId, { available: c.available, offers: [] });
      }
      toPush.get(c.productId).offers.push(c.offerId);
    }

    if (dryRun) continue;

    for (const [productId, info] of toPush) {
      try {
        const res = await syncWarehouseStockToMarketplaces(productId, {
          source: 'ozon_fbs_zero_reconcile',
          marketplaces: ['ozon'],
          organizationId,
          profileId,
        });
        const ok = res?.pushed > 0 || (res?.results || []).some((r) => r.ok);
        if (ok) pushed += 1;
        else failed += 1;
        logger.info('[Stock Reconcile] re-pushed', {
          productId,
          available: info.available,
          offers: info.offers,
          ok,
        });
      } catch (e) {
        failed += 1;
        logger.warn('[Stock Reconcile] re-push failed', {
          productId,
          error: e?.message || String(e),
        });
      }
      await sleep(150);
    }
  }

  const summary = {
    skipped: false,
    dryRun,
    checked,
    mismatched,
    pushed,
    failed,
    samples,
  };
  logger.info('[Stock Reconcile] done', summary);
  return summary;
}

export default {
  reconcileOzonFbsZeroStocks,
};
