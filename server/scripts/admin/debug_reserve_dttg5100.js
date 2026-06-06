/**
 * Диагностика резерва DTTG5100 и заказов Ozon.
 * node scripts/admin/debug_reserve_dttg5100.js
 */
import { query } from '../../src/config/database.js';
import { NET_RESERVED_SUM_EXPR_SQL } from '../../src/constants/netReservedStockSql.js';

const SKU = process.argv[2] || 'DTTG5100';
const MP_ORDERS = ['91047662-0209-1', '0180786736-0100-3'];

async function main() {
  const byOrder = await query(
    `SELECT id, order_id, status, offer_id, product_id, product_name
     FROM orders WHERE order_id = ANY($1::text[])`,
    [MP_ORDERS]
  );
  console.log('ORDERS:', byOrder.rows);

  const mvAny = await query(
    `SELECT sm.id, sm.product_id, p.sku, sm.type, sm.quantity_change, sm.meta
     FROM stock_movements sm
     LEFT JOIN products p ON p.id = sm.product_id
     WHERE sm.type IN ('reserve', 'unreserve')
       AND (
         (sm.meta->>'order_id')::bigint IN (SELECT id::bigint FROM orders WHERE order_id = ANY($1::text[]))
         OR TRIM(COALESCE(sm.meta->>'orderId','')) = ANY($1::text[])
       )
     ORDER BY sm.id DESC LIMIT 50`,
    [MP_ORDERS]
  );
  console.log('MOVEMENTS_ANY_PRODUCT:', JSON.stringify(mvAny.rows, null, 2));

  const pr = await query(
    `SELECT id, sku, reserved_quantity FROM products
     WHERE sku = $1 OR sku ILIKE $2
     ORDER BY CASE WHEN sku = $1 THEN 0 ELSE 1 END, sku
     LIMIT 10`,
    [SKU, `%${SKU}%`]
  );
  console.log('PRODUCTS:', pr.rows);
  for (const product of pr.rows) {
    console.log('\n========== PRODUCT', product.id, product.sku, '==========');
    await debugProduct(Number(product.id));
  }
}

async function debugProduct(pid) {
  if (!pid) return;

  const ords = await query(
    `SELECT id, order_id, status, marketplace, product_id FROM orders WHERE order_id = ANY($1::text[]) ORDER BY id`,
    [MP_ORDERS]
  );
  console.log('ORDERS:', ords.rows);

  const mv = await query(
    `SELECT id, type, quantity_change, meta, warehouse_id, created_at
     FROM stock_movements
     WHERE product_id = $1 AND type IN ('reserve', 'unreserve')
     ORDER BY id DESC LIMIT 40`,
    [pid]
  );
  console.log('MOVEMENTS:', JSON.stringify(mv.rows, null, 2));

  const nets = await query(
    `SELECT (COALESCE(NULLIF(meta->>'order_id',''), NULLIF(meta->>'orderId',''))) AS meta_key,
            ${NET_RESERVED_SUM_EXPR_SQL}::int AS net
     FROM stock_movements
     WHERE product_id = $1 AND type IN ('reserve', 'unreserve')
     GROUP BY 1
     HAVING ${NET_RESERVED_SUM_EXPR_SQL} > 0`,
    [pid]
  );
  console.log('NET_BY_META_KEY:', nets.rows);

  const listSim = await query(
    `WITH order_ids AS (
       SELECT DISTINCT (COALESCE(NULLIF(meta->>'order_id',''), NULLIF(meta->>'orderId','')))::bigint AS order_row_id
       FROM stock_movements
       WHERE product_id = $1
         AND type IN ('reserve', 'unreserve')
         AND (COALESCE(NULLIF(meta->>'order_id',''), NULLIF(meta->>'orderId',''))) ~ '^[0-9]+$'
     ),
     sku_net AS (
       SELECT (COALESCE(NULLIF(meta->>'order_id',''), NULLIF(meta->>'orderId','')))::bigint AS order_row_id,
         ${NET_RESERVED_SUM_EXPR_SQL}::int AS sku_net_qty
       FROM stock_movements
       WHERE product_id = $1 AND type IN ('reserve', 'unreserve')
         AND (COALESCE(NULLIF(meta->>'order_id',''), NULLIF(meta->>'orderId',''))) ~ '^[0-9]+$'
       GROUP BY 1
     )
     SELECT o.id, o.order_id, o.status, sku_net.sku_net_qty, order_ids.order_row_id AS movement_order_db_id
     FROM order_ids
     LEFT JOIN sku_net ON sku_net.order_row_id = order_ids.order_row_id
     LEFT JOIN LATERAL (
       SELECT o.id, o.order_id, o.status
       FROM orders o
       WHERE o.id = order_ids.order_row_id
          OR (o.order_id IS NOT NULL AND TRIM(o.order_id) = TRIM(order_ids.order_row_id::text))
       ORDER BY CASE WHEN o.id = order_ids.order_row_id THEN 0 ELSE 1 END, o.id DESC
       LIMIT 1
     ) o ON true
     WHERE COALESCE(sku_net.sku_net_qty, 0) > 0`,
    [pid]
  );
  console.log('LIST_SIM:', listSim.rows);

  const pws = await query(
    `SELECT warehouse_id, quantity FROM product_warehouse_stock WHERE product_id = $1`,
    [pid]
  );
  console.log('PWS:', pws.rows);

  const ordProd = await query(
    `SELECT id, order_id, status, offer_id, product_id, quantity
     FROM orders
     WHERE product_id = $1 OR offer_id = (SELECT sku FROM products WHERE id = $1)
        OR order_id = ANY($2::text[])
     ORDER BY id DESC LIMIT 30`,
    [pid, MP_ORDERS]
  );
  console.log('ORDERS_FOR_PRODUCT:', ordProd.rows);

  for (const o of ords.rows) {
    const oid = o.id;
    const label = o.order_id;
    const r1 = await query(
      `SELECT ${NET_RESERVED_SUM_EXPR_SQL}::int AS net
       FROM stock_movements
       WHERE product_id = $1 AND type IN ('reserve', 'unreserve')
         AND (meta->>'order_id')::bigint = $2::bigint`,
      [pid, oid]
    );
    const r2 = await query(
      `SELECT ${NET_RESERVED_SUM_EXPR_SQL}::int AS net
       FROM stock_movements
       WHERE product_id = $1 AND type IN ('reserve', 'unreserve')
         AND TRIM(COALESCE(meta->>'orderId','')) = TRIM($2::text)`,
      [pid, label]
    );
    console.log(`NET order id=${oid} label=${label}: by order_id=${r1.rows[0]?.net}, by orderId=${r2.rows[0]?.net}`);
  }

  const { default: stockMovementsService } = await import('../../src/services/stockMovements.service.js');
  for (const wh of [null, 1, 5]) {
    const list = await stockMovementsService.listReservedOrdersForProduct(pid, {
      _skipStaleCleanup: true,
      ...(wh != null ? { warehouseId: wh } : {})
    });
    const summary = await stockMovementsService.getReserveSummaryForProduct(pid, {
      ...(wh != null ? { warehouseId: wh } : {})
    });
    console.log(`API wh=${wh}:`, { list, summary });
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
