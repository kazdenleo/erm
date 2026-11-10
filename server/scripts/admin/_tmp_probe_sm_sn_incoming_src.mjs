import { query, closePool } from '../../src/config/database.js';
import { INCOMING_NET_SUM_EXPR_SQL } from '../../src/constants/netReservedStockSql.js';
import fboSuppliesPurchaseCalcService from '../../src/services/fboSuppliesPurchaseCalc.service.js';

const ids = [525, 1270]; // SN-2170, SM-5005

const p = await query(
  `SELECT id, sku, COALESCE(incoming_quantity,0)::int AS inc FROM products WHERE id = ANY($1::bigint[])`,
  [ids]
);
console.log('product.incoming_quantity', p.rows);

const mov = await query(
  `SELECT product_id, warehouse_id, ${INCOMING_NET_SUM_EXPR_SQL}::int AS net
   FROM stock_movements
   WHERE product_id = ANY($1::bigint[])
     AND LOWER(TRIM(type::text)) = 'incoming'
   GROUP BY product_id, warehouse_id
   HAVING ${INCOMING_NET_SUM_EXPR_SQL} <> 0`,
  [ids]
);
console.log('incoming movements net', mov.rows);

const stock = await query(
  `SELECT product_id, warehouse_id, quantity::int AS qty
   FROM product_warehouse_stock WHERE product_id = ANY($1::bigint[]) AND warehouse_id = 6`,
  [ids]
);
console.log('stock wh6', stock.rows);

const reserved = await query(
  `SELECT product_id,
          GREATEST(0, COALESCE(SUM(
            CASE WHEN type = 'reserve' THEN quantity_change
                 WHEN type = 'unreserve' THEN -quantity_change ELSE 0 END
          ), 0))::int AS rough
   FROM stock_movements
   WHERE product_id = ANY($1::bigint[]) AND warehouse_id = 6 AND type IN ('reserve','unreserve')
   GROUP BY product_id`,
  [ids]
);
console.log('rough reserve', reserved.rows);

// Find session that has need 18 for SM-5005 / 49 for SN-2170
const sess = await query(
  `SELECT id, supply_ids, status, updated_at FROM fbo_purchase_calc_sessions
   WHERE profile_id = 6 ORDER BY updated_at DESC LIMIT 8`
);
for (const s of sess.rows || []) {
  const calc = await fboSuppliesPurchaseCalcService.calculate(s.supply_ids, { profileId: 6 });
  const rows = (calc.rows || []).filter((r) => ids.includes(Number(r.productId)));
  const hit = rows.find(
    (r) =>
      (Number(r.productId) === 1270 && Number(r.supplyQtyTotal) === 18) ||
      (Number(r.productId) === 525 && Number(r.supplyQtyTotal) === 49)
  );
  if (hit || rows.some((r) => Number(r.incoming) > 0)) {
    console.log(
      'session',
      s.id,
      s.status,
      rows.map((r) => ({
        sku: r.sku,
        need: r.supplyQtyTotal,
        onHand: r.onHand,
        incoming: r.incoming,
        incomingTotal: r.incomingTotal,
        toPurchase: r.toPurchase,
      }))
    );
  }
}

await closePool();
process.exit(0);
