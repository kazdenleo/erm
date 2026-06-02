/**
 * Комплекты: поступление/отгрузка целым SKU — только если комплект реально на складе.
 * Резерв: целые комплекты — на SKU комплекта; сборка из деталей — на комплектующие.
 * Собираемость из комплектующих — для «Доступно», без записи в product_warehouse_stock комплекта.
 */

import { query } from '../config/database.js';
import repositoryFactory from '../config/repository-factory.js';
import { NET_RESERVED_SUM_EXPR_SQL } from '../constants/netReservedStockSql.js';
import {
  computeAvailableQuantity,
  getReservedQuantityFromMovements,
  getReservableSupplyUnits,
} from './sellableQuantity.service.js';
import { scheduleWarehouseStockMarketplaceSync } from './marketplaceWarehouseStockSync.service.js';
import { syncProductQuantityFromWarehouseStock } from './productWarehouseQuantity.service.js';
import logger from '../utils/logger.js';

export { syncProductQuantityFromWarehouseStock };

export function isKitProductType(raw) {
  return String(raw || '').toLowerCase() === 'kit';
}

/** Комплект в каталоге: product_type=kit, состав в kit_components или флаг с репозитория. */
export function isKitCatalogProduct(product) {
  if (!product || typeof product !== 'object') return false;
  if (isKitProductType(product.product_type ?? product.productType)) return true;
  if (product.is_kit_catalog === true || product.isKitCatalog === true) return true;
  const comps = product.kit_components ?? product.kitComponents;
  return Array.isArray(comps) && comps.length > 0;
}

/** Движения, меняющие фактическое наличие на складе по SKU комплекта (не резерв и не «в пути»). */
export const KIT_PHYSICAL_BALANCE_MOVEMENT_TYPES = [
  'receipt',
  'shipment',
  'writeoff',
  'inventory',
  'manual',
  'transfer',
  'opening_balance'
];

/**
 * Поступление целых комплектов на склад (1 SKU): приёмка, инвентаризация с плюсом и т.п.
 * Отгрузка (shipment) не считается — иначе фантомный pws не обнуляется после ошибочного списания.
 */
export const KIT_WHOLE_STOCK_INBOUND_TYPES = [
  'receipt',
  'inventory',
  'manual',
  'transfer',
  'opening_balance'
];

/** Типы движений в истории остатков комплекта (SKU + резерв/«в пути»). */
export const KIT_STOCK_HISTORY_MOVEMENT_TYPES = [
  ...KIT_PHYSICAL_BALANCE_MOVEMENT_TYPES,
  'reserve',
  'unreserve',
  'incoming'
];

export function isKitPhysicalBalanceMovementType(type) {
  return KIT_PHYSICAL_BALANCE_MOVEMENT_TYPES.includes(String(type || '').toLowerCase());
}

export function isKitStockHistoryMovementType(type) {
  return KIT_STOCK_HISTORY_MOVEMENT_TYPES.includes(String(type || '').toLowerCase());
}

/** Были ли движения по SKU комплекта (для истории и прочего). */
export async function kitHasPhysicalBalanceMovements(kitProductId) {
  const kitId = Number(kitProductId);
  if (!Number.isFinite(kitId) || kitId < 1) return false;
  const r = await query(
    `SELECT 1 FROM stock_movements
     WHERE product_id = $1
       AND LOWER(TRIM(type::text)) = ANY($2::text[])
     LIMIT 1`,
    [kitId, KIT_PHYSICAL_BALANCE_MOVEMENT_TYPES]
  );
  return (r.rows?.length ?? 0) > 0;
}

/** Была ли реальная приёмка/оприходование целых комплектов (1 SKU) на склад. */
export async function kitHasWholeKitInboundMovements(kitProductId) {
  const kitId = Number(kitProductId);
  if (!Number.isFinite(kitId) || kitId < 1) return false;
  const r = await query(
    `SELECT 1 FROM stock_movements
     WHERE product_id = $1
       AND LOWER(TRIM(type::text)) = ANY($2::text[])
       AND quantity_change > 0
     LIMIT 1`,
    [kitId, KIT_WHOLE_STOCK_INBOUND_TYPES]
  );
  return (r.rows?.length ?? 0) > 0;
}

export async function isKitProductId(productId) {
  const pid = Number(productId);
  if (!Number.isFinite(pid) || pid < 1) return false;
  const r = await query(
    `SELECT product_type FROM products WHERE id = $1 LIMIT 1`,
    [pid]
  );
  if (isKitProductType(r.rows[0]?.product_type)) return true;
  const kc = await query(
    `SELECT 1 FROM kit_components WHERE kit_product_id = $1 LIMIT 1`,
    [pid]
  );
  return (kc.rows?.length ?? 0) > 0;
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
  if (!Number.isFinite(pid) || pid < 1) return bySku ?? null;
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
  return kid != null ? Number(kid) : null;
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

/** Всего штук (комплектующих) в одном комплекте — сумма quantity по составу. */
export function totalPiecesPerKitUnit(components) {
  let sum = 0;
  for (const c of components || []) {
    sum += Math.max(1, parseInt(c.quantity, 10) || 1);
  }
  return sum > 0 ? sum : 1;
}

/**
 * kit_product_id → сколько штук в одном комплекте (батч для списка заказов).
 * @returns {Promise<Map<number, number>>}
 */
export async function batchPiecesPerKitUnitMap(kitProductIds) {
  const ids = [...new Set((kitProductIds || []).map((id) => Number(id)).filter((id) => id > 0))];
  const map = new Map();
  if (!ids.length) return map;
  const r = await query(
    `SELECT kit_product_id,
            COALESCE(SUM(GREATEST(1, quantity)), 0)::int AS pieces_per_kit
     FROM kit_components
     WHERE kit_product_id = ANY($1::int[])
     GROUP BY kit_product_id`,
    [ids]
  );
  for (const row of r.rows || []) {
    const kid = Number(row.kit_product_id);
    const pieces = Math.max(1, Number(row.pieces_per_kit) || 1);
    if (kid > 0) map.set(kid, pieces);
  }
  return map;
}

/**
 * component_product_id → kit_product_id (для строк заказа, привязанных к комплектующей).
 * @returns {Promise<Map<number, number>>}
 */
export async function batchKitIdByComponentMap(componentProductIds) {
  const ids = [...new Set((componentProductIds || []).map((id) => Number(id)).filter((id) => id > 0))];
  const map = new Map();
  if (!ids.length) return map;
  const r = await query(
    `SELECT DISTINCT ON (component_product_id) component_product_id, kit_product_id
     FROM kit_components
     WHERE component_product_id = ANY($1::int[])
     ORDER BY component_product_id, kit_product_id`,
    [ids]
  );
  for (const row of r.rows || []) {
    const cid = Number(row.component_product_id);
    const kid = Number(row.kit_product_id);
    if (cid > 0 && kid > 0 && !map.has(cid)) map.set(cid, kid);
  }
  return map;
}

/** Сумма quantity в составе комплекта для одного component_product_id (несколько строк — один товар). */
export function sumKitComponentQtyPerKit(components, componentProductId) {
  const pid = Number(componentProductId);
  if (!Number.isFinite(pid) || pid < 1) return 0;
  let sum = 0;
  for (const c of components || []) {
    if (Number(c.component_product_id) === pid) {
      sum += Math.max(1, parseInt(c.quantity, 10) || 1);
    }
  }
  return sum;
}

/**
 * Сколько зарезервировать/списать по каждому component_product_id для N комплектов.
 * @returns {Map<number, number>}
 */
export function buildKitComponentQtyMap(components, kitOrderQty) {
  const kits = Math.max(1, parseInt(kitOrderQty, 10) || 1);
  const map = new Map();
  for (const c of components || []) {
    const cid = Number(c.component_product_id);
    if (!Number.isFinite(cid) || cid < 1) continue;
    const perKit = Math.max(1, parseInt(c.quantity, 10) || 1);
    map.set(cid, (map.get(cid) || 0) + kits * perKit);
  }
  return map;
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
      `SELECT ${NET_RESERVED_SUM_EXPR_SQL}::int AS rv
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

/** @deprecated Не пишем производные остатки комплекта в БД — только движения по SKU комплекта. */
export async function persistKitStock(kitProductId, opts = {}) {
  const kitId = Number(kitProductId);
  if (!Number.isFinite(kitId) || kitId < 1) return null;
  return computeKitMetricsFromComponents(kitId, opts);
}

/** После изменения остатка комплектующего — пересчёт на МП для родительских комплектов (без движений по комплекту). */
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
    scheduleWarehouseStockMarketplaceSync(kitId, {
      source: opts.source || 'kit_component_changed',
      organizationId: opts.organizationId ?? null,
      warehouseId: opts.warehouseId ?? null,
      strictWarehouse:
        opts.warehouseId != null && String(opts.warehouseId).trim() !== ''
    });
  }
  return kitIds;
}

async function readKitWarehouseOnHandRaw(kitProductId, opts = {}) {
  const kitId = Number(kitProductId);
  if (!Number.isFinite(kitId) || kitId < 1) return 0;

  const warehouseId =
    opts.warehouseId != null && String(opts.warehouseId).trim() !== ''
      ? typeof opts.warehouseId === 'string'
        ? parseInt(opts.warehouseId, 10)
        : Number(opts.warehouseId)
      : null;

  if (warehouseId != null && Number.isFinite(warehouseId) && warehouseId > 0) {
    const r = await query(
      `SELECT COALESCE(quantity, 0)::int AS quantity
       FROM product_warehouse_stock WHERE product_id = $1 AND warehouse_id = $2`,
      [kitId, warehouseId]
    );
    return Number(r.rows[0]?.quantity ?? 0) || 0;
  }

  const r = await query(
    `SELECT COALESCE(SUM(quantity), 0)::int AS quantity
     FROM product_warehouse_stock WHERE product_id = $1`,
    [kitId]
  );
  return Number(r.rows[0]?.quantity ?? 0) || 0;
}

/**
 * Остатки комплекта из БД (product_warehouse_stock + products).
 */
export async function readKitStockFromDb(kitProductId, opts = {}) {
  const kitId = Number(kitProductId);
  if (!Number.isFinite(kitId) || kitId < 1) {
    return { onHand: 0, incoming: 0, reserved: 0, suppliers: 0, available: 0 };
  }

  const onHandRaw = await readKitWarehouseOnHandRaw(kitId, opts);

  let incoming = 0;
  let suppliers = 0;
  try {
    const pr = await query(
      `SELECT COALESCE(incoming_quantity, 0)::int AS incoming_quantity,
              COALESCE(kit_supplier_stock, 0)::int AS kit_supplier_stock
       FROM products WHERE id = $1`,
      [kitId]
    );
    const row = pr.rows[0] || {};
    incoming = Number(row.incoming_quantity ?? 0) || 0;
    suppliers = Number(row.kit_supplier_stock ?? 0) || 0;
  } catch (e) {
    if (!String(e?.message || '').includes('kit_supplier_stock')) {
      throw e;
    }
    const pr = await query(
      `SELECT COALESCE(incoming_quantity, 0)::int AS incoming_quantity
       FROM products WHERE id = $1`,
      [kitId]
    );
    incoming = Number(pr.rows[0]?.incoming_quantity ?? 0) || 0;
  }

  const physicalOnHand = await readKitPhysicalOnHandFromDb(kitId, onHandRaw);
  const reserved = await readKitDisplayReservedQuantity(kitId, opts);
  const available = physicalOnHand + suppliers;
  return { onHand: physicalOnHand, incoming, reserved, suppliers, available };
}

/**
 * Наличие комплекта на складе: только целые комплекты (1 SKU) после приёмки/инвентаризации.
 * Собираемость из комплектующих сюда не входит. Без inbound-движений — всегда 0.
 */
export async function readKitPhysicalOnHandFromDb(kitProductId, rawOnHand = null, opts = {}) {
  const kitId = Number(kitProductId);
  if (!Number.isFinite(kitId) || kitId < 1) return 0;

  const hasInbound = await kitHasWholeKitInboundMovements(kitId);
  if (!hasInbound) return 0;

  let onHand = rawOnHand;
  if (onHand == null) {
    onHand = await readKitWarehouseOnHandRaw(kitId, opts);
  }
  onHand = Math.max(0, Number(onHand) || 0);
  if (onHand <= 0) return 0;

  const fromJournal = await readKitOnHandFromMovementsBalance(kitId);
  if (fromJournal != null) {
    return Math.min(onHand, fromJournal);
  }
  return onHand;
}

/** Остаток по журналу (balance_after), без резерва и «в пути». */
async function readKitOnHandFromMovementsBalance(kitProductId) {
  const kitId = Number(kitProductId);
  if (!Number.isFinite(kitId) || kitId < 1) return null;
  const r = await query(
    `SELECT balance_after
     FROM stock_movements
     WHERE product_id = $1
       AND balance_after IS NOT NULL
       AND LOWER(TRIM(type::text)) = ANY($2::text[])
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
    [kitId, KIT_PHYSICAL_BALANCE_MOVEMENT_TYPES]
  );
  if (!r.rows?.length) return null;
  return Math.max(0, Number(r.rows[0].balance_after) || 0);
}

/** Для отправки на МП: собираемость из комплектующих + доступно по SKU комплекта. */
export async function readKitMarketplaceStockFromDb(kitProductId, opts = {}) {
  const base = await readKitStockFromDb(kitProductId, opts);
  const fromComponents = await computeAssemblableFromComponents(kitProductId, opts);
  const wholeAvail = Math.max(0, base.onHand + base.incoming + base.suppliers - base.reserved);
  const available = fromComponents + wholeAvail;
  return {
    ...base,
    available,
    displayAvailable: available
  };
}

export async function computeKitMarketplaceStock(kitProductId, opts = {}) {
  const data = await readKitMarketplaceStockFromDb(kitProductId, opts);
  return data.available;
}

/** Подставить в объект комплекта остатки только по SKU комплекта (без пересчёта из комплектующих). */
export async function enrichKitProductStock(product, opts = {}) {
  if (!product || !isKitCatalogProduct(product)) return product;
  const metrics = await readKitStockFromDb(product.id, opts);
  product.quantity = metrics.onHand;
  product.incoming_quantity = metrics.incoming;
  product.reserved_quantity = metrics.reserved;
  const supplierKitUnits = await computeKitSupplierUnitsFromComponents(product.id, opts);
  product.supplierStockTotal = supplierKitUnits;
  product.kit_quantity_derived = false;
  product.kit_stock_persisted = false;
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

/** Нетто-резерв на SKU комплекта (журнал по product_id комплекта, не комплектующие). */
export async function readKitSkuNetReserved(kitProductId, opts = {}) {
  const kitId = Number(kitProductId);
  if (!Number.isFinite(kitId) || kitId < 1) return 0;
  const whRaw = opts.warehouseId ?? opts.warehouse_id ?? null;
  const whId =
    whRaw != null && String(whRaw).trim() !== ''
      ? typeof whRaw === 'string'
        ? parseInt(whRaw, 10)
        : Number(whRaw)
      : null;
  const warehouseScoped = Number.isFinite(whId) && whId > 0;
  const r = warehouseScoped
    ? await query(
        `SELECT ${NET_RESERVED_SUM_EXPR_SQL}::int AS rv
         FROM stock_movements
         WHERE product_id = $1
           AND type IN ('reserve', 'unreserve')
           AND warehouse_id = $2`,
        [kitId, whId]
      )
    : await query(
        `SELECT ${NET_RESERVED_SUM_EXPR_SQL}::int AS rv
         FROM stock_movements
         WHERE product_id = $1
           AND type IN ('reserve', 'unreserve')`,
        [kitId]
      );
  return Number(r.rows?.[0]?.rv ?? 0) || 0;
}

/** min(floor(reserve_i / qty_in_kit)) с суммированием qty по одному component_product_id. */
function minKitUnitsFromComponentReserves(components, getReserved) {
  if (!components?.length) return 0;
  const qtyPerKitByComp = new Map();
  for (const c of components) {
    const pid = Number(c.component_product_id);
    if (!Number.isFinite(pid) || pid < 1) continue;
    const perKit = Math.max(1, parseInt(c.quantity, 10) || 1);
    qtyPerKitByComp.set(pid, (qtyPerKitByComp.get(pid) || 0) + perKit);
  }
  if (qtyPerKitByComp.size === 0) return 0;
  let minKits = Infinity;
  for (const [pid, perKit] of qtyPerKitByComp) {
    const compRes = Math.max(0, Number(getReserved(pid)) || 0);
    minKits = Math.min(minKits, Math.floor(compRes / perKit));
  }
  return Number.isFinite(minKits) ? Math.max(0, minKits) : 0;
}

/**
 * Резерв в колонке «Резерв» для комплекта: журнал по SKU комплекта; если там 0 — сумма резерва по комплектующим
 * (как в истории остатков комплекта, куда подмешиваются reserve/unreserve комплектующих).
 */
function kitTotalDisplayReservedFromContext(kitId, ctx) {
  const onSku = Math.max(0, ctx.reservedMap.get(kitId) || 0);
  if (onSku > 0) return onSku;
  const comps = ctx.componentsByKit?.get(kitId) || [];
  let compSum = 0;
  for (const c of comps) {
    const pid = Number(c.component_product_id ?? c.productId);
    if (!Number.isFinite(pid) || pid < 1) continue;
    compSum += Math.max(0, ctx.reservedMap.get(pid) || 0);
  }
  return compSum;
}

/** Сумма нетто-резерва по всем комплектующим комплекта (отдельно по каждому product_id). */
export async function sumKitComponentsNetReserved(kitProductId, opts = {}) {
  const kitId = Number(kitProductId);
  if (!Number.isFinite(kitId) || kitId < 1) return 0;
  const whRaw = opts.warehouseId ?? opts.warehouse_id ?? null;
  const whId =
    whRaw != null && String(whRaw).trim() !== ''
      ? typeof whRaw === 'string'
        ? parseInt(whRaw, 10)
        : Number(whRaw)
      : null;
  const warehouseScoped = Number.isFinite(whId) && whId > 0;
  try {
    const r = warehouseScoped
      ? await query(
          `SELECT COALESCE(SUM(sub.rv), 0)::int AS total
           FROM (
             SELECT sm.product_id,
               ${NET_RESERVED_SUM_EXPR_SQL}::int AS rv
             FROM stock_movements sm
             WHERE sm.product_id IN (
               SELECT kc.component_product_id FROM kit_components kc WHERE kc.kit_product_id = $1
             )
               AND sm.type IN ('reserve', 'unreserve')
               AND sm.warehouse_id = $2
             GROUP BY sm.product_id
           ) sub`,
          [kitId, whId]
        )
      : await query(
          `SELECT COALESCE(SUM(sub.rv), 0)::int AS total
           FROM (
             SELECT sm.product_id,
               ${NET_RESERVED_SUM_EXPR_SQL}::int AS rv
             FROM stock_movements sm
             WHERE sm.product_id IN (
               SELECT kc.component_product_id FROM kit_components kc WHERE kc.kit_product_id = $1
             )
               AND sm.type IN ('reserve', 'unreserve')
             GROUP BY sm.product_id
           ) sub`,
          [kitId]
        );
    return Number(r.rows?.[0]?.total ?? 0) || 0;
  } catch {
    return 0;
  }
}

export async function readKitDisplayReservedQuantity(kitProductId, opts = {}) {
  const kitId = Number(kitProductId);
  if (!Number.isFinite(kitId) || kitId < 1) return 0;
  const onSku = await readKitSkuNetReserved(kitId, opts);
  if (onSku > 0) return onSku;
  return sumKitComponentsNetReserved(kitId, opts);
}

export async function getNetReservedForOrderProduct(orderDbId, productId) {
  const oid = Number(orderDbId);
  const pid = Number(productId);
  if (!Number.isFinite(oid) || oid < 1 || !Number.isFinite(pid) || pid < 1) return 0;
  const r = await query(
    `SELECT ${NET_RESERVED_SUM_EXPR_SQL}::int AS rv
     FROM stock_movements
     WHERE product_id = $1
       AND type IN ('reserve', 'unreserve')
       AND (meta->>'order_id')::bigint = $2::bigint`,
    [pid, oid]
  );
  return Number(r.rows?.[0]?.rv ?? 0) || 0;
}

/** Сколько комплектов зарезервировано под заказ (целые на SKU комплекта + из комплектующих). */
export async function getReservedKitUnitsForOrder(kitProductId, orderDbId) {
  const kitId = Number(kitProductId);
  const oid = Number(orderDbId);
  if (!Number.isFinite(kitId) || kitId < 1 || !Number.isFinite(oid) || oid < 1) return 0;

  const onKit = await getNetReservedForOrderProduct(oid, kitId);

  const components = await getKitComponents(kitId);
  if (components.length === 0) return onKit;

  const fromComp = await (async () => {
    const nets = new Map();
    for (const c of components) {
      const pid = Number(c.component_product_id);
      if (!Number.isFinite(pid) || pid < 1 || nets.has(pid)) continue;
      nets.set(pid, await getNetReservedForOrderProduct(oid, pid));
    }
    return minKitUnitsFromComponentReserves(components, (pid) => nets.get(pid) ?? 0);
  })();
  return onKit + fromComp;
}

/**
 * Сколько полных комплектов можно «собрать» только из остатков поставщиков по комплектующим (min по составу).
 */
export async function computeKitSupplierUnitsFromComponents(kitProductId, opts = {}) {
  const kitId = Number(kitProductId);
  if (!Number.isFinite(kitId) || kitId < 1) return 0;

  const widRaw = opts.warehouseId ?? opts.warehouse_id ?? null;
  const wid =
    widRaw != null && String(widRaw).trim() !== ''
      ? typeof widRaw === 'string'
        ? parseInt(widRaw, 10)
        : Number(widRaw)
      : null;

  const components = await getKitComponents(kitId);
  if (components.length === 0) return 0;

  let minKits = Infinity;
  for (const c of components) {
    const perKit = Math.max(1, c.quantity);
    const metrics = await computeAvailableQuantity(c.component_product_id, {
      warehouseId: wid,
      profileId: opts.profileId ?? null
    });
    const supplierUnits = Math.floor((Number(metrics.suppliers) || 0) / perKit);
    minKits = Math.min(minKits, supplierUnits);
  }
  return Number.isFinite(minKits) ? Math.max(0, minKits) : 0;
}

/**
 * Доступность для резерва под заказ: PWS (наличие на складе) + incoming − резерв.
 * Остатки поставщиков не учитываются (только для колонки «Доступно» в остатках).
 */
export async function getComponentAssemblableUnits(componentProductId, opts = {}) {
  return getReservableSupplyUnits(componentProductId, opts);
}

/** Сколько полных комплектов можно собрать из комплектующих (склад + в пути − резерв). */
export async function computeAssemblableFromComponents(kitProductId, opts = {}) {
  const kitId = Number(kitProductId);
  if (!Number.isFinite(kitId) || kitId < 1) return 0;

  const components = await getKitComponents(kitId);
  if (components.length === 0) return 0;

  let minKits = Infinity;
  for (const c of components) {
    const perKit = Math.max(1, c.quantity);
    const available = await getComponentAssemblableUnits(c.component_product_id, opts);
    minKits = Math.min(minKits, Math.floor(available / perKit));
  }
  return Number.isFinite(minKits) ? Math.max(0, minKits) : 0;
}

/** Доступно к резерву: целые комплекты (1 SKU) и собираемость из комплектующих. */
export async function computeKitReservableBreakdown(kitProductId, opts = {}) {
  const kitId = Number(kitProductId);
  if (!Number.isFinite(kitId) || kitId < 1) {
    return { wholeAvail: 0, fromComponents: 0, total: 0 };
  }
  const fromComponents = await computeAssemblableFromComponents(kitId, opts);
  const whole = await readKitStockFromDb(kitId, opts);
  const onSkuReserved = await readKitSkuNetReserved(kitId);
  const wholeAvail = Math.max(
    0,
    (whole.onHand || 0) + (whole.incoming || 0) - onSkuReserved
  );
  const allocCap = allocateKitReservePriority(9999, {
    wholeAvail,
    fromComponents,
    physicalOnHand: whole.onHand || 0
  });
  return {
    wholeAvail,
    fromComponents,
    total: allocCap.kitsToReserve,
    physicalOnHand: whole.onHand || 0
  };
}

export async function computeMaxKitUnitsReservable(kitProductId, opts = {}) {
  const b = await computeKitReservableBreakdown(kitProductId, opts);
  return b.total;
}

/**
 * Сколько комплектов зарезервировать: сначала из наличия 1 SKU, остаток — из комплектующих.
 * @returns {{ kitsToReserve: number, fromWhole: number, fromComponents: number }}
 */
export function allocateKitReservePriority(kitsWanted, breakdown) {
  const wanted = Math.max(0, parseInt(kitsWanted, 10) || 0);
  const physicalOnHand = Math.max(0, Number(breakdown?.physicalOnHand) || 0);
  const wholeAvail = Math.max(0, Number(breakdown?.wholeAvail) || 0);
  const fromComponents = Math.max(0, Number(breakdown?.fromComponents) || 0);
  // Целый комплект: наличие + «в пути» на SKU комплекта (не только физический остаток).
  const wholePool = wholeAvail;
  const fromWhole = Math.min(wanted, wholePool);
  const fromComp = Math.min(Math.max(0, wanted - fromWhole), fromComponents);
  return {
    kitsToReserve: fromWhole + fromComp,
    fromWhole,
    fromComponents: fromComp
  };
}

/**
 * Резерв по заказу на комплект:
 * - целые комплекты (1 SKU) — резерв на product_id комплекта;
 * - сборка из деталей — резерв на комплектующие по составу.
 */
export async function applyKitOrderReserve(kitProductId, kitsWanted, orderIdLabel, meta, applyReserveFn) {
  const kitId = Number(kitProductId);
  const wanted = Math.max(1, parseInt(kitsWanted, 10) || 1);
  const whRaw = meta?.warehouse_id ?? meta?.warehouseId ?? null;
  const reserveOpts =
    whRaw != null && String(whRaw).trim() !== '' ? { warehouseId: whRaw } : { warehouseId: null };
  let breakdown = await computeKitReservableBreakdown(kitId, reserveOpts);
  let alloc = allocateKitReservePriority(wanted, breakdown);
  if (alloc.kitsToReserve <= 0 && reserveOpts.warehouseId != null) {
    breakdown = await computeKitReservableBreakdown(kitId, { warehouseId: null });
    alloc = allocateKitReservePriority(wanted, breakdown);
  }
  if (alloc.kitsToReserve <= 0) return 0;

  if (alloc.fromWhole > 0) {
    const wholeUnits = alloc.fromWhole;
    if (wholeUnits > 0) {
      await applyReserveFn(kitId, wholeUnits, orderIdLabel, {
        ...meta,
        kit_reserve_preallocated: wholeUnits,
        kit_reserve_from_whole: wholeUnits,
        kit_reserve_from_components: 0,
        kit_reserve_scope: 'whole'
      });
    }
  }

  if (alloc.fromComponents > 0) {
    const components = await getKitComponents(kitId);
    let canReserveFromComponents = components.length > 0;
    const compQtyMapCheck = buildKitComponentQtyMap(components, alloc.fromComponents);
    for (const [compId, compQty] of compQtyMapCheck) {
      const compAvail = await getComponentAssemblableUnits(compId, reserveOpts);
      if (compAvail < compQty) {
        canReserveFromComponents = false;
        break;
      }
    }
    if (!canReserveFromComponents) {
      alloc = {
        kitsToReserve: alloc.fromWhole,
        fromWhole: alloc.fromWhole,
        fromComponents: 0
      };
    }
  }

  if (alloc.fromComponents > 0) {
    const components = await getKitComponents(kitId);
    const compQtyMap = buildKitComponentQtyMap(components, alloc.fromComponents);
    for (const [compId, compQty] of compQtyMap) {
      await applyReserveFn(compId, compQty, orderIdLabel, {
        ...meta,
        kit_product_id: kitId,
        kit_reserve_from_whole: 0,
        kit_reserve_from_components: alloc.fromComponents,
        kit_reserve_scope: 'component',
        kit_units: alloc.fromComponents
      });
    }
    for (const c of components) {
      scheduleMarketplaceSyncForParentKits(c.component_product_id, {
        source: 'kit_order_reserve',
        organizationId: meta?.organizationId ?? null,
        warehouseId: meta?.warehouse_id ?? meta?.warehouseId ?? null
      });
    }
  }

  scheduleWarehouseStockMarketplaceSync(kitId, {
    source: 'kit_order_reserve',
    organizationId: meta?.organizationId ?? null,
    warehouseId: meta?.warehouse_id ?? meta?.warehouseId ?? null,
    strictWarehouse:
      (meta?.warehouse_id ?? meta?.warehouseId) != null &&
      String(meta?.warehouse_id ?? meta?.warehouseId).trim() !== ''
  });

  return alloc.kitsToReserve;
}

export async function releaseAllReservesForOrder(orderDbId, orderIdLabel, unreserveFn) {
  const oid = Number(orderDbId);
  if (!Number.isFinite(oid) || oid < 1) return [];

  const r = await query(
    `SELECT product_id,
            ${NET_RESERVED_SUM_EXPR_SQL}::int AS net_reserved
     FROM stock_movements
     WHERE (meta->>'order_id')::bigint = $1::bigint
       AND type IN ('reserve', 'unreserve')
     GROUP BY product_id
     HAVING ${NET_RESERVED_SUM_EXPR_SQL} > 0`,
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

/**
 * Обнулить фантомные остатки комплектов в product_warehouse_stock (без движений поступления/списания).
 * @returns {Promise<number>} число обнулённых строк pws
 */
export async function zeroPhantomKitWarehouseStock() {
  const kits = await query(
    `SELECT id FROM products WHERE LOWER(TRIM(COALESCE(product_type::text, ''))) = 'kit'`
  );
  let cleared = 0;
  for (const row of kits.rows || []) {
    const kitId = Number(row.id);
    if (!Number.isFinite(kitId) || kitId < 1) continue;
    const raw = await readKitWarehouseOnHandRaw(kitId, {});
    if (raw <= 0) continue;
    const hasInbound = await kitHasWholeKitInboundMovements(kitId);
    if (hasInbound) continue;
    await query(`UPDATE product_warehouse_stock SET quantity = 0 WHERE product_id = $1`, [kitId]);
    await syncProductQuantityFromWarehouseStock(kitId);
    cleared += 1;
  }
  return cleared;
}

/** Массовый пересчёт: только синхронизация остатков на МП (без движений по комплекту). */
export async function recalculateAllKitStocks() {
  const r = await query(
    `SELECT id FROM products WHERE LOWER(TRIM(COALESCE(product_type::text, ''))) = 'kit'`
  );
  let n = 0;
  for (const row of r.rows || []) {
    scheduleWarehouseStockMarketplaceSync(row.id, { source: 'recalculate_all_kits' });
    n += 1;
  }
  return n;
}

function parseWarehouseIdFromOpts(opts = {}) {
  const widRaw = opts.warehouseId ?? opts.warehouse_id ?? null;
  if (widRaw == null || String(widRaw).trim() === '') return null;
  const wid = typeof widRaw === 'string' ? parseInt(widRaw, 10) : Number(widRaw);
  return Number.isFinite(wid) && wid > 0 ? wid : null;
}

async function batchKitIdsWithWholeInbound(kitIds) {
  const ids = [...new Set(kitIds.filter((n) => Number.isFinite(n) && n > 0))];
  if (!ids.length) return new Set();
  const r = await query(
    `SELECT DISTINCT product_id
     FROM stock_movements
     WHERE product_id = ANY($1::bigint[])
       AND LOWER(TRIM(type::text)) = ANY($2::text[])
       AND quantity_change > 0`,
    [ids, KIT_WHOLE_STOCK_INBOUND_TYPES]
  );
  return new Set((r.rows || []).map((row) => Number(row.product_id)));
}

async function batchWarehouseOnHandMap(productIds, opts = {}) {
  const ids = [...new Set(productIds.filter((n) => Number.isFinite(n) && n > 0))];
  if (!ids.length) return new Map();
  const wid = parseWarehouseIdFromOpts(opts);
  if (wid != null) {
    const r = await query(
      `SELECT product_id, COALESCE(quantity, 0)::int AS quantity
       FROM product_warehouse_stock
       WHERE product_id = ANY($1::bigint[]) AND warehouse_id = $2`,
      [ids, wid]
    );
    return new Map((r.rows || []).map((row) => [Number(row.product_id), Number(row.quantity) || 0]));
  }
  const r = await query(
    `SELECT product_id, COALESCE(SUM(quantity), 0)::int AS quantity
     FROM product_warehouse_stock
     WHERE product_id = ANY($1::bigint[])
     GROUP BY product_id`,
    [ids]
  );
  return new Map((r.rows || []).map((row) => [Number(row.product_id), Number(row.quantity) || 0]));
}

async function batchNetReservedMap(productIds, opts = {}) {
  const ids = [...new Set(productIds.filter((n) => Number.isFinite(n) && n > 0))];
  if (!ids.length) return new Map();
  const whRaw = opts.warehouseId ?? opts.warehouse_id ?? null;
  const whId =
    whRaw != null && String(whRaw).trim() !== ''
      ? typeof whRaw === 'string'
        ? parseInt(whRaw,  10)
        : Number(whRaw)
      : null;
  const warehouseScoped = Number.isFinite(whId) && whId > 0;
  const r = warehouseScoped
    ? await query(
        `SELECT product_id,
         ${NET_RESERVED_SUM_EXPR_SQL}::int AS rv
       FROM stock_movements
       WHERE product_id = ANY($1::bigint[])
         AND type IN ('reserve', 'unreserve')
         AND warehouse_id = $2
       GROUP BY product_id`,
        [ids, whId]
      )
    : await query(
        `SELECT product_id,
         ${NET_RESERVED_SUM_EXPR_SQL}::int AS rv
       FROM stock_movements
       WHERE product_id = ANY($1::bigint[])
         AND type IN ('reserve', 'unreserve')
       GROUP BY product_id`,
        [ids]
      );
  return new Map((r.rows || []).map((row) => [Number(row.product_id), Number(row.rv) || 0]));
}

async function batchKitJournalBalanceMap(kitIds) {
  const ids = [...new Set(kitIds.filter((n) => Number.isFinite(n) && n > 0))];
  if (!ids.length) return new Map();
  const r = await query(
    `SELECT DISTINCT ON (product_id) product_id, balance_after
     FROM stock_movements
     WHERE product_id = ANY($1::bigint[])
       AND balance_after IS NOT NULL
       AND LOWER(TRIM(type::text)) = ANY($2::text[])
     ORDER BY product_id, created_at DESC, id DESC`,
    [ids, KIT_PHYSICAL_BALANCE_MOVEMENT_TYPES]
  );
  return new Map(
    (r.rows || []).map((row) => [
      Number(row.product_id),
      Math.max(0, Number(row.balance_after) || 0)
    ])
  );
}

async function batchIncomingMap(productIds) {
  const ids = [...new Set(productIds.filter((n) => Number.isFinite(n) && n > 0))];
  if (!ids.length) return new Map();
  const r = await query(
    `SELECT id, COALESCE(incoming_quantity, 0)::int AS incoming_quantity
     FROM products WHERE id = ANY($1::bigint[])`,
    [ids]
  );
  return new Map((r.rows || []).map((row) => [Number(row.id), Number(row.incoming_quantity) || 0]));
}

async function batchSupplierStockMap(productIds, opts = {}) {
  const ids = [...new Set(productIds.filter((n) => Number.isFinite(n) && n > 0))];
  const map = new Map();
  if (!ids.length || !repositoryFactory.isUsingPostgreSQL()) return map;
  const repo = repositoryFactory.getSupplierStocksRepository();
  if (!repo || typeof repo.findBreakdownByProductIds !== 'function') return map;
  const wid = parseWarehouseIdFromOpts(opts);
  const rows = await repo.findBreakdownByProductIds(ids, {
    mainWarehouseId: wid != null ? String(wid) : null,
    profileId: opts.profileId ?? null
  });
  for (const row of rows || []) {
    const pid = Number(row.product_id);
    map.set(pid, (map.get(pid) || 0) + (Number(row.stock) || 0));
  }
  return map;
}

export function kitPhysicalOnHandFromContext(kitId, ctx) {
  if (!ctx?.inboundSet?.has(kitId)) return 0;
  let onHand = Math.max(0, ctx.kitOnHandRaw.get(kitId) || 0);
  if (onHand <= 0) return 0;
  const journal = ctx.kitJournal.get(kitId);
  if (journal != null) return Math.min(onHand, journal);
  return onHand;
}

export function kitDisplayReservedFromContext(kitId, ctx) {
  return kitTotalDisplayReservedFromContext(kitId, ctx);
}

function assemblableFromContext(kitId, ctx) {
  const comps = ctx.componentsByKit.get(kitId) || [];
  if (comps.length === 0) return 0;
  let minKits = Infinity;
  for (const c of comps) {
    const pid = Number(c.component_product_id ?? c.productId);
    const perKit = Math.max(1, parseInt(c.quantity, 10) || 1);
    const avail = Math.max(
      0,
      (ctx.compOnHand.get(pid) || 0) +
        (ctx.compIncoming.get(pid) || 0) +
        (ctx.supplierMap.get(pid) || 0) -
        (ctx.reservedMap.get(pid) || 0)
    );
    minKits = Math.min(minKits, Math.floor(avail / perKit));
  }
  return Number.isFinite(minKits) ? Math.max(0, minKits) : 0;
}

function supplierKitUnitsFromContext(kitId, ctx) {
  const comps = ctx.componentsByKit.get(kitId) || [];
  if (comps.length === 0) return 0;
  let minKits = Infinity;
  for (const c of comps) {
    const pid = Number(c.component_product_id ?? c.productId);
    const perKit = Math.max(1, parseInt(c.quantity, 10) || 1);
    minKits = Math.min(minKits, Math.floor((ctx.supplierMap.get(pid) || 0) / perKit));
  }
  return Number.isFinite(minKits) ? Math.max(0, minKits) : 0;
}

/** Пакетная предзагрузка остатков комплектов для списка товаров (без N+1). */
export async function buildKitListStockContext(products, options = {}) {
  const kitRows = (products || []).filter((p) => isKitCatalogProduct(p));
  if (kitRows.length === 0) return null;

  const kitIds = kitRows
    .map((p) => (typeof p.id === 'string' ? parseInt(p.id, 10) : Number(p.id)))
    .filter((n) => Number.isFinite(n) && n > 0);

  const componentsByKit = new Map();
  const compIdSet = new Set();

  for (const p of kitRows) {
    const kitId = typeof p.id === 'string' ? parseInt(p.id, 10) : Number(p.id);
    const fromProduct = Array.isArray(p.kit_components) ? p.kit_components : null;
    if (fromProduct && fromProduct.length > 0) {
      const normalized = fromProduct.map((c) => ({
        component_product_id: Number(c.productId ?? c.component_product_id),
        quantity: Math.max(1, parseInt(c.quantity, 10) || 1)
      }));
      componentsByKit.set(kitId, normalized);
      for (const c of normalized) compIdSet.add(c.component_product_id);
    }
  }

  const missingKitIds = kitIds.filter((id) => !componentsByKit.has(id));
  if (missingKitIds.length > 0) {
    const r = await query(
      `SELECT kit_product_id, component_product_id, quantity
       FROM kit_components WHERE kit_product_id = ANY($1::bigint[])`,
      [missingKitIds]
    );
    for (const row of r.rows || []) {
      const kid = Number(row.kit_product_id);
      const cid = Number(row.component_product_id);
      if (!componentsByKit.has(kid)) componentsByKit.set(kid, []);
      componentsByKit.get(kid).push({
        component_product_id: cid,
        quantity: Math.max(1, parseInt(row.quantity, 10) || 1)
      });
      compIdSet.add(cid);
    }
  }

  const compIds = [...compIdSet];
  const [inboundSet, kitOnHandRaw, kitJournal, reservedMap, compOnHand, compIncoming, supplierMap] =
    await Promise.all([
      batchKitIdsWithWholeInbound(kitIds),
      batchWarehouseOnHandMap(kitIds, options),
      batchKitJournalBalanceMap(kitIds),
      batchNetReservedMap([...kitIds, ...compIds], options),
      batchWarehouseOnHandMap(compIds, options),
      batchIncomingMap(compIds),
      batchSupplierStockMap(compIds, options)
    ]);

  return {
    kitIds,
    componentsByKit,
    inboundSet,
    kitOnHandRaw,
    kitJournal,
    reservedMap,
    compOnHand,
    compIncoming,
    supplierMap
  };
}

/**
 * Метрики отображения для комплектов в списке остатков.
 * kit_display: whole_on_hand, assemblable_from_components, available_total.
 */
export async function attachKitDisplayMetrics(products, options = {}) {
  if (!Array.isArray(products) || products.length === 0) return;
  const ctx = options._kitCtx ?? (await buildKitListStockContext(products, options));
  if (!ctx) return;

  const kitRows = products.filter((p) => isKitCatalogProduct(p));
  for (const p of kitRows) {
    const kitId = typeof p.id === 'string' ? parseInt(p.id, 10) : Number(p.id);
    if (!Number.isFinite(kitId) || kitId < 1) continue;

    const wholeOnHand = kitPhysicalOnHandFromContext(kitId, ctx);
    const assemblable = assemblableFromContext(kitId, ctx);
    const supplierSyncOn = options.supplierSyncEnabled !== false;
    const supplierKitUnits = supplierSyncOn ? supplierKitUnitsFromContext(kitId, ctx) : 0;
    const incoming = Math.max(0, Number(p.incoming_quantity ?? p.incomingQuantity ?? 0) || 0);
    let reserved = kitDisplayReservedFromContext(kitId, ctx);
    if (reserved <= 0) {
      reserved = await readKitDisplayReservedQuantity(kitId, options);
    }
    const wholeAvail = Math.max(0, wholeOnHand + incoming - reserved);
    const availableTotal = assemblable + wholeAvail + supplierKitUnits;

    p.supplierStockTotal = supplierKitUnits;
    p.quantity = wholeOnHand;
    p.reserved_quantity = reserved;
    p.net_reserved_quantity = reserved;
    p.reservedQuantity = reserved;
    p.netReservedQuantity = reserved;
    p.kit_display = {
      whole_on_hand: wholeOnHand,
      assemblable_from_components: assemblable,
      supplier_kit_units: supplierKitUnits,
      available_total: availableTotal
    };
  }
}

/** @deprecated Используйте attachKitDisplayMetrics */
export const attachKitWarehouseSplitMetrics = attachKitDisplayMetrics;

export default {
  isKitProductType,
  isKitCatalogProduct,
  isKitProductId,
  findKitProductIdForMarketplaceOrder,
  getKitComponents,
  totalPiecesPerKitUnit,
  batchPiecesPerKitUnitMap,
  batchKitIdByComponentMap,
  sumKitComponentQtyPerKit,
  buildKitComponentQtyMap,
  computeKitMetricsFromComponents,
  computeKitDisplayStock,
  syncProductQuantityFromWarehouseStock,
  computeMaxKitUnitsReservable,
  computeKitReservableBreakdown,
  allocateKitReservePriority,
  getReservedKitUnitsForOrder,
  computeKitMarketplaceStock,
  readKitStockFromDb,
  readKitMarketplaceStockFromDb,
  persistKitStock,
  recalculateKitsForComponent,
  recalculateAllKitStocks,
  zeroPhantomKitWarehouseStock,
  enrichKitProductStock,
  scheduleMarketplaceSyncForParentKits,
  applyKitOrderReserve,
  releaseAllReservesForOrder,
  buildKitListStockContext,
  kitPhysicalOnHandFromContext,
  kitDisplayReservedFromContext,
  attachKitDisplayMetrics,
  attachKitWarehouseSplitMetrics,
  computeAssemblableFromComponents,
  getComponentAssemblableUnits,
  computeKitSupplierUnitsFromComponents,
  readKitPhysicalOnHandFromDb,
  readKitSkuNetReserved,
  readKitDisplayReservedQuantity,
  sumKitComponentsNetReserved,
  kitHasPhysicalBalanceMovements,
  kitHasWholeKitInboundMovements,
  KIT_WHOLE_STOCK_INBOUND_TYPES,
  isKitPhysicalBalanceMovementType,
  isKitStockHistoryMovementType,
  KIT_PHYSICAL_BALANCE_MOVEMENT_TYPES,
  KIT_STOCK_HISTORY_MOVEMENT_TYPES
};
