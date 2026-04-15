/**
 * Stock Problems Service
 * Список заказов, чей резерв не покрывается текущей доступностью (actual + incoming).
 *
 * Важно: reserved_quantity в products — агрегат, но чтобы получить "какие именно заказы",
 * мы используем журнал резервирования stock_movements(type='reserve') и распределяем покрытие FIFO.
 */

import { query } from '../config/database.js';
import repositoryFactory from '../config/repository-factory.js';

const ACTIVE_ORDER_STATUSES = new Set([
  'new',
  'in_procurement',
  'in_assembly',
  'assembled',
]);

export async function getProblemOrders({ limit = 200, profileId = null } = {}) {
  const lim = Math.min(Math.max(1, parseInt(limit, 10) || 200), 500);
  const profileParam =
    profileId != null && profileId !== ''
      ? typeof profileId === 'string'
        ? parseInt(profileId, 10)
        : Number(profileId)
      : null;
  const useProfile = Number.isFinite(profileParam) && profileParam > 0;

  // FIFO-распределение покрытия по резервам:
  // 1) берём все reserve движения, привязанные к orders.id через meta.order_id
  // 2) считаем supply = products.quantity + products.incoming_quantity
  // 3) по каждому резерву считаем "непокрытую часть" через оконные суммы
  // 4) отдельно считаем покрытие за счёт actual и incoming (чтобы отличать «в наличии» vs «в пути»)
  //
  // reserveQty = abs(quantity_change) (в нашей логике reserve делает quantity_change отрицательным)
  const sql = `
    WITH reserve_lines AS (
      SELECT
        sm.id AS movement_id,
        sm.created_at,
        sm.product_id,
        ABS(sm.quantity_change)::int AS reserve_qty,
        NULLIF(sm.meta->>'order_id', '')::bigint AS order_row_id
      FROM stock_movements sm
      WHERE sm.type = 'reserve'
        AND sm.quantity_change < 0
        AND sm.meta ? 'order_id'
    ),
    reserve_with_orders AS (
      SELECT
        rl.*,
        o.id AS order_db_id,
        o.marketplace,
        o.order_id,
        o.order_group_id,
        o.status AS order_status,
        o.quantity AS order_quantity,
        o.product_id AS order_product_id,
        o.product_name,
        o.created_at AS order_created_at
      FROM reserve_lines rl
      JOIN orders o ON o.id = rl.order_row_id
      WHERE ($2::bigint IS NULL OR o.profile_id = $2::bigint)
    ),
    active_reserves AS (
      SELECT *
      FROM reserve_with_orders
      WHERE order_status = ANY($1::text[])
    ),
    supply AS (
      SELECT
        p.id AS product_id,
        COALESCE(p.quantity, 0)::int AS actual,
        COALESCE(p.incoming_quantity, 0)::int AS incoming,
        (COALESCE(p.quantity, 0) + COALESCE(p.incoming_quantity, 0))::int AS supply_qty
      FROM products p
    ),
    fifo_calc AS (
      SELECT
        ar.*,
        s.actual,
        s.incoming,
        s.supply_qty,
        COALESCE(
          SUM(ar.reserve_qty) OVER (
            PARTITION BY ar.product_id
            ORDER BY ar.created_at ASC, ar.movement_id ASC
            ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
          ),
          0
        )::int AS cum_reserved_before
      FROM active_reserves ar
      JOIN supply s ON s.product_id = ar.product_id
    ),
    uncovered AS (
      SELECT
        *,
        GREATEST(0, (cum_reserved_before + reserve_qty) - supply_qty)::int AS cum_uncovered_after,
        GREATEST(0, cum_reserved_before - supply_qty)::int AS cum_uncovered_before,
        -- покрытие только за счёт actual (то, что реально на складе)
        GREATEST(
          0,
          LEAST(reserve_qty, actual - cum_reserved_before)
        )::int AS covered_by_actual_qty,
        -- покрытие за счёт incoming (то, что «в пути», когда actual уже исчерпан)
        GREATEST(
          0,
          LEAST(reserve_qty, supply_qty - cum_reserved_before)
          - GREATEST(0, LEAST(reserve_qty, actual - cum_reserved_before))
        )::int AS covered_by_incoming_qty
      FROM fifo_calc
    ),
    per_line AS (
      SELECT
        order_db_id,
        marketplace,
        order_id,
        order_group_id,
        order_status,
        product_id,
        reserve_qty,
        (cum_uncovered_after - cum_uncovered_before)::int AS uncovered_qty,
        covered_by_actual_qty,
        covered_by_incoming_qty,
        created_at
      FROM uncovered
    )
    SELECT
      pl.order_db_id AS id,
      pl.marketplace,
      pl.order_id,
      pl.order_group_id,
      pl.order_status AS status,
      SUM(pl.uncovered_qty)::int AS uncovered_quantity,
      SUM(pl.covered_by_actual_qty)::int AS covered_by_actual_quantity,
      SUM(pl.covered_by_incoming_qty)::int AS covered_by_incoming_quantity,
      JSON_AGG(
        JSON_BUILD_OBJECT(
          'productId', pl.product_id,
          'uncovered', pl.uncovered_qty,
          'reserved', pl.reserve_qty,
          'coveredByActual', pl.covered_by_actual_qty,
          'coveredByIncoming', pl.covered_by_incoming_qty,
          'reservedAt', pl.created_at
        )
        ORDER BY pl.created_at ASC
      ) AS lines
    FROM per_line pl
    GROUP BY pl.order_db_id, pl.marketplace, pl.order_id, pl.order_group_id, pl.order_status
    HAVING SUM(pl.uncovered_qty)::int > 0
    ORDER BY uncovered_quantity DESC, pl.order_db_id DESC
    LIMIT $3
  `;

  const statuses = Array.from(ACTIVE_ORDER_STATUSES.values());
  const r = await query(sql, [statuses, useProfile ? profileParam : null, lim]);
  return r.rows || [];
}

/**
 * Пересчитать проблемы и выставить флаг в orders.stock_problem.
 * Важно: orders у нас глобальные (без profile_id), поэтому флаг ставится глобально для системы.
 */
export async function refreshProblemOrdersFlags() {
  const ordersRepo = repositoryFactory.getOrdersRepository();
  const list = await getProblemOrders({ limit: 500 });
  const problemIds = list.map((x) => x.id).filter((n) => Number.isFinite(Number(n)));
  const detailsByOrderId = {};
  for (const row of list) {
    detailsByOrderId[String(row.id)] = {
      uncovered_quantity: row.uncovered_quantity,
      covered_by_actual_quantity: row.covered_by_actual_quantity,
      covered_by_incoming_quantity: row.covered_by_incoming_quantity,
      lines: row.lines,
      calculated_at: new Date().toISOString(),
    };
  }
  if (!ordersRepo?.setStockProblemFlags) {
    const err = new Error('Orders repository does not support stock_problem flags');
    err.statusCode = 501;
    throw err;
  }
  return await ordersRepo.setStockProblemFlags({
    problemOrderIds: problemIds,
    detailsByOrderId,
    activeStatuses: Array.from(ACTIVE_ORDER_STATUSES.values()),
  });
}

