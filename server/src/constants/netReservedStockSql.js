/**
 * SQL-фрагменты нетто-резерва из stock_movements.
 * Отдельный модуль без импортов — чтобы репозитории не тянули services (цикл с repository-factory).
 */

export const NET_RESERVED_MOVEMENT_ROW_CASE_SQL = `
          CASE
            WHEN type = 'reserve' THEN
              CASE
                WHEN quantity_change < 0 THEN -(quantity_change::numeric)
                ELSE (quantity_change::numeric)
              END
            WHEN type = 'unreserve' THEN
              CASE
                WHEN quantity_change > 0 THEN -(quantity_change::numeric)
                ELSE (quantity_change::numeric)
              END
            ELSE 0
          END`;

/** GREATEST(0, SUM(...)) для агрегата по product_id. */
export const NET_RESERVED_SUM_EXPR_SQL = `GREATEST(0, COALESCE(SUM(${NET_RESERVED_MOVEMENT_ROW_CASE_SQL}), 0))`;

/** Сырой нетто-резерв без GREATEST(0, …) — для жёсткой проверки лимита резерва. */
export const RAW_RESERVED_SUM_EXPR_SQL = `COALESCE(SUM(${NET_RESERVED_MOVEMENT_ROW_CASE_SQL}), 0)`;

/** Нормализованный id склада для фильтра резерва в журнале (как в истории остатков). */
export function parseStockMovementWarehouseId(raw) {
  if (raw == null || String(raw).trim() === '') return null;
  const n = typeof raw === 'string' ? parseInt(raw, 10) : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * SQL-фрагмент: движения резерва по выбранному складу + legacy без warehouse_id.
 * @param {string} [alias=''] — префикс таблицы, например `sm.`
 * @param {number} whId
 * @param {number} paramIndex — номер плейсхолдера $N для whId
 */
export function stockMovementWarehouseReserveSql(alias = '', whId, paramIndex) {
  if (!Number.isFinite(whId) || whId < 1) return '';
  const a = alias ? `${alias}` : '';
  return ` AND (${a}warehouse_id = $${paramIndex} OR ${a}warehouse_id IS NULL)`;
}

/**
 * Резерв по складу: строго по warehouse_id + доля legacy (warehouse_id IS NULL) по наличию на складе.
 */
export function allocateWarehouseScopedReserved({
  strict = 0,
  nullReserve = 0,
  whOnHand = 0,
  totalOnHand = 0,
  legacyProductQty = 0
} = {}) {
  const s = Math.max(0, Math.floor(Number(strict) || 0));
  const nr = Math.max(0, Math.floor(Number(nullReserve) || 0));
  const wh = Math.max(0, Math.floor(Number(whOnHand) || 0));
  const total = Math.max(0, Math.floor(Number(totalOnHand) || 0));
  const legacy = Math.max(0, Math.floor(Number(legacyProductQty) || 0));

  if (total > 0) {
    return s + Math.floor(nr * (wh / total));
  }
  if (legacy > 0 && wh > 0) {
    return s + nr;
  }
  return s;
}

/**
 * «В пути» по складу: строго по warehouse_id + доля legacy (warehouse_id IS NULL) по наличию;
 * если в журнале нет incoming — доля products.incoming_quantity по наличию на складе.
 * Если в журнале уже есть движения incoming, а на этом складе нетто 0 — не подставляем globalIncoming.
 */
export function allocateWarehouseScopedIncoming({
  strict = 0,
  nullIncoming = 0,
  whOnHand = 0,
  totalOnHand = 0,
  legacyProductQty = 0,
  globalIncoming = 0,
  hasIncomingJournal = false
} = {}) {
  const s = Math.max(0, Math.floor(Number(strict) || 0));
  const ni = Math.max(0, Math.floor(Number(nullIncoming) || 0));
  const wh = Math.max(0, Math.floor(Number(whOnHand) || 0));
  const total = Math.max(0, Math.floor(Number(totalOnHand) || 0));
  const legacy = Math.max(0, Math.floor(Number(legacyProductQty) || 0));
  const globalInc = Math.max(0, Math.floor(Number(globalIncoming) || 0));

  if (s > 0 || ni > 0) {
    if (total > 0) {
      return s + Math.floor(ni * (wh / total));
    }
    if (legacy > 0 && wh > 0) {
      return s + ni;
    }
    if (ni > 0) {
      return s + ni;
    }
    return s;
  }

  if (hasIncomingJournal) {
    return 0;
  }

  if (globalInc <= 0) return 0;
  if (total > 0) {
    return Math.floor(globalInc * (wh / total));
  }
  if (legacy > 0 && wh > 0) {
    return globalInc;
  }
  return globalInc;
}

/** Наличие на выбранном складе для доли legacy; не подставляем products.quantity, если остаток на других складах. */
export function warehouseScopedOnHandForAllocation({
  whOnHand = 0,
  totalOnHand = 0,
  legacyProductQty = 0
} = {}) {
  const wh = Math.max(0, Math.floor(Number(whOnHand) || 0));
  const total = Math.max(0, Math.floor(Number(totalOnHand) || 0));
  const legacy = Math.max(0, Math.floor(Number(legacyProductQty) || 0));
  if (wh > 0) return wh;
  if (total > 0) return 0;
  if (legacy > 0) return legacy;
  return 0;
}

/**
 * SQL-фрагмент: движения резерва по заказу (orders.id и/или номер на МП в meta).
 * @param {string} [alias=''] — префикс таблицы, например `sm.`
 * @param {number} orderDbIdParam — индекс $N для orders.id
 * @param {number} mpOrderIdParam — индекс $N для marketplace order_id (nullable)
 */
export function orderReserveMovementMatchSql(alias = '', orderDbIdParam, mpOrderIdParam) {
  const a = alias ? `${alias}` : '';
  const metaOrderExpr = stockMovementMetaOrderKeySql(a);
  const numericMatch = `(${metaOrderExpr} ~ '^[0-9]+$' AND (${metaOrderExpr})::bigint = $${orderDbIdParam}::bigint)`;
  const mpMatch = `($${mpOrderIdParam}::text IS NOT NULL AND TRIM($${mpOrderIdParam}::text) <> '' AND TRIM(${metaOrderExpr}) = TRIM($${mpOrderIdParam}::text))`;
  return `(${numericMatch} OR ${mpMatch})`;
}

/** Ключ заказа в meta движения (orders.id или номер на МП). */
export function stockMovementMetaOrderKeySql(alias = '') {
  const a = alias ? `${alias}` : '';
  return `COALESCE(NULLIF(TRIM(${a}meta->>'order_id'), ''), NULLIF(TRIM(${a}meta->>'orderId'), ''))`;
}

/**
 * Сопоставление движения резерва со строкой orders (коррелированный подзапрос).
 * @param {string} [smAlias='sm.'] — префикс stock_movements
 * @param {string} [oAlias='o.'] — префикс orders
 */
export function orderReserveMovementMatchOrderRowSql(smAlias = 'sm.', oAlias = 'o.') {
  const sm = smAlias.endsWith('.') ? smAlias : `${smAlias}.`;
  const o = oAlias.endsWith('.') ? oAlias : `${oAlias}.`;
  const metaOrderExpr = stockMovementMetaOrderKeySql(sm);
  const numericMatch = `(${metaOrderExpr} ~ '^[0-9]+$' AND (${metaOrderExpr})::bigint = ${o}id::bigint)`;
  const mpMatch = `(${o}order_id IS NOT NULL AND TRIM(${o}order_id) <> '' AND TRIM(${metaOrderExpr}) = TRIM(${o}order_id))`;
  return `(${numericMatch} OR ${mpMatch})`;
}

/** Нетто-резерв по заказу (коррелированный подзапрос для списка заказов). */
export function orderReservedQtyCorrelatedSubquerySql(smAlias = 'sm', oAlias = 'o') {
  const sm = smAlias.endsWith('.') ? smAlias : `${smAlias}.`;
  const match = orderReserveMovementMatchOrderRowSql(sm, oAlias.endsWith('.') ? oAlias : `${oAlias}.`);
  return `COALESCE((
    SELECT ${NET_RESERVED_SUM_EXPR_SQL}::int
    FROM stock_movements ${smAlias.replace(/\.$/, '')}
    WHERE ${sm}type IN ('reserve', 'unreserve')
      AND (${sm}meta ? 'order_id' OR ${sm}meta ? 'orderId')
      AND ${match}
  ), 0)`;
}
