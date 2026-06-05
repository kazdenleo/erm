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
 * SQL-фрагмент: движения резерва по заказу (orders.id и/или номер на МП в meta).
 * @param {string} [alias=''] — префикс таблицы, например `sm.`
 * @param {number} orderDbIdParam — индекс $N для orders.id
 * @param {number} mpOrderIdParam — индекс $N для marketplace order_id (nullable)
 */
export function orderReserveMovementMatchSql(alias = '', orderDbIdParam, mpOrderIdParam) {
  const a = alias ? `${alias}` : '';
  const metaOrderExpr = `COALESCE(NULLIF(TRIM(${a}meta->>'order_id'), ''), NULLIF(TRIM(${a}meta->>'orderId'), ''))`;
  const numericMatch = `(${metaOrderExpr} ~ '^[0-9]+$' AND (${metaOrderExpr})::bigint = $${orderDbIdParam}::bigint)`;
  const mpMatch = `($${mpOrderIdParam}::text IS NOT NULL AND TRIM($${mpOrderIdParam}::text) <> '' AND TRIM(${metaOrderExpr}) = TRIM($${mpOrderIdParam}::text))`;
  return `(${numericMatch} OR ${mpMatch})`;
}
