/**
 * Остатки комплектов: расчёт из kit_components → запись в product_warehouse_stock и products.
 * UI и маркетплейсы читают сохранённые значения (как у обычных товаров).
 * Резерв по заказу на комплект — резерв комплектующих.
 */

import { query } from '../config/database.js';
import repositoryFactory from '../config/repository-factory.js';
import { computeAvailableQuantity } from './sellableQuantity.service.js';
import { scheduleWarehouseStockMarketplaceSync } from './marketplaceWarehouseStockSync.service.js';
import logger from '../utils/logger.js';

export function isKitProductType(raw) {
  return String(raw || '').toLowerCase() === 'kit';
}

export async function isKitProductId(productId) {
  const pid = Number(productId);
  if (!Number.isFinite(pid) || pid < 1) return false;
  const r = await query(
    `SELECT product_type FROM products WHERE id = $1 LIMIT 1`,
    [pid]
  );
  return isKitProductType(r.rows[0]?.product_type);
}

function marketplaceForProductSkus(marketplace) {
  const m = String(marketplace || '').toLowerCase();
  if (m === 'wildberries' || m === 'wb') return 'wb';
  if (m === 'yandex' || m === 'ym' || m === 'yandexmarket') return 'ym';
  return m === 'ozon' ? 'ozon' : m;
}

/** Карточка комплекта: product_type = kit или задан состав kit_components. */
function kitProductSql(alias = 'p') {
  return `(
    LOWER(TRIM(COALESCE(${alias}.product_type::text, ''))) = 'kit'
    OR EXISTS (SELECT 1 FROM kit_components kc WHERE kc.kit_product_id = ${alias}.id)
  )`;
}

/**
 * Найти id комплекта по артикулу в заказе (offer_id / marketplace_sku), напр. DTST4333RL.
 */
async function findKitProductIdByOrderSku(marketplace, offer, msku) {
  const mp = marketplaceForProductSkus(marketplace);
  if (!mp) return null;
  let off = String(offer || '').trim();
  const sku = String(msku || '').trim();
  if (mp === 'wb' && off) {
    const m = off.match(/([0-9]{5,})$/);
    if (m) off = m[1];
  }
  if (!off && !sku) return null;

  const params = [mp, off, sku];
  let ozonClause = '';
  if (mp === 'ozon' && sku && /^[0-9]+$/.test(sku)) {
    ozonClause = `OR (ps.marketplace = 'ozon' AND ps.marketplace_product_id = $4::bigint)`;
    params.push(sku);
  }

  const r = await query(
    `SELECT p.id AS kit_id
     FROM products p
     LEFT JOIN product_skus ps ON ps.product_id = p.id AND ps.marketplace = $1
     WHERE ${kitProductSql('p')}
       AND (
         ($2 <> '' AND TRIM(ps.sku) = TRIM($2))
         OR ($3 <> '' AND TRIM(ps.sku) = TRIM($3))
         OR ($2 <> '' AND TRIM(COALESCE(p.sku, '')) = TRIM($2))
         OR ($3 <> '' AND TRIM(COALESCE(p.sku, '')) = TRIM($3))
         ${ozonClause}
       )
     ORDER BY p.id
     LIMIT 1`,
    params
  );
  const kid = r.rows[0]?.kit_id;
  return kid != null ? Number(kid) : null;
}

/**
 * Заказ на комплект (DTST4333RL): резерв/отгрузка по kit_components (2× DTST4333),
 * даже если в orders.product_id ошибочно указана комплектующая.
 */
export async function findKitProductIdForMarketplaceOrder(productId, orderRow = {}) {
  let offer = String(orderRow.offerId ?? orderRow.offer_id ?? '').trim();
  const msku = String(orderRow.marketplace_sku ?? orderRow.sku ?? '').trim();

  const bySku = await findKitProductIdByOrderSku(orderRow.marketplace, offer, msku);
  if (bySku) return bySku;

  const pid = Number(productId);
  if (!Number.isFinite(pid) || pid < 1) return pid;
  if (await isKitProductId(pid)) return pid;
  const hasComponents = await query(
    `SELECT 1 FROM kit_components WHERE kit_product_id = $1 LIMIT 1`,
    [pid]
  );
  if (hasComponents.rows?.length) return pid;

  const mp = marketplaceForProductSkus(orderRow.marketplace);
  if (!mp) return pid;

  if (mp === 'wb' && offer) {
    const m = offer.match(/([0-9]{5,})$/);
    if (m) offer = m[1];
  }

  const params = [pid, mp, offer, msku];
  let ozonClause = '';
  if (mp === 'ozon' && msku && /^[0-9]+$/.test(msku)) {
    ozonClause = `OR (ps.marketplace = 'ozon' AND ps.marketplace_product_id = $5::bigint)`;
    params.push(msku);
  }

  const r = await query(
    `SELECT kc.kit_product_id
     FROM kit_components kc
     INNER JOIN products pk ON pk.id = kc.kit_product_id
     INNER JOIN product_skus ps ON ps.product_id = kc.kit_product_id AND ps.marketplace = $2
     WHERE ${kitProductSql('pk')}
       AND kc.component_product_id = $1
       AND (
         ($3 <> '' AND TRIM(ps.sku) = TRIM($3))
         OR ($4 <> '' AND TRIM(ps.sku) = TRIM($4))
         ${ozonClause}
       )
     ORDER BY kc.kit_product_id
     LIMIT 1`,
    params
  );

  const kid = r.rows[0]?.kit_product_id;
  return kid != null ? Number(kid) : pid;
}

/** @returns {Promise<Array<{ component_product_id: number, quantity: number }>>} */
export async function getKitComponents(kitProductId) {
  const kitId = Number(kitProductId);
  if (!Number.isFinite(kitId) || kitId < 1) return [];
  const r = await query(
    `SELECT component_product_id, quantity
     FROM kit_components
     WHERE kit_product_id = $1
     ORDER BY id`,
    [kitId]
  );
  return (r.rows || []).map((row) => ({
    component_product_id: Number(row.component_product_id),
    quantity: Math.max(1, parseInt(row.quantity, 10) || 1)
  }));
}

async function getComponentWarehouseSupply(componentProductId) {
  const pid = Number(componentProductId);
  const pr = await query(
    `SELECT COALESCE(quantity, 0)::int AS quantity,
            COALESCE(incoming_quantity, 0)::int AS incoming_quantity,
            COALESCE(reserved_quantity, 0)::int AS reserved_quantity
     FROM products WHERE id = $1 LIMIT 1`,
    [pid]
  );
  const row = pr.rows[0];
  const actual = Number(row?.quantity ?? 0) || 0;
  const incoming = Number(row?.incoming_quantity ?? 0) || 0;
  const reserved = Number(row?.reserved_quantity ?? 0) || 0;
  return {
    actual,
    incoming,
    reserved,
    availableSupply: Math.max(0, actual + incoming - reserved)
  };
}

/** Резерв комплектов из журнала комплектующих: min(floor(reserve_i / qty_in_kit)). */
export async function computeKitReservedFromComponents(kitProductId) {
  const components = await getKitComponents(kitProductId);
  if (components.length === 0) return 0;

  let minKits = Infinity;
  for (const c of components) {
    const r = await query(
      `SELECT GREATEST(0, COALESCE(SUM(
          CASE
            WHEN type = 'reserve' THEN -(quantity_change::numeric)
            WHEN type = 'unreserve' THEN -(quantity_change::numeric)
            ELSE 0
          END
        ), 0))::int AS rv
       FROM stock_movements
       WHERE product_id = $1 AND type IN ('reserve', 'unreserve')`,
      [c.component_product_id]
    );
    const rv = Number(r.rows[0]?.rv ?? 0) || 0;
    minKits = Math.min(minKits, Math.floor(rv / c.quantity));
  }
  return Number.isFinite(minKits) ? Math.max(0, minKits) : 0;
}

/**
 * Расчёт остатков комплекта из комплектующих (только для пересчёта перед записью в БД).
 */
export async function computeKitMetricsFromComponents(kitProductId, opts = {}) {
  const components = await getKitComponents(kitProductId);
  if (components.length === 0) {
    return { onHand: 0, incoming: 0, reserved: 0, suppliers: 0, available: 0 };
  }

  let minOnHand = Infinity;
  let minIncoming = Infinity;
  let minSuppliers = Infinity;

  for (const c of components) {
    const perKit = c.quantity;
    const metrics = await computeAvailableQuantity(c.component_product_id, {
      warehouseId: opts.warehouseId ?? null,
      profileId: opts.profileId ?? null,
      forMarketplace: false
    });
    const supply = await getComponentWarehouseSupply(c.component_product_id);
    minOnHand = Math.min(minOnHand, Math.floor(metrics.onHand / perKit));
    minSuppliers = Math.min(minSuppliers, Math.floor(metrics.suppliers / perKit));
    minIncoming = Math.min(minIncoming, Math.floor(supply.incoming / perKit));
  }

  const onHand = Number.isFinite(minOnHand) ? Math.max(0, minOnHand) : 0;
  const suppliers = Number.isFinite(minSuppliers) ? Math.max(0, minSuppliers) : 0;
  const incoming = Number.isFinite(minIncoming) ? Math.max(0, minIncoming) : 0;
  const reserved = await computeKitReservedFromComponents(kitProductId);
  const available = onHand + suppliers;

  return { onHand, incoming, reserved, suppliers, available };
}

/** @deprecated Используйте computeKitMetricsFromComponents или readKitStockFromDb */
export async function computeKitDisplayStock(kitProductId, opts = {}) {
  return computeKitMetricsFromComponents(kitProductId, opts);
}

async function syncProductQuantityFromWarehouseStock(productId) {
  const pid = Number(productId);
  const r = await query(
    `SELECT COALESCE(SUM(quantity), 0)::int AS total
     FROM product_warehouse_stock WHERE product_id = $1`,
    [pid]
  );
  const total = Math.max(0, Number(r.rows[0]?.total ?? 0) || 0);
  await query(
    `UPDATE products SET quantity = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
    [total, pid]
  );
  return total;
}

async function resolveWarehouseIdsForKitRecalc(kitProductId, warehouseId = null) {
  if (warehouseId != null && String(warehouseId).trim() !== '') {
    const w = typeof warehouseId === 'string' ? parseInt(warehouseId, 10) : Number(warehouseId);
    return Number.isFinite(w) && w > 0 ? [w] : [];
  }

  const components = await getKitComponents(kitProductId);
  const compIds = components.map((c) => c.component_product_id);
  const kitId = Number(kitProductId);
  let ids = [];

  if (compIds.length > 0) {
    const r = await query(
      `SELECT DISTINCT warehouse_id FROM product_warehouse_stock
       WHERE product_id = ANY($1::bigint[]) OR product_id = $2`,
      [compIds, kitId]
    );
    ids = (r.rows || [])
      .map((row) => Number(row.warehouse_id))
      .filter((n) => Number.isFinite(n) && n > 0);
  }

  if (ids.length === 0) {
    const repo = repositoryFactory.getProductsRepository();
    if (repo && typeof repo.getDefaultOwnWarehouseId === 'function') {
      const def = await repo.getDefaultOwnWarehouseId();
      if (def) ids = [def];
    }
  }

  return [...new Set(ids)];
}

/**
 * Пересчитать остатки комплекта из комплектующих и сохранить в БД.
 */
export async function persistKitStock(kitProductId, opts = {}) {
  const kitId = Number(kitProductId);
  if (!Number.isFinite(kitId) || kitId < 1) return null;

  const repo = repositoryFactory.getProductsRepository();
  if (!repo || typeof repo.setWarehouseFreeStock !== 'function') {
    return null;
  }

  const warehouseIds = await resolveWarehouseIdsForKitRecalc(kitId, opts.warehouseId);
  const profileId = opts.profileId ?? null;

  for (const wid of warehouseIds) {
    const metrics = await computeKitMetricsFromComponents(kitId, {
      warehouseId: wid,
      profileId
    });
    await repo.setWarehouseFreeStock(kitId, wid, metrics.onHand);
  }

  const summaryWarehouseId =
    opts.warehouseId != null && String(opts.warehouseId).trim() !== ''
      ? opts.warehouseId
      : warehouseIds[0] ?? null;

  const summary = await computeKitMetricsFromComponents(kitId, {
    warehouseId: summaryWarehouseId,
    profileId
  });

  try {
    await query(
      `UPDATE products
       SET incoming_quantity = $1,
           reserved_quantity = $2,
           kit_supplier_stock = $3,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $4`,
      [summary.incoming, summary.reserved, summary.suppliers, kitId]
    );
  } catch (e) {
    if (!String(e?.message || '').includes('kit_supplier_stock')) {
      throw e;
    }
    await query(
      `UPDATE products
       SET incoming_quantity = $1, reserved_quantity = $2, updated_at = CURRENT_TIMESTAMP
       WHERE id = $3`,
      [summary.incoming, summary.reserved, kitId]
    );
  }

  await syncProductQuantityFromWarehouseStock(kitId);

  logger.info('[Kit Stock] persisted', {
    kitProductId: kitId,
    warehouseIds,
    onHand: summary.onHand,
    suppliers: summary.suppliers,
    reserved: summary.reserved,
    productsQuantity: await repo.getWarehouseFreeStock?.(kitId, summaryWarehouseId)
  });

  return summary;
}

/** Пересчитать все комплекты, в состав которых входит товар. */
export async function recalculateKitsForComponent(componentProductId, opts = {}) {
  const pid = Number(componentProductId);
  if (!Number.isFinite(pid) || pid < 1) return [];

  const r = await query(
    `SELECT DISTINCT kit_product_id FROM kit_components WHERE component_product_id = $1`,
    [pid]
  );
  const kitIds = (r.rows || [])
    .map((row) => Number(row.kit_product_id))
    .filter((n) => Number.isFinite(n) && n > 0);

  for (const kitId of kitIds) {
    await persistKitStock(kitId, opts);
  }
  return kitIds;
}

/**
 * Остатки комплекта из БД (product_warehouse_stock + products).
 */
export async function readKitStockFromDb(kitProductId, opts = {}) {
  const kitId = Number(kitProductId);
  if (!Number.isFinite(kitId) || kitId < 1) {
    return { onHand: 0, incoming: 0, reserved: 0, suppliers: 0, available: 0 };
  }

  const warehouseId =
    opts.warehouseId != null && String(opts.warehouseId).trim() !== ''
      ? typeof opts.warehouseId === 'string'
        ? parseInt(opts.warehouseId, 10)
        : Number(opts.warehouseId)
      : null;

  let onHand = 0;
  if (warehouseId != null && Number.isFinite(warehouseId) && warehouseId > 0) {
    const r = await query(
      `SELECT COALESCE(quantity, 0)::int AS quantity
       FROM product_warehouse_stock WHERE product_id = $1 AND warehouse_id = $2`,
      [kitId, warehouseId]
    );
    onHand = Number(r.rows[0]?.quantity ?? 0) || 0;
  } else {
    const r = await query(
      `SELECT COALESCE(SUM(quantity), 0)::int AS quantity
       FROM product_warehouse_stock WHERE product_id = $1`,
      [kitId]
    );
    onHand = Number(r.rows[0]?.quantity ?? 0) || 0;
  }

  let incoming = 0;
  let reserved = 0;
  let suppliers = 0;
  try {
    const pr = await query(
      `SELECT COALESCE(incoming_quantity, 0)::int AS incoming_quantity,
              COALESCE(reserved_quantity, 0)::int AS reserved_quantity,
              COALESCE(kit_supplier_stock, 0)::int AS kit_supplier_stock
       FROM products WHERE id = $1`,
      [kitId]
    );
    const row = pr.rows[0] || {};
    incoming = Number(row.incoming_quantity ?? 0) || 0;
    reserved = Number(row.reserved_quantity ?? 0) || 0;
    suppliers = Number(row.kit_supplier_stock ?? 0) || 0;
  } catch (e) {
    if (!String(e?.message || '').includes('kit_supplier_stock')) {
      throw e;
    }
    const pr = await query(
      `SELECT COALESCE(incoming_quantity, 0)::int AS incoming_quantity,
              COALESCE(reserved_quantity, 0)::int AS reserved_quantity
       FROM products WHERE id = $1`,
      [kitId]
    );
    incoming = Number(pr.rows[0]?.incoming_quantity ?? 0) || 0;
    reserved = Number(pr.rows[0]?.reserved_quantity ?? 0) || 0;
  }

  const available = onHand + suppliers;
  return { onHand, incoming, reserved, suppliers, available };
}

/** Для отправки на МП: из БД, с вычетом резерва комплекта (как у обычного товара). */
export async function readKitMarketplaceStockFromDb(kitProductId, opts = {}) {
  const base = await readKitStockFromDb(kitProductId, opts);
  const reserved = base.reserved;
  const available = Math.max(0, Math.floor(base.onHand + base.suppliers - reserved));
  return {
    ...base,
    available,
    displayAvailable: Math.max(0, Math.floor(base.onHand + base.suppliers))
  };
}

export async function computeKitMarketplaceStock(kitProductId, opts = {}) {
  const data = await readKitMarketplaceStockFromDb(kitProductId, opts);
  return data.available;
}

/** Подставить в объект товара-комплекта остатки из БД. */
export async function enrichKitProductStock(product, opts = {}) {
  if (!product || !isKitProductType(product.product_type)) return product;
  const metrics = await readKitStockFromDb(product.id, opts);
  product.quantity = metrics.onHand;
  product.incoming_quantity = metrics.incoming;
  product.reserved_quantity = metrics.reserved;
  product.supplierStockTotal = metrics.suppliers;
  product.kit_quantity_derived = false;
  product.kit_stock_persisted = true;
  product.kit_display_stock = metrics;
  return product;
}

export function scheduleMarketplaceSyncForParentKits(componentProductId, opts = {}) {
  setImmediate(async () => {
    try {
      const pid = Number(componentProductId);
      if (!Number.isFinite(pid) || pid < 1) return;

      const kitIds = await recalculateKitsForComponent(pid, opts);

      for (const kitId of kitIds) {
        scheduleWarehouseStockMarketplaceSync(kitId, {
          source: opts.source || 'kit_component_changed',
          organizationId: opts.organizationId ?? null,
          warehouseId: opts.warehouseId ?? null,
          strictWarehouse:
            opts.warehouseId != null && String(opts.warehouseId).trim() !== ''
        });
      }
    } catch (e) {
      logger.warn('[Kit Stock] scheduleMarketplaceSyncForParentKits:', e?.message || e);
    }
  });
}

export async function getReservedKitUnitsForOrder(kitProductId, orderDbId) {
  const components = await getKitComponents(kitProductId);
  if (components.length === 0) return 0;
  const oid = Number(orderDbId);
  if (!Number.isFinite(oid) || oid < 1) return 0;

  let minKits = Infinity;
  for (const c of components) {
    const r = await query(
      `SELECT
         COALESCE(SUM(CASE WHEN type = 'reserve' THEN -quantity_change ELSE 0 END), 0)::int AS reserved,
         COALESCE(SUM(CASE WHEN type = 'unreserve' THEN quantity_change ELSE 0 END), 0)::int AS unreserved
       FROM stock_movements
       WHERE product_id = $1
         AND type IN ('reserve', 'unreserve')
         AND (meta->>'order_id')::bigint = $2::bigint`,
      [c.component_product_id, oid]
    );
    const row = r.rows?.[0];
    const reserved = row?.reserved != null ? Number(row.reserved) : 0;
    const unreserved = row?.unreserved != null ? Number(row.unreserved) : 0;
    const net = Math.max(0, reserved - unreserved);
    minKits = Math.min(minKits, Math.floor(net / c.quantity));
  }
  return Number.isFinite(minKits) ? Math.max(0, minKits) : 0;
}

export async function computeMaxKitUnitsReservable(kitProductId) {
  const components = await getKitComponents(kitProductId);
  if (components.length === 0) return 0;

  let minKits = Infinity;
  for (const c of components) {
    const supply = await getComponentWarehouseSupply(c.component_product_id);
    const kitsFromComp = Math.floor(supply.availableSupply / c.quantity);
    minKits = Math.min(minKits, kitsFromComp);
  }
  return Number.isFinite(minKits) ? Math.max(0, minKits) : 0;
}

export async function applyKitOrderReserve(kitProductId, kitsWanted, orderIdLabel, meta, applyReserveFn) {
  const kitId = Number(kitProductId);
  const wanted = Math.max(1, parseInt(kitsWanted, 10) || 1);
  const maxKits = await computeMaxKitUnitsReservable(kitId);
  const kitsToReserve = Math.min(wanted, maxKits);
  if (kitsToReserve <= 0) return 0;

  const components = await getKitComponents(kitId);
  for (const c of components) {
    const compQty = kitsToReserve * c.quantity;
    await applyReserveFn(c.component_product_id, compQty, orderIdLabel, {
      ...meta,
      kit_product_id: kitId,
      kit_units: kitsToReserve,
      component_per_kit: c.quantity
    });
  }

  await persistKitStock(kitId, {
    warehouseId: meta?.warehouse_id ?? meta?.warehouseId ?? null,
    organizationId: meta?.organizationId ?? null
  });

  scheduleWarehouseStockMarketplaceSync(kitId, {
    source: 'kit_order_reserve',
    organizationId: meta?.organizationId ?? null,
    warehouseId: meta?.warehouse_id ?? meta?.warehouseId ?? null,
    strictWarehouse:
      (meta?.warehouse_id ?? meta?.warehouseId) != null &&
      String(meta?.warehouse_id ?? meta?.warehouseId).trim() !== ''
  });

  return kitsToReserve;
}

export async function releaseAllReservesForOrder(orderDbId, orderIdLabel, unreserveFn) {
  const oid = Number(orderDbId);
  if (!Number.isFinite(oid) || oid < 1) return [];

  const r = await query(
    `SELECT product_id,
            GREATEST(0,
              COALESCE(SUM(CASE WHEN type = 'reserve' THEN -quantity_change
                                WHEN type = 'unreserve' THEN quantity_change
                                ELSE 0 END), 0)
            )::int AS net_reserved
     FROM stock_movements
     WHERE (meta->>'order_id')::bigint = $1::bigint
       AND type IN ('reserve', 'unreserve')
     GROUP BY product_id
     HAVING COALESCE(SUM(CASE WHEN type = 'reserve' THEN -quantity_change
                               WHEN type = 'unreserve' THEN quantity_change
                               ELSE 0 END), 0) > 0`,
    [oid]
  );

  const affected = [];
  for (const row of r.rows || []) {
    const pid = Number(row.product_id);
    const net = Number(row.net_reserved) || 0;
    if (!Number.isFinite(pid) || pid < 1 || net <= 0) continue;
    await unreserveFn(pid, net, orderIdLabel, { order_id: oid, orderId: orderIdLabel });
    scheduleMarketplaceSyncForParentKits(pid, { source: 'order_unreserve' });
    affected.push(pid);
  }
  return affected;
}

/** Массовый пересчёт всех комплектов (после миграции / админ). */
export async function recalculateAllKitStocks() {
  const r = await query(
    `SELECT id FROM products WHERE LOWER(TRIM(COALESCE(product_type::text, ''))) = 'kit'`
  );
  let n = 0;
  for (const row of r.rows || []) {
    await persistKitStock(row.id, {});
    n += 1;
  }
  return n;
}

/**
 * Для списка товаров: у комплектов с составом — «целое по карточке комплекта» / «полных комплектов из комплектующих»
 * (склад, в пути по карточке комплектующих, остатки у поставщиков по комплектующим).
 * Не зависит от того, попали ли комплектующие в ту же страницу ответа API.
 *
 * @param {object[]} products
 * @param {{ warehouseId?: number|string|null, warehouse_id?: number|string|null }} [options]
 */
export async function attachKitWarehouseSplitMetrics(products, options = {}) {
  if (!Array.isArray(products) || products.length === 0) return;

  const widRaw = options.warehouseId ?? options.warehouse_id ?? null;
  const warehouseIdParsed =
    widRaw != null && String(widRaw).trim() !== ''
      ? typeof widRaw === 'string'
        ? parseInt(widRaw, 10)
        : Number(widRaw)
      : null;
  const wid =
    warehouseIdParsed != null && Number.isFinite(warehouseIdParsed) && warehouseIdParsed > 0
      ? warehouseIdParsed
      : null;

  const kitRows = products.filter(
    (p) =>
      isKitProductType(p.product_type) &&
      Array.isArray(p.kit_components) &&
      p.kit_components.length > 0
  );
  if (kitRows.length === 0) return;

  const kitIds = [
    ...new Set(
      kitRows
        .map((p) => {
          const n = typeof p.id === 'string' ? parseInt(p.id, 10) : Number(p.id);
          return Number.isFinite(n) && n > 0 ? n : null;
        })
        .filter((x) => x != null)
    ),
  ];
  if (kitIds.length === 0) return;

  const pKit = [kitIds];
  const pKitWid = wid != null ? [kitIds, wid] : [kitIds];

  const wholeOnHandSql = wid
    ? `SELECT product_id::text AS kit_id, COALESCE(quantity, 0)::int AS v
       FROM product_warehouse_stock
       WHERE warehouse_id = $2 AND product_id = ANY($1::bigint[])`
    : `SELECT product_id::text AS kit_id, COALESCE(SUM(quantity), 0)::int AS v
       FROM product_warehouse_stock
       WHERE product_id = ANY($1::bigint[])
       GROUP BY product_id`;

  const fromOnHandSql = wid
    ? `SELECT kit_product_id::text AS kit_id, MIN(comp_kits)::int AS v
       FROM (
         SELECT kc.kit_product_id,
           FLOOR(COALESCE(SUM(pws.quantity), 0)::numeric / NULLIF(GREATEST(kc.quantity::numeric, 1), 0))::int AS comp_kits
         FROM kit_components kc
         LEFT JOIN product_warehouse_stock pws
           ON pws.product_id = kc.component_product_id AND pws.warehouse_id = $2
         WHERE kc.kit_product_id = ANY($1::bigint[])
         GROUP BY kc.kit_product_id, kc.component_product_id, kc.quantity
       ) t
       GROUP BY kit_product_id`
    : `SELECT kit_product_id::text AS kit_id, MIN(comp_kits)::int AS v
       FROM (
         SELECT kc.kit_product_id,
           FLOOR(COALESCE(SUM(pws.quantity), 0)::numeric / NULLIF(GREATEST(kc.quantity::numeric, 1), 0))::int AS comp_kits
         FROM kit_components kc
         LEFT JOIN product_warehouse_stock pws ON pws.product_id = kc.component_product_id
         WHERE kc.kit_product_id = ANY($1::bigint[])
         GROUP BY kc.kit_product_id, kc.component_product_id, kc.quantity
       ) t
       GROUP BY kit_product_id`;

  const wholeIncSql = `SELECT id::text AS kit_id, COALESCE(incoming_quantity, 0)::int AS v
     FROM products WHERE id = ANY($1::bigint[])`;

  const fromIncSql = `SELECT kit_product_id::text AS kit_id, MIN(comp_kits)::int AS v
     FROM (
       SELECT kc.kit_product_id,
         FLOOR(COALESCE(pr.incoming_quantity, 0)::numeric / NULLIF(GREATEST(kc.quantity::numeric, 1), 0))::int AS comp_kits
       FROM kit_components kc
       INNER JOIN products pr ON pr.id = kc.component_product_id
       WHERE kc.kit_product_id = ANY($1::bigint[])
     ) t
     GROUP BY kit_product_id`;

  const wholeSupSql = `SELECT product_id::text AS kit_id, COALESCE(SUM(stock), 0)::int AS v
     FROM supplier_stocks WHERE product_id = ANY($1::bigint[])
     GROUP BY product_id`;

  const fromSupSql = `SELECT kit_product_id::text AS kit_id, MIN(comp_kits)::int AS v
     FROM (
       SELECT kc.kit_product_id,
         FLOOR(COALESCE(ss.tot, 0) / NULLIF(GREATEST(kc.quantity::numeric, 1), 0))::int AS comp_kits
       FROM kit_components kc
       LEFT JOIN (
         SELECT product_id, SUM(stock)::numeric AS tot
         FROM supplier_stocks
         WHERE product_id IN (SELECT DISTINCT component_product_id FROM kit_components WHERE kit_product_id = ANY($1::bigint[]))
         GROUP BY product_id
       ) ss ON ss.product_id = kc.component_product_id
       WHERE kc.kit_product_id = ANY($1::bigint[])
     ) t
     GROUP BY kit_product_id`;

  const [
    wholeOnHandRes,
    fromOnHandRes,
    wholeIncRes,
    fromIncRes,
    wholeSupRes,
    fromSupRes
  ] = await Promise.all([
    query(wholeOnHandSql, pKitWid),
    query(fromOnHandSql, pKitWid),
    query(wholeIncSql, pKit),
    query(fromIncSql, pKit),
    query(wholeSupSql, pKit),
    query(fromSupSql, pKit)
  ]);

  const toMap = (res) => {
    const m = new Map();
    for (const row of res.rows || []) {
      const k = String(row.kit_id);
      m.set(k, Math.max(0, Number(row.v) || 0));
    }
    return m;
  };

  const mWholeOh = toMap(wholeOnHandRes);
  const mFromOh = toMap(fromOnHandRes);
  const mWholeIn = toMap(wholeIncRes);
  const mFromIn = toMap(fromIncRes);
  const mWholeSup = toMap(wholeSupRes);
  const mFromSup = toMap(fromSupRes);

  for (const p of kitRows) {
    const key = String(typeof p.id === 'string' ? parseInt(p.id, 10) : Number(p.id));
    p.kit_stock_split = {
      whole_on_hand: mWholeOh.get(key) ?? 0,
      from_components_on_hand: mFromOh.get(key) ?? 0,
      whole_incoming: mWholeIn.get(key) ?? 0,
      from_components_incoming: mFromIn.get(key) ?? 0,
      whole_suppliers: mWholeSup.get(key) ?? 0,
      from_components_suppliers: mFromSup.get(key) ?? 0
    };
  }
}

export default {
  isKitProductType,
  isKitProductId,
  findKitProductIdForMarketplaceOrder,
  getKitComponents,
  computeKitMetricsFromComponents,
  computeKitDisplayStock,
  computeMaxKitUnitsReservable,
  getReservedKitUnitsForOrder,
  computeKitMarketplaceStock,
  readKitStockFromDb,
  readKitMarketplaceStockFromDb,
  persistKitStock,
  recalculateKitsForComponent,
  recalculateAllKitStocks,
  enrichKitProductStock,
  scheduleMarketplaceSyncForParentKits,
  applyKitOrderReserve,
  releaseAllReservesForOrder,
  attachKitWarehouseSplitMetrics
};
