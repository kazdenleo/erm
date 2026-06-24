/**
 * Комплекты: поступление/отгрузка целым SKU — только если комплект реально на складе.
 * Резерв: целые комплекты — на SKU комплекта; сборка из деталей — на комплектующие.
 * Собираемость из комплектующих — для «Доступно», без записи в product_warehouse_stock комплекта.
 */

import { query } from '../config/database.js';
import repositoryFactory from '../config/repository-factory.js';
import {
  NET_RESERVED_SUM_EXPR_SQL,
  allocateWarehouseScopedIncoming,
  allocateWarehouseScopedReserved,
  orderReserveMovementMatchSql,
  parseStockMovementWarehouseId,
  warehouseScopedOnHandForAllocation
} from '../constants/netReservedStockSql.js';
import {
  computeAvailableQuantity,
  getReservedQuantityFromMovements,
  getProductSupplySnapshotWithClient,
  getReservableSupplyUnits,
} from './sellableQuantity.service.js';
import { scheduleWarehouseStockMarketplaceSync } from './marketplaceWarehouseStockSync.service.js';
import { syncProductQuantityFromWarehouseStock } from './productWarehouseQuantity.service.js';
import logger from '../utils/logger.js';
import { resolveProfileKitsEnabled } from '../utils/profileFeatureFlags.js';

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
  'opening_balance',
  'customer_return',
  'return_to_supplier'
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
  'opening_balance',
  'customer_return'
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
    `SELECT product_type, profile_id FROM products WHERE id = $1 LIMIT 1`,
    [pid]
  );
  if (!r.rows[0]) return false;
  let isKit = isKitProductType(r.rows[0]?.product_type);
  if (!isKit) {
    const kc = await query(
      `SELECT 1 FROM kit_components WHERE kit_product_id = $1 LIMIT 1`,
      [pid]
    );
    isKit = (kc.rows?.length ?? 0) > 0;
  }
  if (!isKit) return false;
  const profileId = r.rows[0].profile_id;
  if (profileId != null && !(await resolveProfileKitsEnabled(profileId))) {
    return false;
  }
  return true;
}

/** Товар используется как комплектующая хотя бы в одном комплекте. */
export async function isKitComponentProductId(productId) {
  const pid = Number(productId);
  if (!Number.isFinite(pid) || pid < 1) return false;
  const r = await query(
    `SELECT p.profile_id
     FROM kit_components kc
     JOIN products p ON p.id = kc.kit_product_id
     WHERE kc.component_product_id = $1
     LIMIT 1`,
    [pid]
  );
  if ((r.rows?.length ?? 0) === 0) return false;
  const profileId = r.rows[0]?.profile_id;
  if (profileId != null && !(await resolveProfileKitsEnabled(profileId))) {
    return false;
  }
  return true;
}

/** kit_product_id из meta резерва комплектующей под заказ. */
export async function findKitProductIdForOrderComponentReserve(productId, orderDbId) {
  const pid = Number(productId);
  const oid = Number(orderDbId);
  if (!Number.isFinite(pid) || pid < 1 || !Number.isFinite(oid) || oid < 1) return null;
  const r = await query(
    `SELECT DISTINCT (meta->>'kit_product_id')::bigint AS kit_id
     FROM stock_movements
     WHERE product_id = $1
       AND type IN ('reserve', 'unreserve')
       AND (meta->>'order_id')::bigint = $2
       AND meta ? 'kit_product_id'
       AND (meta->>'kit_product_id') ~ '^[0-9]+$'
     LIMIT 1`,
    [pid, oid]
  );
  const kid = r.rows?.[0]?.kit_id != null ? Number(r.rows[0].kit_id) : null;
  return Number.isFinite(kid) && kid > 0 ? kid : null;
}

/**
 * Снять резерв комплекта под заказ: сначала whole SKU, затем комплектующие по составу.
 * @returns {Promise<number>} сколько комплектов (единиц) снято
 */
export async function releaseKitOrderReserveUnits(
  kitProductId,
  orderDbId,
  kitUnitsToRelease,
  unreserveFn,
  baseMeta = {}
) {
  const kitId = Number(kitProductId);
  const oid = Number(orderDbId);
  const unitsWanted = Math.max(0, Math.floor(Number(kitUnitsToRelease) || 0));
  if (!Number.isFinite(kitId) || kitId < 1 || !Number.isFinite(oid) || oid < 1 || unitsWanted <= 0) {
    return 0;
  }
  if (typeof unreserveFn !== 'function') return 0;

  const mpLabel =
    baseMeta?.orderId != null && String(baseMeta.orderId).trim() !== ''
      ? String(baseMeta.orderId).trim()
      : null;
  const wh = baseMeta?.warehouse_id ?? baseMeta?.warehouseId ?? null;

  let remaining = unitsWanted;
  const onKit = await getNetReservedForOrderProduct(oid, kitId, mpLabel, wh);
  const fromWhole = Math.min(remaining, onKit);
  if (fromWhole > 0) {
    await unreserveFn(kitId, fromWhole, mpLabel, {
      ...baseMeta,
      kit_reserve_scope: 'whole',
      trim_kit_units: fromWhole
    });
    remaining -= fromWhole;
  }

  if (remaining > 0) {
    const components = await getKitComponents(kitId);
    const compQtyMap = buildKitComponentQtyMap(components, remaining);
    const releasedKitUnitsFromComp = [];
    for (const [compId, compQty] of compQtyMap) {
      const net = await getNetReservedForOrderProduct(oid, compId, mpLabel, wh);
      const release = Math.min(compQty, net);
      if (release <= 0) continue;
      const comp = components.find((c) => Number(c.component_product_id) === Number(compId));
      const perKit = comp ? Math.max(1, parseInt(comp.quantity, 10) || 1) : 1;
      await unreserveFn(compId, release, mpLabel, {
        ...baseMeta,
        kit_product_id: kitId,
        kit_reserve_scope: 'component',
        kit_units: remaining,
        trim_kit_units: remaining
      });
      releasedKitUnitsFromComp.push(Math.floor(release / perKit));
    }
    const fromComp =
      releasedKitUnitsFromComp.length > 0 ? Math.min(...releasedKitUnitsFromComp) : 0;
    return fromWhole + fromComp;
  }

  return fromWhole;
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

/** Все возможные артикулы из строки заказа (offer, sku, шаблоны в названии). */
export function collectOrderSkuCandidates(orderRow = {}) {
  const vendorCodes = [];
  const numericLike = [];
  const seen = new Set();
  const add = (v) => {
    const s = String(v ?? '').trim();
    if (!s) return;
    const key = s.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    if (/^\d{5,}$/.test(s)) numericLike.push(s);
    else vendorCodes.push(s);
  };
  add(orderRow.offerId ?? orderRow.offer_id);
  add(orderRow.sku ?? orderRow.marketplace_sku ?? orderRow.marketplaceSku);
  const name = String(orderRow.productName ?? orderRow.product_name ?? '').trim();
  if (name) {
    for (const m of name.matchAll(/\b([A-Z]{2,}[A-Z0-9]*(?:-[A-Z0-9][A-Z0-9-]*)+)\b/gi)) {
      add(m[1]);
    }
    for (const m of name.matchAll(/\b([A-Z]{2,}\d+[A-Z0-9-]{3,})\b/gi)) {
      add(m[1]);
    }
  }
  // Сначала vendorCode (DTTG5127RL), потом nmId — иначе nmId может сопоставиться с чужим комплектом.
  return [...vendorCodes, ...numericLike];
}

function expandSkuMatchTokens(sku, marketplace) {
  const s = String(sku ?? '').trim();
  if (!s) return [];
  const tokens = new Set([s, s.toLowerCase()]);
  const mp = marketplaceForProductSkus(marketplace);
  if (mp === 'wb') {
    const m = s.match(/([0-9]{5,})$/);
    if (m) tokens.add(m[1]);
  }
  return [...tokens];
}

async function loadKitSkuTokens(kitProductId, marketplace) {
  const mp = marketplaceForProductSkus(marketplace);
  const tokens = new Set();
  const r = await query(
    `SELECT TRIM(COALESCE(p.sku, '')) AS psku,
            ps.marketplace,
            TRIM(COALESCE(ps.sku, '')) AS msku
     FROM products p
     LEFT JOIN product_skus ps ON ps.product_id = p.id
     WHERE p.id = $1`,
    [kitProductId]
  );
  for (const row of r.rows || []) {
    for (const t of expandSkuMatchTokens(row.psku, marketplace)) tokens.add(t.toLowerCase());
    if (!row.msku) continue;
    if (!mp || row.marketplace === mp) {
      for (const t of expandSkuMatchTokens(row.msku, marketplace)) tokens.add(t.toLowerCase());
    }
  }
  return tokens;
}

/** Совпадает ли комплект с артикулами из заказа (offer / sku / название). */
async function kitProductMatchesOrderSku(kitProductId, orderRow, candidates = null) {
  const list = candidates ?? collectOrderSkuCandidates(orderRow);
  if (!list.length) return true;
  const kitTokens = await loadKitSkuTokens(kitProductId, orderRow.marketplace);
  if (!kitTokens.size) return false;
  for (const c of list) {
    for (const t of expandSkuMatchTokens(c, orderRow.marketplace)) {
      if (kitTokens.has(t.toLowerCase())) return true;
    }
  }
  return false;
}

/** Найти комплект по артикулу без привязки к маркетплейсу (products.sku / product_skus.sku). */
async function findKitProductIdBySkuAnyMarketplace(sku) {
  const val = String(sku ?? '').trim();
  if (!val) return null;
  const r = await query(
    `SELECT p.id AS kit_id
     FROM products p
     LEFT JOIN product_skus ps ON ps.product_id = p.id
     WHERE ${kitProductSql('p')}
       AND (
         TRIM(COALESCE(p.sku, '')) = TRIM($1)
         OR TRIM(COALESCE(ps.sku, '')) = TRIM($1)
       )
     ORDER BY
       CASE WHEN TRIM(COALESCE(p.sku, '')) = TRIM($1) THEN 0 ELSE 1 END,
       p.id
     LIMIT 1`,
    [val]
  );
  const kid = r.rows[0]?.kit_id;
  return kid != null ? Number(kid) : null;
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
     ORDER BY
       CASE
         WHEN ($2 <> '' AND TRIM(COALESCE(p.sku, '')) = TRIM($2)) THEN 0
         WHEN ($3 <> '' AND TRIM(COALESCE(p.sku, '')) = TRIM($3)) THEN 1
         WHEN ($2 <> '' AND TRIM(COALESCE(ps.sku, '')) = TRIM($2)) THEN 2
         WHEN ($3 <> '' AND TRIM(COALESCE(ps.sku, '')) = TRIM($3)) THEN 3
         ELSE 4
       END,
       p.id
     LIMIT 1`,
    params
  );
  const kid = r.rows[0]?.kit_id;
  if (kid != null) return Number(kid);

  for (const candidate of [off, sku].filter(Boolean)) {
    const anyMp = await findKitProductIdBySkuAnyMarketplace(candidate);
    if (anyMp != null) return anyMp;
  }
  return null;
}

/** Комплект по комплектующей — только если артикул заказа совпадает с SKU комплекта. */
async function findKitProductIdByComponentAndOrderSkus(componentProductId, orderRow, candidates) {
  const mp = marketplaceForProductSkus(orderRow.marketplace);
  if (!mp) return null;
  const compId = Number(componentProductId);
  if (!Number.isFinite(compId) || compId < 1) return null;

  const skuList = [
    ...new Set(
      (candidates || [])
        .flatMap((c) => expandSkuMatchTokens(c, orderRow.marketplace))
        .map((s) => String(s).trim())
        .filter(Boolean)
    ),
  ];
  if (!skuList.length) return null;

  const r = await query(
    `SELECT kc.kit_product_id
     FROM kit_components kc
     INNER JOIN products pk ON pk.id = kc.kit_product_id
     LEFT JOIN product_skus ps ON ps.product_id = kc.kit_product_id AND ps.marketplace = $2
     WHERE ${kitProductSql('pk')}
       AND kc.component_product_id = $1
       AND (
         TRIM(COALESCE(pk.sku, '')) = ANY($3::text[])
         OR TRIM(COALESCE(ps.sku, '')) = ANY($3::text[])
       )
     ORDER BY
       CASE WHEN TRIM(COALESCE(pk.sku, '')) = ANY($3::text[]) THEN 0 ELSE 1 END,
       kc.kit_product_id
     LIMIT 1`,
    [compId, mp, skuList]
  );
  const kid = r.rows[0]?.kit_product_id;
  return kid != null ? Number(kid) : null;
}

/**
 * Заказ на комплект (DTST4333RL): резерв/отгрузка по kit_components (2× DTST4333),
 * даже если в orders.product_id ошибочно указана комплектующая.
 */
export async function findKitProductIdForMarketplaceOrder(productId, orderRow = {}) {
  const offer = String(orderRow.offerId ?? orderRow.offer_id ?? '').trim();
  const msku = String(orderRow.marketplace_sku ?? orderRow.sku ?? '').trim();
  const candidates = collectOrderSkuCandidates(orderRow);

  for (const c of candidates) {
    const byCandidate = await findKitProductIdByOrderSku(orderRow.marketplace, c, c);
    if (byCandidate != null && (await kitProductMatchesOrderSku(byCandidate, orderRow, [c]))) {
      return byCandidate;
    }
  }

  const bySku = await findKitProductIdByOrderSku(orderRow.marketplace, offer, msku);
  if (bySku != null && (await kitProductMatchesOrderSku(bySku, orderRow, candidates))) {
    return bySku;
  }

  const pid = Number(productId);
  if (!Number.isFinite(pid) || pid < 1) return null;

  if (await isKitProductId(pid)) {
    if (await kitProductMatchesOrderSku(pid, orderRow, candidates)) return pid;
  } else {
    const byComponent = await findKitProductIdByComponentAndOrderSkus(pid, orderRow, candidates);
    if (byComponent != null) return byComponent;
  }

  return null;
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

  const physicalOnHand = await readKitPhysicalOnHandFromDb(kitId, onHandRaw, opts);
  const reserved = await readKitDisplayReservedQuantity(kitId, opts);
  const available = physicalOnHand + suppliers;
  return { onHand: physicalOnHand, incoming, reserved, suppliers, available };
}

/**
 * Наличие комплекта на складе: только целые комплекты (1 SKU) после приёмки/инвентаризации.
 * Собираемость из комплектующих сюда не входит. Без inbound-движений — fallback на PWS.
 */
export async function readKitPhysicalOnHandFromDb(kitProductId, rawOnHand = null, opts = {}) {
  const kitId = Number(kitProductId);
  if (!Number.isFinite(kitId) || kitId < 1) return 0;

  const warehouseScoped = parseWarehouseIdFromOpts(opts) != null;

  const hasInbound = await kitHasWholeKitInboundMovements(kitId);
  if (!hasInbound) {
    const pwsFallback = await readKitWarehouseOnHandRaw(kitId, opts);
    return Math.max(0, Number(pwsFallback) || 0);
  }

  let onHand = rawOnHand;
  if (onHand == null) {
    onHand = await readKitWarehouseOnHandRaw(kitId, opts);
  }
  onHand = Math.max(0, Number(onHand) || 0);
  if (onHand <= 0) return 0;

  // По складу остаток берём из product_warehouse_stock: balance_after в журнале —
  // сумма по всем складам и у сборки комплекта часто записывается как 0.
  if (warehouseScoped) {
    return onHand;
  }

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

/**
 * Метрики комплекта для экспорта на МП — та же формула, что в колонке «Доступно» (attachKitDisplayMetrics).
 */
export async function computeKitDisplayMetricsFromDb(kitProductId, options = {}) {
  const kitId = Number(kitProductId);
  const empty = {
    whole_on_hand: 0,
    whole_available: 0,
    assemblable_from_components: 0,
    supplier_kit_units: 0,
    marketplace_available: 0,
    available_total: 0
  };
  if (!Number.isFinite(kitId) || kitId < 1) return empty;

  const stub = { id: kitId, product_type: 'kit' };
  try {
    const pr = await query(
      `SELECT COALESCE(incoming_quantity, 0)::int AS incoming_quantity FROM products WHERE id = $1`,
      [kitId]
    );
    stub.incoming_quantity = Number(pr.rows[0]?.incoming_quantity ?? 0) || 0;
  } catch {
    stub.incoming_quantity = 0;
  }

  await attachKitDisplayMetrics([stub], options);
  return stub.kit_display ?? empty;
}

/**
 * На МП для комплектов: число в скобках «Доступно» — целые к продаже + собираемость из комплектующих.
 */
export function computeKitMarketplaceAvailableFromMetrics(display) {
  if (display?.marketplace_available != null) {
    return Math.max(0, Number(display.marketplace_available) || 0);
  }
  const wholeAvail = Math.max(
    0,
    Number(display?.whole_available ?? display?.wholeAvailable ?? display?.whole_on_hand) || 0
  );
  const assemblable = Math.max(0, Number(display?.assemblable_from_components) || 0);
  return Math.max(0, wholeAvail + assemblable);
}

/** @deprecated Используйте computeKitMarketplaceAvailableFromMetrics */
export function computeKitStockTableAvailableFromMetrics(display, { incoming = 0, reserved = 0 } = {}) {
  void incoming;
  void reserved;
  return computeKitMarketplaceAvailableFromMetrics(display);
}

/** Для отправки на МП: число в скобках колонки «Доступно» (целые + собираемость). */
export async function readKitMarketplaceStockFromDb(kitProductId, opts = {}) {
  const [base, display] = await Promise.all([
    readKitStockFromDb(kitProductId, opts),
    computeKitDisplayMetricsFromDb(kitProductId, opts)
  ]);
  const available = computeKitMarketplaceAvailableFromMetrics(display);
  return {
    ...base,
    onHand: Math.max(0, Number(display.whole_on_hand) || 0),
    suppliers: Math.max(0, Number(display.supplier_kit_units) || 0),
    available,
    displayAvailable: available,
    kit_display: display
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
  if (warehouseScoped) {
    return warehouseScopedNetReservedForProduct(kitId, whId);
  }
  const r = await query(
    `SELECT ${NET_RESERVED_SUM_EXPR_SQL}::int AS rv
     FROM stock_movements
     WHERE product_id = $1
       AND type IN ('reserve', 'unreserve')`,
    [kitId]
  );
  return Number(r.rows?.[0]?.rv ?? 0) || 0;
}

/**
 * Сколько комплектов зарезервировано: целые на SKU + из комплектующих (комплементарные пути).
 * При дубле (сумма > кол-ва в заказе) — max, не сумма.
 */
export function resolveComplementaryKitReserveUnits(onSku, fromComp, orderQty = null) {
  const sku = Math.max(0, Number(onSku) || 0);
  const comp = Math.max(0, Number(fromComp) || 0);
  if (sku <= 0) return comp;
  if (comp <= 0) return sku;
  const qty =
    orderQty != null && !Number.isNaN(Number(orderQty))
      ? Math.max(0, Math.floor(Number(orderQty)) || 0)
      : 0;
  if (qty > 0 && sku + comp <= qty) return sku + comp;
  return Math.max(sku, comp);
}

/** Итоговый резерв комплекта в колонке «Резерв» (глобально по SKU). */
function resolveKitDisplayReservedQty(onSku, fromComp) {
  const sku = Math.max(0, Number(onSku) || 0);
  const comp = Math.max(0, Number(fromComp) || 0);
  if (sku > 0 && comp > 0) return sku + comp;
  if (sku > 0) return sku;
  return comp;
}

async function warehouseScopedNetReservedForProduct(productId, whId) {
  const pid = Number(productId);
  const wh = Number(whId);
  if (!Number.isFinite(pid) || pid < 1 || !Number.isFinite(wh) || wh < 1) return 0;
  const [strictR, nullR, onHandR, whOnHandR] = await Promise.all([
    query(
      `SELECT ${NET_RESERVED_SUM_EXPR_SQL}::int AS rv
       FROM stock_movements
       WHERE product_id = $1 AND type IN ('reserve', 'unreserve') AND warehouse_id = $2`,
      [pid, wh]
    ),
    query(
      `SELECT ${NET_RESERVED_SUM_EXPR_SQL}::int AS rv
       FROM stock_movements
       WHERE product_id = $1 AND type IN ('reserve', 'unreserve') AND warehouse_id IS NULL`,
      [pid]
    ),
    query(
      `SELECT COALESCE(SUM(quantity), 0)::int AS pws_qty,
              (SELECT COALESCE(quantity, 0)::int FROM products WHERE id = $1) AS product_qty
       FROM product_warehouse_stock
       WHERE product_id = $1`,
      [pid]
    ),
    query(
      `SELECT COALESCE(quantity, 0)::int AS qty
       FROM product_warehouse_stock
       WHERE product_id = $1 AND warehouse_id = $2`,
      [pid, wh]
    )
  ]);
  const strict = Number(strictR.rows[0]?.rv ?? 0) || 0;
  const nullReserve = Number(nullR.rows[0]?.rv ?? 0) || 0;
  const totalOnHand = Number(onHandR.rows[0]?.pws_qty ?? 0) || 0;
  const legacyProductQty = Number(onHandR.rows[0]?.product_qty ?? 0) || 0;
  const whOnHand = warehouseScopedOnHandForAllocation({
    whOnHand: Number(whOnHandR.rows[0]?.qty ?? 0) || 0,
    totalOnHand,
    legacyProductQty
  });
  return allocateWarehouseScopedReserved({
    strict,
    nullReserve,
    whOnHand,
    totalOnHand,
    legacyProductQty
  });
}

async function warehouseScopedNetReservedMap(productIds, whId) {
  const ids = [...new Set((productIds || []).map((id) => Number(id)).filter((id) => id > 0))];
  const wh = Number(whId);
  if (!ids.length || !Number.isFinite(wh) || wh < 1) return new Map();
  const [strictR, nullR, onHandR, whOnHandR, legacyR] = await Promise.all([
    query(
      `SELECT product_id, ${NET_RESERVED_SUM_EXPR_SQL}::int AS rv
       FROM stock_movements
       WHERE product_id = ANY($1::bigint[])
         AND type IN ('reserve', 'unreserve')
         AND warehouse_id = $2
       GROUP BY product_id`,
      [ids, wh]
    ),
    query(
      `SELECT product_id, ${NET_RESERVED_SUM_EXPR_SQL}::int AS rv
       FROM stock_movements
       WHERE product_id = ANY($1::bigint[])
         AND type IN ('reserve', 'unreserve')
         AND warehouse_id IS NULL
       GROUP BY product_id`,
      [ids]
    ),
    query(
      `SELECT product_id, COALESCE(SUM(quantity), 0)::int AS pws_qty
       FROM product_warehouse_stock
       WHERE product_id = ANY($1::bigint[])
       GROUP BY product_id`,
      [ids]
    ),
    query(
      `SELECT product_id, COALESCE(quantity, 0)::int AS qty
       FROM product_warehouse_stock
       WHERE product_id = ANY($1::bigint[]) AND warehouse_id = $2`,
      [ids, wh]
    ),
    query(
      `SELECT id, COALESCE(quantity, 0)::int AS product_qty
       FROM products WHERE id = ANY($1::bigint[])`,
      [ids]
    )
  ]);
  const strictMap = new Map(
    (strictR.rows || []).map((row) => [Number(row.product_id), Number(row.rv) || 0])
  );
  const nullMap = new Map(
    (nullR.rows || []).map((row) => [Number(row.product_id), Number(row.rv) || 0])
  );
  const totalOnHandMap = new Map(
    (onHandR.rows || []).map((row) => [Number(row.product_id), Number(row.pws_qty) || 0])
  );
  const whOnHandMap = new Map(
    (whOnHandR.rows || []).map((row) => [Number(row.product_id), Number(row.qty) || 0])
  );
  const legacyMap = new Map(
    (legacyR.rows || []).map((row) => [Number(row.id), Number(row.product_qty) || 0])
  );
  const map = new Map();
  for (const pid of ids) {
    const totalOnHand = totalOnHandMap.get(pid) ?? 0;
    const legacyProductQty = legacyMap.get(pid) ?? 0;
    const whOnHand = warehouseScopedOnHandForAllocation({
      whOnHand: whOnHandMap.get(pid) ?? 0,
      totalOnHand,
      legacyProductQty
    });
    map.set(
      pid,
      allocateWarehouseScopedReserved({
        strict: strictMap.get(pid) ?? 0,
        nullReserve: nullMap.get(pid) ?? 0,
        whOnHand,
        totalOnHand: totalOnHand > 0 ? totalOnHand : legacyProductQty,
        legacyProductQty
      })
    );
  }
  return map;
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

async function minKitUnitsFromComponentReservesAsync(components, getReservedAsync) {
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
    const compRes = Math.max(0, Number(await getReservedAsync(pid)) || 0);
    minKits = Math.min(minKits, Math.floor(compRes / perKit));
  }
  return Number.isFinite(minKits) ? Math.max(0, minKits) : 0;
}

/**
 * Резерв в колонке «Резерв» для комплекта — в таблице остатков только SKU комплекта;
 * для сводок/истории — readKitDisplayReservedQuantity (SKU + сборка из комплектующих).
 */
function kitTotalDisplayReservedFromContext(kitId, ctx) {
  const onSku = Math.max(0, ctx.reservedMap.get(kitId) || 0);
  const comps = ctx.componentsByKit?.get(kitId) || [];
  const fromComp = comps.length
    ? minKitUnitsFromComponentReserves(comps, (pid) => ctx.reservedMap.get(pid) ?? 0)
    : 0;
  return resolveKitDisplayReservedQty(onSku, fromComp);
}

/** Map component_product_id → нетто-резерв (warehouse-scoped, как sumKitComponentsNetReserved). */
export async function readKitComponentsNetReservedMap(kitProductId, opts = {}) {
  const kitId = Number(kitProductId);
  if (!Number.isFinite(kitId) || kitId < 1) return new Map();

  const whRaw = opts.warehouseId ?? opts.warehouse_id ?? null;
  const whId =
    whRaw != null && String(whRaw).trim() !== ''
      ? typeof whRaw === 'string'
        ? parseInt(whRaw, 10)
        : Number(whRaw)
      : null;
  const warehouseScoped = Number.isFinite(whId) && whId > 0;

  try {
    if (warehouseScoped) {
      const compIds = (await getKitComponents(kitId)).map((c) => c.component_product_id);
      const journalMap = await warehouseScopedNetReservedMap(compIds, whId);
      const { batchOrderAttributedReservedMap, mergeJournalAndOrderAttributedReserved } =
        await import('./orderAttributedReserve.service.js');
      const orderMap = await batchOrderAttributedReservedMap(compIds, opts);
      const map = new Map();
      for (const pid of compIds) {
        const n = Number(pid);
        if (!Number.isFinite(n) || n < 1) continue;
        map.set(
          n,
          mergeJournalAndOrderAttributedReserved(journalMap.get(n) ?? 0, orderMap.get(n) ?? 0)
        );
      }
      return map;
    }
    const r = await query(
      `SELECT sm.product_id,
         ${NET_RESERVED_SUM_EXPR_SQL}::int AS rv
       FROM stock_movements sm
       WHERE sm.product_id IN (
         SELECT kc.component_product_id FROM kit_components kc WHERE kc.kit_product_id = $1
       )
         AND sm.type IN ('reserve', 'unreserve')
       GROUP BY sm.product_id`,
      [kitId]
    );
    const journalMap = new Map();
    for (const row of r.rows || []) {
      const pid = Number(row.product_id);
      if (!Number.isFinite(pid) || pid < 1) continue;
      journalMap.set(pid, Math.max(0, Number(row.rv) || 0));
    }
    const compIds = [...journalMap.keys()];
    const { batchOrderAttributedReservedMap, mergeJournalAndOrderAttributedReserved } =
      await import('./orderAttributedReserve.service.js');
    const orderMap = await batchOrderAttributedReservedMap(compIds, opts);
    const map = new Map();
    for (const pid of compIds) {
      map.set(
        pid,
        mergeJournalAndOrderAttributedReserved(journalMap.get(pid) ?? 0, orderMap.get(pid) ?? 0)
      );
    }
    return map;
  } catch {
    return new Map();
  }
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
               AND (sm.warehouse_id = $2 OR sm.warehouse_id IS NULL)
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

/**
 * Резерв в колонке «Резерв» таблицы остатков: только целые комплекты (SKU комплекта).
 * Резерв под сборку из деталей — в колонке комплектующих (шт.), не дублируем на строке комплекта.
 */
export async function readKitStockTableReservedQuantity(kitProductId, opts = {}) {
  return readKitSkuNetReserved(kitProductId, opts);
}

/** Полный резерв комплекта (SKU + сборка из комплектующих) — заказы, история, сверка. */
export async function readKitDisplayReservedQuantity(kitProductId, opts = {}) {
  const kitId = Number(kitProductId);
  if (!Number.isFinite(kitId) || kitId < 1) return 0;
  const onSku = await readKitSkuNetReserved(kitId, opts);
  const components = await getKitComponents(kitId);
  if (components.length === 0) return onSku > 0 ? onSku : 0;
  const compMap = await readKitComponentsNetReservedMap(kitId, opts);
  const fromComp = minKitUnitsFromComponentReserves(components, (pid) => compMap.get(pid) ?? 0);
  return resolveKitDisplayReservedQty(onSku, fromComp);
}

/**
 * Резерв комплектующих по отдельным строкам ручного заказа (не сборка под строку комплекта).
 * @returns {Promise<Map<number, number>>} component_product_id → шт. в резерве
 */
export async function manualLooseComponentReservesByProduct(kitProductId, opts = {}) {
  const kitId = Number(kitProductId);
  if (!Number.isFinite(kitId) || kitId < 1) return new Map();

  const components = await getKitComponents(kitId);
  const compIds = components
    .map((c) => Number(c.component_product_id))
    .filter((id) => Number.isFinite(id) && id > 0);
  if (!compIds.length) return new Map();

  const profileId = opts.profileId != null ? Number(opts.profileId) : null;
  const whId = parseStockMovementWarehouseId(opts.warehouseId ?? opts.warehouse_id);

  const params = [kitId, compIds];
  let profileSql = '';
  if (Number.isFinite(profileId) && profileId > 0) {
    params.push(profileId);
    profileSql = `AND o.profile_id = $${params.length}`;
  }

  const r = await query(
    `SELECT o.id, o.product_id
     FROM orders o
     WHERE o.marketplace = 'manual'
       AND o.product_id = ANY($2::bigint[])
       AND o.product_id <> $1
       AND o.order_group_id IS NOT NULL
       AND TRIM(o.order_group_id) <> ''
       AND EXISTS (
         SELECT 1 FROM orders ok
         WHERE ok.marketplace = 'manual'
           AND ok.order_group_id = o.order_group_id
           AND ok.product_id = $1
       )
       ${profileSql}`,
    params
  );

  const out = new Map();
  for (const row of r.rows || []) {
    const pid = Number(row.product_id);
    const oid = Number(row.id);
    if (!Number.isFinite(pid) || pid < 1 || !Number.isFinite(oid) || oid < 1) continue;
    const net = await getNetReservedForOrderProduct(oid, pid, null, whId);
    if (net <= 0) continue;
    out.set(pid, (out.get(pid) || 0) + net);
  }
  return out;
}

/**
 * Колонка «Резерв» комплекта в модалке остатков: без двойного учёта комплектующих,
 * зарезервированных отдельными строками ручного заказа (те же SKU, но другая позиция заказа).
 */
export async function readKitDisplayReservedQuantityForStockSummary(kitProductId, opts = {}) {
  const kitId = Number(kitProductId);
  if (!Number.isFinite(kitId) || kitId < 1) return 0;
  const onSku = await readKitSkuNetReserved(kitId, opts);
  const components = await getKitComponents(kitId);
  if (components.length === 0) return onSku > 0 ? onSku : 0;
  const compMap = await readKitComponentsNetReservedMap(kitId, opts);
  // Двойной учёт (SKU + комплектующие) бывает только при резерве на SKU комплекта.
  const looseMap =
    onSku > 0 ? await manualLooseComponentReservesByProduct(kitId, opts) : new Map();
  const fromComp = minKitUnitsFromComponentReserves(components, (pid) => {
    const gross = compMap.get(pid) ?? 0;
    const loose = looseMap.get(pid) ?? 0;
    return Math.max(0, gross - loose);
  });
  return resolveKitDisplayReservedQty(onSku, fromComp);
}

/**
 * План отгрузки комплекта по заказу: целые SKU и/или комплектующие, без двойного списания.
 * @returns {Promise<{ wholeUnitsToShip: number, componentKitUnitsToShip: number }>}
 */
export async function resolveKitOrderShipmentPlan(kitProductId, orderDbId, opts = {}) {
  const kitId = Number(kitProductId);
  const oid = Number(orderDbId);
  if (!Number.isFinite(kitId) || kitId < 1 || !Number.isFinite(oid) || oid < 1) {
    return { wholeUnitsToShip: 0, componentKitUnitsToShip: 0 };
  }

  const kitOrderQty = Math.max(1, parseInt(opts.kitOrderQty, 10) || 1);
  const marketplaceOrderId = opts.marketplaceOrderId ?? null;
  const warehouseId = opts.warehouseId ?? opts.warehouse_id ?? null;
  const getShippedQtyForProduct = opts.getShippedQtyForProduct;
  if (typeof getShippedQtyForProduct !== 'function') {
    return { wholeUnitsToShip: 0, componentKitUnitsToShip: 0 };
  }

  const components = await getKitComponents(kitId);

  const kitNet = await getNetReservedForOrderProduct(oid, kitId, marketplaceOrderId, warehouseId);
  const wholeShipped = Math.max(0, Number(await getShippedQtyForProduct(oid, kitId)) || 0);

  const kitsShippedViaComp =
    components.length > 0
      ? await minKitUnitsFromComponentReservesAsync(components, (pid) =>
          getShippedQtyForProduct(oid, pid)
        )
      : 0;

  const orderKitsRemaining = Math.max(0, kitOrderQty - wholeShipped - kitsShippedViaComp);

  const compKitUnitsReserved =
    components.length > 0
      ? await minKitUnitsFromComponentReservesAsync(components, (pid) =>
          getNetReservedForOrderProduct(oid, pid, marketplaceOrderId, warehouseId)
        )
      : 0;
  const compKitUnitsRemaining = Math.max(0, compKitUnitsReserved - kitsShippedViaComp);

  const physicalWhole = await readKitPhysicalOnHandFromDb(kitId, null, { warehouseId });
  // Резерв на SKU комплекта — план по резерву; иначе — по наличию (догоняющее списание после снятия резерва).
  const wholeUnitsRemaining =
    kitNet > 0
      ? Math.max(0, kitNet - wholeShipped)
      : Math.max(0, physicalWhole - wholeShipped);
  const wholeUnitsToShip = Math.min(orderKitsRemaining, wholeUnitsRemaining);
  const orderAfterWhole = orderKitsRemaining - wholeUnitsToShip;
  let componentKitUnitsToShip = Math.min(orderAfterWhole, compKitUnitsRemaining);

  const totalPlanned = wholeUnitsToShip + componentKitUnitsToShip;
  if (totalPlanned > orderKitsRemaining) {
    componentKitUnitsToShip = Math.max(0, orderKitsRemaining - wholeUnitsToShip);
  }

  return { wholeUnitsToShip, componentKitUnitsToShip };
}

/** Резерв комплекта по заказу превышает фактическое наличие на складе (без «в пути»). */
export async function kitOrderReserveExceedsOnHand(
  kitProductId,
  orderDbId,
  warehouseId,
  marketplaceOrderId = null
) {
  const kitId = Number(kitProductId);
  const oid = Number(orderDbId);
  const whId = parseStockMovementWarehouseId(warehouseId);
  if (!Number.isFinite(kitId) || kitId < 1 || !Number.isFinite(oid) || oid < 1) return false;

  const kitNet = await getNetReservedForOrderProduct(oid, kitId, marketplaceOrderId, whId);
  if (kitNet > 0) {
    const physicalWhole = await readKitPhysicalOnHandFromDb(kitId, null, { warehouseId: whId });
    if (kitNet > physicalWhole) return true;
  }

  const components = await getKitComponents(kitId);
  for (const c of components) {
    const pid = Number(c.component_product_id);
    if (!Number.isFinite(pid) || pid < 1) continue;
    const net = await getNetReservedForOrderProduct(oid, pid, marketplaceOrderId, whId);
    if (net <= 0) continue;
    const metrics = await computeAvailableQuantity(pid, { warehouseId: whId });
    const onHand = Math.max(0, Number(metrics.onHand) || 0);
    if (net > onHand) return true;
  }
  return false;
}

export async function getNetReservedForOrderProduct(
  orderDbId,
  productId,
  marketplaceOrderId = null,
  warehouseId = null
) {
  const oid = Number(orderDbId);
  const pid = Number(productId);
  const mpLabel =
    marketplaceOrderId != null && String(marketplaceOrderId).trim() !== ''
      ? String(marketplaceOrderId).trim()
      : null;
  const whId = parseStockMovementWarehouseId(warehouseId);
  if (!Number.isFinite(pid) || pid < 1) return 0;
  if ((!Number.isFinite(oid) || oid < 1) && !mpLabel) return 0;
  const params = [pid, Number.isFinite(oid) && oid >= 1 ? oid : 0, mpLabel];
  let whSql = '';
  if (whId != null) {
    params.push(whId);
    whSql = ` AND warehouse_id = $${params.length}`;
  }
  const r = await query(
    `SELECT ${NET_RESERVED_SUM_EXPR_SQL}::int AS rv
     FROM stock_movements
     WHERE product_id = $1
       AND type IN ('reserve', 'unreserve')
       AND ${orderReserveMovementMatchSql('', 2, 3)}${whSql}`,
    params
  );
  const scoped = Number(r.rows?.[0]?.rv ?? 0) || 0;
  if (scoped > 0 || whId == null) return scoped;

  // Резерв без warehouse_id — при отгрузке со склада всё равно должен сниматься.
  const globalRes = await query(
    `SELECT ${NET_RESERVED_SUM_EXPR_SQL}::int AS rv
     FROM stock_movements
     WHERE product_id = $1
       AND type IN ('reserve', 'unreserve')
       AND ${orderReserveMovementMatchSql('', 2, 3)}`,
    [pid, Number.isFinite(oid) && oid >= 1 ? oid : 0, mpLabel]
  );
  return Number(globalRes.rows?.[0]?.rv ?? 0) || 0;
}

/** Нетто-резерв комплектов из комплектующих под заказ (min floor по составу). */
export async function getReservedKitUnitsFromComponentsForOrder(kitProductId, orderDbId) {
  const kitId = Number(kitProductId);
  const oid = Number(orderDbId);
  if (!Number.isFinite(kitId) || kitId < 1 || !Number.isFinite(oid) || oid < 1) return 0;

  const components = await getKitComponents(kitId);
  if (components.length === 0) return 0;

  const nets = new Map();
  for (const c of components) {
    const pid = Number(c.component_product_id);
    if (!Number.isFinite(pid) || pid < 1 || nets.has(pid)) continue;
    nets.set(pid, await getNetReservedForOrderProduct(oid, pid));
  }
  return minKitUnitsFromComponentReserves(components, (pid) => nets.get(pid) ?? 0);
}

/**
 * Резерв комплекта по всей группе ручного заказа (строка комплекта + отдельные строки комплектующих).
 */
export async function getReservedKitUnitsForManualOrderGroup(
  kitProductId,
  orderGroupId,
  opts = {}
) {
  const kitId = Number(kitProductId);
  const gid = String(orderGroupId || '').trim();
  if (!Number.isFinite(kitId) || kitId < 1 || !gid) return 0;

  const whId = parseStockMovementWarehouseId(opts.warehouseId ?? opts.warehouse_id);
  const profileId = opts.profileId != null ? Number(opts.profileId) : null;

  const params = [gid];
  let profileSql = '';
  if (Number.isFinite(profileId) && profileId > 0) {
    params.push(profileId);
    profileSql = `AND profile_id = $${params.length}`;
  }

  const r = await query(
    `SELECT id, product_id, quantity, order_id
     FROM orders
     WHERE marketplace = 'manual'
       AND order_group_id = $1
       ${profileSql}`,
    params
  );
  const rows = r.rows || [];
  if (!rows.length) return 0;

  const kitRow = rows.find((row) => Number(row.product_id) === kitId);
  const onKit = kitRow
    ? await getNetReservedForOrderProduct(
        Number(kitRow.id),
        kitId,
        kitRow.order_id != null ? String(kitRow.order_id).trim() : null,
        whId
      )
    : 0;

  const components = await getKitComponents(kitId);
  const nets = new Map();
  for (const c of components) {
    const pid = Number(c.component_product_id);
    if (!Number.isFinite(pid) || pid < 1 || nets.has(pid)) continue;
    let sum = 0;
    for (const row of rows) {
      if (Number(row.product_id) !== pid) continue;
      sum += await getNetReservedForOrderProduct(
        Number(row.id),
        pid,
        row.order_id != null ? String(row.order_id).trim() : null,
        whId
      );
    }
    nets.set(pid, sum);
  }
  const fromComp = minKitUnitsFromComponentReserves(components, (pid) => nets.get(pid) ?? 0);
  const orderQty = kitRow ? Math.max(1, parseInt(kitRow.quantity, 10) || 1) : null;
  return resolveComplementaryKitReserveUnits(onKit, fromComp, orderQty);
}

/**
 * Сколько комплектов зарезервировано под заказ (целые на SKU + сборка из комплектующих).
 * При смешанном резерве на оба пути сумма может завышать факт — для проверок см. validation-вариант.
 */
export async function getReservedKitUnitsForOrder(kitProductId, orderDbId) {
  const kitId = Number(kitProductId);
  const oid = Number(orderDbId);
  if (!Number.isFinite(kitId) || kitId < 1 || !Number.isFinite(oid) || oid < 1) return 0;

  const onKit = await getNetReservedForOrderProduct(oid, kitId);
  const fromComp = await getReservedKitUnitsFromComponentsForOrder(kitId, oid);
  return onKit + fromComp;
}

/**
 * Консервативная оценка для валидации сборки: max(целые SKU, из комплектующих),
 * без двойного учёта при ошибочном резерве и на комплект, и на детали.
 */
export async function getReservedKitUnitsForOrderValidation(kitProductId, orderDbId) {
  const kitId = Number(kitProductId);
  const oid = Number(orderDbId);
  if (!Number.isFinite(kitId) || kitId < 1 || !Number.isFinite(oid) || oid < 1) return 0;

  const onKit = await getNetReservedForOrderProduct(oid, kitId);
  const fromComp = await getReservedKitUnitsFromComponentsForOrder(kitId, oid);
  let orderQty = null;
  try {
    const ord = await query(`SELECT quantity FROM orders WHERE id = $1 LIMIT 1`, [oid]);
    if (ord.rows?.[0]) {
      orderQty = Math.max(1, parseInt(ord.rows[0].quantity, 10) || 1);
    }
  } catch {
    /* ignore */
  }
  return resolveComplementaryKitReserveUnits(onKit, fromComp, orderQty);
}

/** Нетто-резерв по строке FBO (движения с meta.fbo_supply_item_id). */
export async function getNetReservedForFboSupplyItem(productId, fboSupplyItemId) {
  const pid = Number(productId);
  const itemId = String(fboSupplyItemId ?? '').trim();
  if (!Number.isFinite(pid) || pid < 1 || !itemId) return 0;
  const r = await query(
    `SELECT GREATEST(0, COALESCE(SUM(
      CASE WHEN type = 'reserve' THEN ABS(quantity_change) WHEN type = 'unreserve' THEN -ABS(quantity_change) ELSE 0 END
    ), 0))::int AS net
     FROM stock_movements
     WHERE product_id = $1
       AND meta->>'fbo_supply_item_id' = $2
       AND type IN ('reserve', 'unreserve')`,
    [pid, itemId]
  );
  return parseInt(r.rows?.[0]?.net ?? 0, 10) || 0;
}

/** Нетто-резерв комплектов из комплектующих под строку FBO. */
export async function getReservedKitUnitsFromComponentsForFboItem(kitProductId, fboSupplyItemId) {
  const kitId = Number(kitProductId);
  const itemId = String(fboSupplyItemId ?? '').trim();
  if (!Number.isFinite(kitId) || kitId < 1 || !itemId) return 0;

  const components = await getKitComponents(kitId);
  if (components.length === 0) return 0;

  const nets = new Map();
  for (const c of components) {
    const pid = Number(c.component_product_id);
    if (!Number.isFinite(pid) || pid < 1 || nets.has(pid)) continue;
    nets.set(pid, await getNetReservedForFboSupplyItem(pid, itemId));
  }
  return minKitUnitsFromComponentReserves(components, (pid) => nets.get(pid) ?? 0);
}

/** Сколько комплектов зарезервировано под строку FBO (целые SKU + из комплектующих). */
export async function getReservedKitUnitsForFboItem(kitProductId, fboSupplyItemId, lineQty = null) {
  const kitId = Number(kitProductId);
  const itemId = String(fboSupplyItemId ?? '').trim();
  if (!Number.isFinite(kitId) || kitId < 1 || !itemId) return 0;

  const onKit = await getNetReservedForFboSupplyItem(kitId, itemId);
  const fromComp = await getReservedKitUnitsFromComponentsForFboItem(kitId, itemId);
  const qty =
    lineQty != null && !Number.isNaN(Number(lineQty))
      ? Math.max(0, Math.floor(Number(lineQty)) || 0)
      : null;
  return resolveComplementaryKitReserveUnits(onKit, fromComp, qty);
}

/** Сколько комплектов можно собрать из пулов комплектующих (симуляция FBO FIFO). */
export function computeAssemblableFromComponentPoolMap(components, componentPools) {
  if (!components?.length) return 0;
  let minKits = Infinity;
  for (const c of components) {
    const pid = Number(c.component_product_id);
    if (!Number.isFinite(pid) || pid < 1) continue;
    const perKit = Math.max(1, parseInt(c.quantity, 10) || 1);
    const avail = Math.max(0, Number(componentPools?.get?.(pid)) || 0);
    minKits = Math.min(minKits, Math.floor(avail / perKit));
  }
  return Number.isFinite(minKits) ? Math.max(0, minKits) : 0;
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
  const snap = await getProductSupplySnapshotWithClient(null, componentProductId, opts);
  return snap.available;
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
  const physicalOnHand = whole.onHand || 0;
  const onSkuReserved = await readKitSkuNetReserved(kitId, opts);
  const wholeReserveAvail = Math.max(0, physicalOnHand - onSkuReserved);
  const wholeAvail = Math.max(0, physicalOnHand + (whole.incoming || 0) - onSkuReserved);
  const allocCap = allocateKitReservePriority(9999, {
    wholeAvail,
    wholeReserveAvail,
    fromComponents,
    physicalOnHand
  });
  return {
    wholeAvail,
    wholeReserveAvail,
    fromComponents,
    total: allocCap.kitsToReserve,
    physicalOnHand
  };
}

export async function computeMaxKitUnitsReservable(kitProductId, opts = {}) {
  const b = await computeKitReservableBreakdown(kitProductId, opts);
  return b.total;
}

/**
 * Сколько комплектов зарезервировать: сначала целые на SKU (если есть), остаток — из комплектующих.
 * @returns {{ kitsToReserve: number, fromWhole: number, fromComponents: number }}
 */
export function allocateKitReservePriority(kitsWanted, breakdown) {
  const wanted = Math.max(0, parseInt(kitsWanted, 10) || 0);
  if (wanted <= 0) return { kitsToReserve: 0, fromWhole: 0, fromComponents: 0 };
  const physicalOnHand = Math.max(0, Number(breakdown?.physicalOnHand) || 0);
  const fromComponentsAvail = Math.max(0, Number(breakdown?.fromComponents) || 0);
  const wholeReserveAvail =
    breakdown?.wholeReserveAvail != null
      ? Math.max(0, Number(breakdown.wholeReserveAvail) || 0)
      : physicalOnHand > 0
        ? physicalOnHand
        : 0;
  const fromWhole = Math.min(wanted, wholeReserveAvail);
  const remainder = Math.max(0, wanted - fromWhole);
  const fromComponents = remainder > 0 ? Math.min(remainder, fromComponentsAvail) : 0;
  return {
    kitsToReserve: fromWhole + fromComponents,
    fromWhole,
    fromComponents
  };
}

/**
 * Резерв по заказу на комплект:
 * - целые комплекты (1 SKU) — резерв на product_id комплекта;
 * - сборка из деталей — резерв на комплектующие по составу.
 */
export async function applyKitOrderReserve(kitProductId, kitsWanted, orderIdLabel, meta, applyReserveFn) {
  const kitId = Number(kitProductId);
  let wanted = Math.max(1, parseInt(kitsWanted, 10) || 1);
  const orderDbId = Number(meta?.order_id ?? meta?.orderId);
  let reservedBeforeKit = null;
  let onKitForAlloc = 0;
  if (Number.isFinite(orderDbId) && orderDbId > 0) {
    reservedBeforeKit = await getReservedKitUnitsForOrderValidation(kitId, orderDbId);
    const already = reservedBeforeKit;
    const orderQtyCap =
      meta?.order_qty != null
        ? Math.max(1, parseInt(meta.order_qty, 10) || 1)
        : null;
    if (orderQtyCap != null && already >= orderQtyCap) return 0;
    if (orderQtyCap != null) {
      wanted = Math.min(wanted, Math.max(0, orderQtyCap - already));
    }
    if (wanted <= 0) return 0;

    const onKit = await getNetReservedForOrderProduct(
      orderDbId,
      kitId,
      meta?.orderId != null ? String(meta.orderId).trim() : null,
      meta?.warehouse_id ?? meta?.warehouseId ?? null
    );
    onKitForAlloc = onKit;
    const fromComp = await getReservedKitUnitsFromComponentsForOrder(kitId, orderDbId);
    if (onKit > 0 && fromComp > 0) {
      if (meta?.reconcile_kit_to_components || meta?.reconcile_force_mixed) {
        return 0;
      }
      const orderQtyCap =
        meta?.order_qty != null
          ? Math.max(1, parseInt(meta.order_qty, 10) || 1)
          : null;
      if (orderQtyCap != null) {
        if (onKit + fromComp >= orderQtyCap) return 0;
        if (onKit + fromComp <= orderQtyCap) {
          wanted = Math.min(wanted, Math.max(0, orderQtyCap - onKit - fromComp));
          if (wanted <= 0) return 0;
        } else {
          const err = new Error(
            'На заказе дублирующий резерв на SKU комплекта и на комплектующие — снимите резерв и повторите'
          );
          err.statusCode = 409;
          throw err;
        }
      }
    }
  }
  const whRaw = meta?.warehouse_id ?? meta?.warehouseId ?? null;
  const strictWarehouse =
    meta?.strict_warehouse === true ||
    meta?.strictWarehouse === true ||
    meta?.fbs_strict_warehouse === true;
  const reserveOpts =
    whRaw != null && String(whRaw).trim() !== '' ? { warehouseId: whRaw } : { warehouseId: null };
  let breakdown = await computeKitReservableBreakdown(kitId, reserveOpts);
  const manualComponentsOnly =
    meta?.manual_reserve === true &&
    (onKitForAlloc > 0 || (breakdown.wholeReserveAvail || 0) <= 0) &&
    meta?.reconcile_kit_to_components !== true &&
    meta?.reconcile_force_mixed !== true;
  if (manualComponentsOnly) {
    breakdown = { ...breakdown, wholeReserveAvail: 0 };
  }
  let alloc = allocateKitReservePriority(wanted, breakdown);
  if (alloc.kitsToReserve <= 0 && reserveOpts.warehouseId != null && !strictWarehouse) {
    breakdown = await computeKitReservableBreakdown(kitId, { warehouseId: null });
    if (manualComponentsOnly) {
      breakdown = { ...breakdown, wholeReserveAvail: 0 };
    }
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
    const assemblable = await computeAssemblableFromComponents(kitId, reserveOpts);
    if (assemblable < alloc.fromComponents) {
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

  if (Number.isFinite(orderDbId) && orderDbId > 0 && reservedBeforeKit != null) {
    const reservedAfter = await getReservedKitUnitsForOrderValidation(kitId, orderDbId);
    return Math.max(0, reservedAfter - reservedBeforeKit);
  }
  return alloc.kitsToReserve;
}

/**
 * Резерв на SKU комплекта без целого комплекта на складе — снять с комплекта и поставить на комплектующие.
 * @returns {Promise<number>} сколько комплектов перенесено
 */
export async function reconcileMisplacedKitWholeReserve(
  kitProductId,
  orderDbId,
  orderIdLabel,
  meta,
  { unreserveProduct, applyKitReserve }
) {
  const kitId = Number(kitProductId);
  const oid = Number(orderDbId);
  if (!Number.isFinite(kitId) || kitId < 1 || !Number.isFinite(oid) || oid < 1) return 0;
  if (typeof unreserveProduct !== 'function' || typeof applyKitReserve !== 'function') return 0;

  const onKit = await getNetReservedForOrderProduct(oid, kitId);
  if (onKit <= 0) return 0;

  const reserveOpts = {
    warehouseId: meta?.warehouse_id ?? meta?.warehouseId ?? null
  };
  const breakdown = await computeKitReservableBreakdown(kitId, reserveOpts);
  if ((breakdown.physicalOnHand || 0) > 0) return 0;

  await unreserveProduct(kitId, onKit, orderIdLabel, {
    ...meta,
    order_id: oid,
    orderId: orderIdLabel,
    kit_reserve_scope: 'whole',
    reconcile_kit_to_components: true
  });

  await applyKitReserve(kitId, onKit, orderIdLabel, {
    ...meta,
    order_id: oid,
    orderId: orderIdLabel,
    reconcile_kit_to_components: true
  });
  return onKit;
}

/**
 * Дублирующий резерв (и на SKU, и на комплектующих сверх кол-ва заказа) — снять с комплектующих.
 * Комплементарный резерв (1 целый + N из деталей) не трогаем.
 */
export async function reconcileMixedKitOrderReservePaths(
  kitProductId,
  orderDbId,
  orderIdLabel,
  meta,
  unreserveProduct
) {
  const kitId = Number(kitProductId);
  const oid = Number(orderDbId);
  if (!Number.isFinite(kitId) || kitId < 1 || !Number.isFinite(oid) || oid < 1) return 0;
  if (typeof unreserveProduct !== 'function') return 0;

  const mpLabel =
    orderIdLabel != null && String(orderIdLabel).trim() !== '' ? String(orderIdLabel).trim() : null;
  const onKit = await getNetReservedForOrderProduct(oid, kitId, mpLabel);
  const fromComp = await getReservedKitUnitsFromComponentsForOrder(kitId, oid);
  if (onKit <= 0 || fromComp <= 0) return 0;

  let orderQty = null;
  try {
    const ord = await query(`SELECT quantity FROM orders WHERE id = $1 LIMIT 1`, [oid]);
    if (ord.rows?.[0]) {
      orderQty = Math.max(1, parseInt(ord.rows[0].quantity, 10) || 1);
    }
  } catch {
    /* ignore */
  }
  if (orderQty != null && onKit + fromComp <= orderQty) return 0;

  let changed = 0;
  const components = await getKitComponents(kitId);
  for (const c of components) {
    const pid = Number(c.component_product_id);
    if (!Number.isFinite(pid) || pid < 1) continue;
    const net = await getNetReservedForOrderProduct(oid, pid, mpLabel);
    if (net <= 0) continue;
    await unreserveProduct(pid, net, orderIdLabel, {
      ...meta,
      order_id: oid,
      orderId: orderIdLabel,
      reconcile_mixed_kit_reserve: true,
      kit_reserve_scope: 'component'
    });
    changed += 1;
  }
  return changed;
}

/**
 * Резерв только на комплектующих при наличии целых комплектов — перенести на SKU комплекта.
 */
export async function reconcileComponentOnlyKitReserveToWhole(
  kitProductId,
  orderDbId,
  orderIdLabel,
  meta,
  { unreserveProduct, reserveWholeKit }
) {
  const kitId = Number(kitProductId);
  const oid = Number(orderDbId);
  if (!Number.isFinite(kitId) || kitId < 1 || !Number.isFinite(oid) || oid < 1) return 0;
  if (typeof unreserveProduct !== 'function' || typeof reserveWholeKit !== 'function') return 0;

  const mpLabel =
    orderIdLabel != null && String(orderIdLabel).trim() !== '' ? String(orderIdLabel).trim() : null;
  const onKit = await getNetReservedForOrderProduct(oid, kitId, mpLabel);
  const fromComp = await getReservedKitUnitsFromComponentsForOrder(kitId, oid);
  if (onKit > 0 || fromComp <= 0) return 0;

  const physical = await readKitPhysicalOnHandFromDb(kitId, null, {
    warehouseId: meta?.warehouse_id ?? meta?.warehouseId ?? null
  });
  if (physical <= 0) return 0;

  const components = await getKitComponents(kitId);
  for (const c of components) {
    const pid = Number(c.component_product_id);
    if (!Number.isFinite(pid) || pid < 1) continue;
    const net = await getNetReservedForOrderProduct(oid, pid, mpLabel);
    if (net <= 0) continue;
    await unreserveProduct(pid, net, orderIdLabel, {
      ...meta,
      order_id: oid,
      orderId: orderIdLabel,
      reconcile_to_whole: true,
      kit_reserve_scope: 'component'
    });
  }
  await reserveWholeKit(kitId, fromComp, orderIdLabel, {
    ...meta,
    order_id: oid,
    orderId: orderIdLabel,
    reconcile_to_whole: true,
    kit_reserve_scope: 'whole'
  });
  return fromComp;
}

/**
 * Согласовать резерв комплектов по всем заказам товара (модалка остатков, ручное снятие).
 * @param {number} productId
 * @param {Function|{ unreserveProduct: Function, reserveWholeKit?: Function }} hooks
 */
export async function reconcileAllMixedKitReservesForProduct(productId, hooks) {
  const pid = Number(productId);
  const unreserveProduct = typeof hooks === 'function' ? hooks : hooks?.unreserveProduct;
  const reserveWholeKit = typeof hooks === 'object' ? hooks?.reserveWholeKit : null;
  if (!Number.isFinite(pid) || pid < 1 || typeof unreserveProduct !== 'function') return 0;

  const kitIds = new Set();
  if (await isKitProductId(pid)) kitIds.add(pid);
  const parents = await query(
    `SELECT DISTINCT kit_product_id FROM kit_components WHERE component_product_id = $1`,
    [pid]
  );
  for (const row of parents.rows || []) {
    const kid = Number(row.kit_product_id);
    if (Number.isFinite(kid) && kid > 0) kitIds.add(kid);
  }
  if (kitIds.size === 0) return 0;

  let changed = 0;
  for (const kitId of kitIds) {
    const compIds = (await getKitComponents(kitId)).map((c) => Number(c.component_product_id));
    const scopeIds = [kitId, ...compIds.filter((id) => Number.isFinite(id) && id > 0)];
    const ordersRes = await query(
      `SELECT DISTINCT (COALESCE(NULLIF(TRIM(meta->>'order_id'), ''), NULLIF(TRIM(meta->>'orderId'), '')))::bigint AS oid
       FROM stock_movements
       WHERE product_id = ANY($1::bigint[])
         AND type IN ('reserve', 'unreserve')
         AND (COALESCE(NULLIF(TRIM(meta->>'order_id'), ''), NULLIF(TRIM(meta->>'orderId'), ''))) ~ '^[0-9]+$'
         AND (COALESCE(NULLIF(TRIM(meta->>'order_id'), ''), NULLIF(TRIM(meta->>'orderId'), '')))::bigint > 0`,
      [scopeIds]
    );
    for (const row of ordersRes.rows || []) {
      const oid = Number(row.oid);
      if (!Number.isFinite(oid) || oid < 1) continue;
      const onKit = await getNetReservedForOrderProduct(oid, kitId);
      const fromComp = await getReservedKitUnitsFromComponentsForOrder(kitId, oid);
      const ord = await query(`SELECT order_id FROM orders WHERE id = $1 LIMIT 1`, [oid]);
      const label = ord.rows[0]?.order_id != null ? String(ord.rows[0].order_id) : String(oid);
      const meta = { source: 'reserve_modal_reconcile' };

      if (onKit > 0 && fromComp > 0) {
        changed += await reconcileMixedKitOrderReservePaths(
          kitId,
          oid,
          label,
          meta,
          unreserveProduct
        );
      } else if (onKit <= 0 && fromComp > 0 && typeof reserveWholeKit === 'function') {
        try {
          changed += await reconcileComponentOnlyKitReserveToWhole(
            kitId,
            oid,
            label,
            meta,
            { unreserveProduct, reserveWholeKit }
          );
        } catch {
          /* не блокируем список */
        }
      }
    }
  }
  return changed;
}

/**
 * Снять резерв по заказу с учётом склада каждой записи в журнале (не склад по умолчанию).
 */
export async function releaseOrderReservesGroupedByWarehouse(
  orderDbId,
  orderIdLabel,
  unreserveFn,
  { productId = null } = {}
) {
  const oid = Number(orderDbId);
  if (!Number.isFinite(oid) || oid < 1) return [];

  const mpLabel =
    orderIdLabel != null && String(orderIdLabel).trim() !== '' ? String(orderIdLabel).trim() : null;

  const params = [oid, mpLabel];
  let productFilterSql = '';
  const pidFilter = productId != null ? Number(productId) : NaN;
  if (Number.isFinite(pidFilter) && pidFilter > 0) {
    productFilterSql = ` AND product_id = $3`;
    params.push(pidFilter);
  }

  const r = await query(
    `SELECT product_id,
            warehouse_id,
            ${NET_RESERVED_SUM_EXPR_SQL}::int AS net_reserved
     FROM stock_movements
     WHERE type IN ('reserve', 'unreserve')
       AND ${orderReserveMovementMatchSql('', 1, 2)}${productFilterSql}
     GROUP BY product_id, warehouse_id
     HAVING ${NET_RESERVED_SUM_EXPR_SQL} > 0`,
    params
  );

  const affected = [];
  for (const row of r.rows || []) {
    const pid = Number(row.product_id);
    const net = Number(row.net_reserved) || 0;
    if (!Number.isFinite(pid) || pid < 1 || net <= 0) continue;
    const meta = { order_id: oid, orderId: orderIdLabel };
    if (row.warehouse_id != null && String(row.warehouse_id).trim() !== '') {
      const wh = Number(row.warehouse_id);
      if (Number.isFinite(wh) && wh > 0) meta.warehouse_id = wh;
    }
    await unreserveFn(pid, net, orderIdLabel, meta);
    scheduleMarketplaceSyncForParentKits(pid, { source: 'order_unreserve' });
    affected.push(pid);
  }
  return [...new Set(affected)];
}

export async function releaseAllReservesForOrder(orderDbId, orderIdLabel, unreserveFn) {
  return releaseOrderReservesGroupedByWarehouse(orderDbId, orderIdLabel, unreserveFn);
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
  let journalMap;
  if (warehouseScoped) {
    journalMap = await warehouseScopedNetReservedMap(ids, whId);
  } else {
    const r = await query(
      `SELECT product_id,
     ${NET_RESERVED_SUM_EXPR_SQL}::int AS rv
   FROM stock_movements
   WHERE product_id = ANY($1::bigint[])
     AND type IN ('reserve', 'unreserve')
   GROUP BY product_id`,
      [ids]
    );
    journalMap = new Map((r.rows || []).map((row) => [Number(row.product_id), Number(row.rv) || 0]));
  }
  const { batchOrderAttributedReservedMap, mergeJournalAndOrderAttributedReserved } =
    await import('./orderAttributedReserve.service.js');
  const orderMap = await batchOrderAttributedReservedMap(ids, opts);
  const out = new Map();
  for (const id of ids) {
    out.set(
      id,
      mergeJournalAndOrderAttributedReserved(journalMap.get(id) ?? 0, orderMap.get(id) ?? 0)
    );
  }
  return out;
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

async function batchIncomingMap(productIds, opts = {}) {
  const ids = [...new Set(productIds.filter((n) => Number.isFinite(n) && n > 0))];
  if (!ids.length) return new Map();

  const wid = parseWarehouseIdFromOpts(opts);
  if (wid == null) {
    const [productsR, incomingSumR, incomingExistsR, stockExistsR] = await Promise.all([
      query(
        `SELECT id, COALESCE(incoming_quantity, 0)::int AS incoming_quantity
         FROM products WHERE id = ANY($1::bigint[])`,
        [ids]
      ),
      query(
        `SELECT product_id, GREATEST(0, COALESCE(SUM(quantity_change), 0))::int AS inc
         FROM stock_movements
         WHERE product_id = ANY($1::bigint[])
           AND LOWER(TRIM(type::text)) = 'incoming'
         GROUP BY product_id`,
        [ids]
      ),
      query(
        `SELECT DISTINCT product_id
         FROM stock_movements
         WHERE product_id = ANY($1::bigint[])
           AND LOWER(TRIM(type::text)) = 'incoming'`,
        [ids]
      ),
      query(
        `SELECT DISTINCT product_id
         FROM stock_movements
         WHERE product_id = ANY($1::bigint[])`,
        [ids]
      )
    ]);
    const incomingSumMap = new Map(
      (incomingSumR.rows || []).map((row) => [Number(row.product_id), Number(row.inc) || 0])
    );
    const incomingExistsSet = new Set(
      (incomingExistsR.rows || []).map((row) => Number(row.product_id)).filter((n) => Number.isFinite(n))
    );
    const stockExistsSet = new Set(
      (stockExistsR.rows || []).map((row) => Number(row.product_id)).filter((n) => Number.isFinite(n))
    );
    return new Map(
      (productsR.rows || []).map((row) => {
        const pid = Number(row.id);
        let inc = Number(row.incoming_quantity) || 0;
        if (incomingExistsSet.has(pid)) {
          inc = incomingSumMap.get(pid) ?? 0;
        } else if (stockExistsSet.has(pid)) {
          inc = 0;
        }
        return [pid, Math.max(0, inc)];
      })
    );
  }

  const [strictR, nullR, whOnHandR, totalOnHandR, globalR, journalR, stockJournalR, whJournalR, globalNetR, snapshotR] =
    await Promise.all([
    query(
      `SELECT product_id,
              COALESCE(SUM(quantity_change), 0)::int AS inc
       FROM stock_movements
       WHERE product_id = ANY($1::bigint[])
         AND LOWER(TRIM(type::text)) = 'incoming'
         AND warehouse_id = $2
       GROUP BY product_id`,
      [ids, wid]
    ),
    query(
      `SELECT product_id,
              COALESCE(SUM(quantity_change), 0)::int AS inc
       FROM stock_movements
       WHERE product_id = ANY($1::bigint[])
         AND LOWER(TRIM(type::text)) = 'incoming'
         AND warehouse_id IS NULL
       GROUP BY product_id`,
      [ids]
    ),
    query(
      `SELECT product_id, COALESCE(quantity, 0)::int AS qty
       FROM product_warehouse_stock
       WHERE product_id = ANY($1::bigint[]) AND warehouse_id = $2`,
      [ids, wid]
    ),
    query(
      `SELECT product_id, COALESCE(SUM(quantity), 0)::int AS qty
       FROM product_warehouse_stock
       WHERE product_id = ANY($1::bigint[])
       GROUP BY product_id`,
      [ids]
    ),
    query(
      `SELECT id, COALESCE(incoming_quantity, 0)::int AS inc, COALESCE(quantity, 0)::int AS legacy_qty
       FROM products WHERE id = ANY($1::bigint[])`,
      [ids]
    ),
    query(
      `SELECT DISTINCT product_id
       FROM stock_movements
       WHERE product_id = ANY($1::bigint[])
         AND LOWER(TRIM(type::text)) = 'incoming'`,
      [ids]
    ),
    query(
      `SELECT DISTINCT product_id
       FROM stock_movements
       WHERE product_id = ANY($1::bigint[])`,
      [ids]
    ),
    query(
      `SELECT DISTINCT product_id
       FROM stock_movements
       WHERE product_id = ANY($1::bigint[])
         AND LOWER(TRIM(type::text)) = 'incoming'
         AND warehouse_id = $2`,
      [ids, wid]
    ),
    query(
      `SELECT product_id, COALESCE(SUM(quantity_change), 0)::int AS inc
       FROM stock_movements
       WHERE product_id = ANY($1::bigint[])
         AND LOWER(TRIM(type::text)) = 'incoming'
       GROUP BY product_id`,
      [ids]
    ),
    query(
      `SELECT DISTINCT ON (product_id) product_id, incoming_after::int AS inc
       FROM stock_movements
       WHERE product_id = ANY($1::bigint[])
         AND warehouse_id = $2
         AND incoming_after IS NOT NULL
       ORDER BY product_id, created_at DESC, id DESC`,
      [ids, wid]
    )
  ]);

  const strictMap = new Map(
    (strictR.rows || []).map((row) => [Number(row.product_id), Number(row.inc) || 0])
  );
  const nullMap = new Map(
    (nullR.rows || []).map((row) => [Number(row.product_id), Number(row.inc) || 0])
  );
  const whOnHandMap = new Map(
    (whOnHandR.rows || []).map((row) => [Number(row.product_id), Number(row.qty) || 0])
  );
  const totalOnHandMap = new Map(
    (totalOnHandR.rows || []).map((row) => [Number(row.product_id), Number(row.qty) || 0])
  );
  const journalIncomingSet = new Set(
    (journalR.rows || []).map((row) => Number(row.product_id)).filter((n) => Number.isFinite(n))
  );
  const stockJournalSet = new Set(
    (stockJournalR.rows || []).map((row) => Number(row.product_id)).filter((n) => Number.isFinite(n))
  );
  const whIncomingJournalSet = new Set(
    (whJournalR.rows || []).map((row) => Number(row.product_id)).filter((n) => Number.isFinite(n))
  );
  const globalJournalNetMap = new Map(
    (globalNetR.rows || []).map((row) => [Number(row.product_id), Number(row.inc) || 0])
  );
  const incomingSnapshotMap = new Map(
    (snapshotR.rows || []).map((row) => [Number(row.product_id), Number(row.inc) || 0])
  );
  const globalIncMap = new Map();
  const legacyMap = new Map();
  for (const row of globalR.rows || []) {
    const pid = Number(row.id);
    globalIncMap.set(pid, Number(row.inc) || 0);
    legacyMap.set(pid, Number(row.legacy_qty) || 0);
  }

  const map = new Map();
  for (const pid of ids) {
    const totalOnHand = totalOnHandMap.get(pid) ?? 0;
    const legacyProductQty = legacyMap.get(pid) ?? 0;
    const whOnHand = warehouseScopedOnHandForAllocation({
      whOnHand: whOnHandMap.get(pid) ?? 0,
      totalOnHand,
      legacyProductQty
    });
    map.set(
      pid,
      allocateWarehouseScopedIncoming({
        strictRaw: strictMap.get(pid) ?? 0,
        nullRaw: nullMap.get(pid) ?? 0,
        whOnHand,
        totalOnHand: totalOnHand > 0 ? totalOnHand : legacyProductQty,
        legacyProductQty,
        globalIncoming: globalIncMap.get(pid) ?? 0,
        globalJournalNet: globalJournalNetMap.get(pid) ?? 0,
        hasIncomingJournal: journalIncomingSet.has(pid),
        hasStockJournal: stockJournalSet.has(pid),
        hasWarehouseIncomingJournal: whIncomingJournalSet.has(pid),
        warehouseIncomingSnapshot: incomingSnapshotMap.has(pid)
          ? incomingSnapshotMap.get(pid)
          : null
      })
    );
  }
  return map;
}

/** Пакетно: «в пути» по складу для списка товаров (как batchIncomingMap). */
export async function batchWarehouseScopedIncomingMap(productIds, opts = {}) {
  return batchIncomingMap(productIds, opts);
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
  if (ctx.warehouseScoped) {
    return onHand;
  }
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

/** Сколько комплектов можно собрать только из «в пути» комплектующих на выбранном складе. */
function kitIncomingFromComponentsFromContext(kitId, ctx) {
  const comps = ctx.componentsByKit.get(kitId) || [];
  if (comps.length === 0) return 0;
  let minKits = Infinity;
  for (const c of comps) {
    const pid = Number(c.component_product_id ?? c.productId);
    const perKit = Math.max(1, parseInt(c.quantity, 10) || 1);
    const onHand = Math.max(0, ctx.compOnHand.get(pid) || 0);
    const incoming = Math.max(0, ctx.compIncoming.get(pid) || 0);
    const reserved = Math.max(0, ctx.reservedMap.get(pid) || 0);
    const incomingOnly = Math.max(0, incoming - Math.max(0, reserved - onHand));
    minKits = Math.min(minKits, Math.floor(incomingOnly / perKit));
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
      batchIncomingMap(compIds, options),
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
    supplierMap,
    warehouseScoped: parseWarehouseIdFromOpts(options) != null,
  };
}

/**
 * Метрики отображения для комплектов в списке остатков.
 * kit_display: whole_on_hand, whole_available, assemblable_from_components, marketplace_available, available_total.
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
    const incomingFromComponents = kitIncomingFromComponentsFromContext(kitId, ctx);
    const supplierSyncOn = options.supplierSyncEnabled !== false;
    const supplierKitUnits = supplierSyncOn ? supplierKitUnitsFromContext(kitId, ctx) : 0;
    const incoming = Math.max(0, Number(p.incoming_quantity ?? p.incomingQuantity ?? 0) || 0);
    const onSkuReserved = await readKitSkuNetReserved(kitId, options);
    const comps = ctx.componentsByKit?.get(kitId) || [];
    const reservedFromComponents = comps.length
      ? minKitUnitsFromComponentReserves(comps, (pid) => ctx.reservedMap.get(pid) ?? 0)
      : 0;
    const wholeAvail = Math.max(0, wholeOnHand + incoming - onSkuReserved);
    // assemblable уже учитывает резерв комплектующих; вычитать displayReserved повторно нельзя.
    const marketplaceAvailable = Math.max(0, wholeAvail + assemblable);
    const availableTotal = marketplaceAvailable + supplierKitUnits;

    p.supplierStockTotal = supplierKitUnits;
    p.quantity = wholeOnHand;
    p.reserved_quantity = onSkuReserved;
    p.net_reserved_quantity = onSkuReserved;
    p.reservedQuantity = onSkuReserved;
    p.netReservedQuantity = onSkuReserved;
    p.kit_display = {
      whole_on_hand: wholeOnHand,
      whole_available: wholeAvail,
      reserved_on_sku: onSkuReserved,
      reserved_from_components: reservedFromComponents,
      assemblable_from_components: assemblable,
      incoming_from_components: incomingFromComponents,
      supplier_kit_units: supplierKitUnits,
      marketplace_available: marketplaceAvailable,
      available_total: availableTotal
    };
    p.incoming_from_components = incomingFromComponents;
  }
}

/** @deprecated Используйте attachKitDisplayMetrics */
export const attachKitWarehouseSplitMetrics = attachKitDisplayMetrics;

export default {
  isKitProductType,
  isKitCatalogProduct,
  isKitProductId,
  isKitComponentProductId,
  findKitProductIdForOrderComponentReserve,
  releaseKitOrderReserveUnits,
  collectOrderSkuCandidates,
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
  resolveComplementaryKitReserveUnits,
  reconcileMisplacedKitWholeReserve,
  reconcileMixedKitOrderReservePaths,
  reconcileComponentOnlyKitReserveToWhole,
  reconcileAllMixedKitReservesForProduct,
  getReservedKitUnitsForOrder,
  getReservedKitUnitsFromComponentsForOrder,
  getReservedKitUnitsForManualOrderGroup,
  getReservedKitUnitsForOrderValidation,
  getNetReservedForFboSupplyItem,
  getReservedKitUnitsFromComponentsForFboItem,
  getReservedKitUnitsForFboItem,
  computeAssemblableFromComponentPoolMap,
  computeKitMarketplaceStock,
  readKitStockFromDb,
  readKitMarketplaceStockFromDb,
  computeKitDisplayMetricsFromDb,
  computeKitMarketplaceAvailableFromMetrics,
  computeKitStockTableAvailableFromMetrics,
  persistKitStock,
  recalculateKitsForComponent,
  recalculateAllKitStocks,
  zeroPhantomKitWarehouseStock,
  enrichKitProductStock,
  scheduleMarketplaceSyncForParentKits,
  applyKitOrderReserve,
  releaseAllReservesForOrder,
  releaseOrderReservesGroupedByWarehouse,
  buildKitListStockContext,
  batchWarehouseScopedIncomingMap,
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
  readKitStockTableReservedQuantity,
  readKitDisplayReservedQuantityForStockSummary,
  manualLooseComponentReservesByProduct,
  readKitComponentsNetReservedMap,
  resolveKitOrderShipmentPlan,
  kitOrderReserveExceedsOnHand,
  sumKitComponentsNetReserved,
  kitHasPhysicalBalanceMovements,
  kitHasWholeKitInboundMovements,
  KIT_WHOLE_STOCK_INBOUND_TYPES,
  isKitPhysicalBalanceMovementType,
  isKitStockHistoryMovementType,
  KIT_PHYSICAL_BALANCE_MOVEMENT_TYPES,
  KIT_STOCK_HISTORY_MOVEMENT_TYPES
};
