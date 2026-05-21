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
