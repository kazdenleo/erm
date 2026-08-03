/**
 * Политика передачи остатков склада на маркетплейсы (настройки склада + исключения).
 */

import { query } from '../config/database.js';

function normalizeId(id) {
  if (id == null || id === '') return null;
  const n = typeof id === 'string' ? parseInt(id, 10) : Number(id);
  if (!Number.isFinite(n) || n < 1) return null;
  return n;
}

export function normalizeStockSyncMarketplace(marketplace) {
  const m = String(marketplace || '')
    .toLowerCase()
    .trim();
  if (m === 'wildberries' || m === 'wb') return 'wb';
  if (m === 'yandex' || m === 'yandexmarket' || m === 'yandex market' || m === 'ym') return 'ym';
  if (m === 'ozon') return 'ozon';
  return null;
}

function parseBool(v, defaultTrue = true) {
  if (v === undefined || v === null) return defaultTrue;
  if (v === true || v === 'true' || v === 1 || v === '1') return true;
  if (v === false || v === 'false' || v === 0 || v === '0') return false;
  return defaultTrue;
}

export function mapWarehouseStockSyncFlags(row = {}) {
  return {
    pushMarketplaceStock: parseBool(row.push_marketplace_stock ?? row.pushMarketplaceStock, true),
    pushStockOzon: parseBool(row.push_stock_ozon ?? row.pushStockOzon, true),
    pushStockWb: parseBool(row.push_stock_wb ?? row.pushStockWb, true),
    pushStockYm: parseBool(row.push_stock_ym ?? row.pushStockYm, true),
  };
}

/**
 * @returns {Promise<{ forceZero: boolean, reason: string|null, flags: object|null }>}
 */
export async function resolveWarehouseMarketplacePushQuantity({
  warehouseId,
  productId,
  marketplace,
  available = 0,
} = {}) {
  const wid = normalizeId(warehouseId);
  const pid = normalizeId(productId);
  const mp = normalizeStockSyncMarketplace(marketplace);
  const avail = Math.max(0, Math.floor(Number(available) || 0));

  if (!mp) {
    return { forceZero: true, reason: 'unknown_marketplace', quantity: 0, flags: null };
  }
  if (!wid) {
    return { forceZero: false, reason: null, quantity: avail, flags: null };
  }

  const whRes = await query(
    `SELECT push_marketplace_stock, push_stock_ozon, push_stock_wb, push_stock_ym
     FROM warehouses WHERE id = $1 LIMIT 1`,
    [wid]
  );
  const flags = mapWarehouseStockSyncFlags(whRes.rows?.[0] || {});

  if (!flags.pushMarketplaceStock) {
    return { forceZero: true, reason: 'warehouse_master_off', quantity: 0, flags };
  }

  const mpEnabled =
    mp === 'ozon' ? flags.pushStockOzon : mp === 'wb' ? flags.pushStockWb : flags.pushStockYm;
  if (!mpEnabled) {
    return { forceZero: true, reason: 'warehouse_marketplace_off', quantity: 0, flags };
  }

  if (pid) {
    const excl = await query(
      `SELECT 1 FROM warehouse_marketplace_stock_exclusions
       WHERE warehouse_id = $1 AND product_id = $2 AND marketplace = $3
       LIMIT 1`,
      [wid, pid, mp]
    );
    if (excl.rows?.length) {
      return { forceZero: true, reason: 'warehouse_product_exclusion', quantity: 0, flags };
    }
  }

  return { forceZero: false, reason: null, quantity: avail, flags };
}

export async function listWarehouseStockSyncExclusions(warehouseId) {
  const wid = normalizeId(warehouseId);
  if (!wid) return [];
  const r = await query(
    `SELECT e.id, e.warehouse_id, e.product_id, e.marketplace, e.created_at,
            p.sku, p.name
     FROM warehouse_marketplace_stock_exclusions e
     JOIN products p ON p.id = e.product_id
     WHERE e.warehouse_id = $1
     ORDER BY e.created_at DESC, e.id DESC`,
    [wid]
  );
  return (r.rows || []).map((row) => ({
    id: Number(row.id),
    warehouseId: Number(row.warehouse_id),
    productId: Number(row.product_id),
    marketplace: row.marketplace,
    createdAt: row.created_at,
    sku: row.sku,
    name: row.name,
  }));
}

export async function countWarehouseStockSyncExclusions(warehouseId) {
  const wid = normalizeId(warehouseId);
  if (!wid) return 0;
  const r = await query(
    `SELECT COUNT(*)::int AS n FROM warehouse_marketplace_stock_exclusions WHERE warehouse_id = $1`,
    [wid]
  );
  return Number(r.rows?.[0]?.n) || 0;
}

export async function addWarehouseStockSyncExclusion(warehouseId, productId, marketplace) {
  const wid = normalizeId(warehouseId);
  const pid = normalizeId(productId);
  const mp = normalizeStockSyncMarketplace(marketplace);
  if (!wid || !pid || !mp) {
    const err = new Error('Нужны склад, товар и маркетплейс (ozon / wb / ym)');
    err.statusCode = 400;
    throw err;
  }
  const r = await query(
    `INSERT INTO warehouse_marketplace_stock_exclusions (warehouse_id, product_id, marketplace)
     VALUES ($1, $2, $3)
     ON CONFLICT (warehouse_id, product_id, marketplace) DO UPDATE
       SET marketplace = EXCLUDED.marketplace
     RETURNING id, warehouse_id, product_id, marketplace, created_at`,
    [wid, pid, mp]
  );
  return r.rows[0];
}

export async function removeWarehouseStockSyncExclusion(warehouseId, exclusionId) {
  const wid = normalizeId(warehouseId);
  const eid = normalizeId(exclusionId);
  if (!wid || !eid) return false;
  const r = await query(
    `DELETE FROM warehouse_marketplace_stock_exclusions
     WHERE id = $1 AND warehouse_id = $2
     RETURNING id, product_id, marketplace`,
    [eid, wid]
  );
  return r.rows?.[0] || null;
}

/** Какие МП нужно пересинхронизировать при смене флагов склада (вкл./выкл.). */
export function marketplacesNeedingStockResync(beforeFlags, afterFlags) {
  const before = mapWarehouseStockSyncFlags(beforeFlags || {});
  const after = mapWarehouseStockSyncFlags(afterFlags || {});
  const out = [];
  const masterWasOn = before.pushMarketplaceStock;
  const masterIsOn = after.pushMarketplaceStock;

  for (const mp of ['ozon', 'wb', 'ym']) {
    const key = mp === 'ozon' ? 'pushStockOzon' : mp === 'wb' ? 'pushStockWb' : 'pushStockYm';
    const wasEffective = masterWasOn && before[key];
    const isEffective = masterIsOn && after[key];
    if (wasEffective !== isEffective) out.push(mp);
  }
  if (masterWasOn !== masterIsOn) {
    return ['ozon', 'wb', 'ym'];
  }
  return out;
}
