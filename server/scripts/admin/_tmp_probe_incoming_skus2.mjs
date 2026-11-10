import { query, closePool } from '../../src/config/database.js';
import fboSuppliesPurchaseCalcService from '../../src/services/fboSuppliesPurchaseCalc.service.js';

const skus = ['SM-5005', 'SN-2170'];
const prods = await query(
  `SELECT id, sku FROM products WHERE UPPER(TRIM(sku)) = ANY($1::text[])`,
  [skus.map((s) => s.toUpperCase())]
);
const ids = prods.rows.map((r) => Number(r.id));
console.log('ids', prods.rows);

const allPurch = await query(
  `SELECT p.id, p.status, p.warehouse_id, w.is_fbo_stock, w.address,
          pr.sku, pi.expected_quantity, pi.received_quantity,
          GREATEST(0, COALESCE(pi.expected_quantity,0)-COALESCE(pi.received_quantity,0))::int AS pending
   FROM purchase_items pi
   JOIN purchases p ON p.id = pi.purchase_id
   JOIN products pr ON pr.id = pi.product_id
   LEFT JOIN warehouses w ON w.id = p.warehouse_id
   WHERE pi.product_id = ANY($1::bigint[])
   ORDER BY p.id DESC
   LIMIT 40`,
  [ids]
);
console.log('all purchases (any status)', allPurch.rows);

const sessions = await query(
  `SELECT s.id, s.status, s.supply_ids, s.updated_at,
          rs.row_key, rs.product_id, rs.purchased_qty, pr.sku
   FROM fbo_purchase_calc_sessions s
   JOIN fbo_purchase_calc_row_state rs ON rs.session_id = s.id
   LEFT JOIN products pr ON pr.id = rs.product_id
   WHERE rs.product_id = ANY($1::bigint[])
     AND s.status = 'open'
   ORDER BY s.updated_at DESC
   LIMIT 30`,
  [ids]
);
console.log('open sessions with these products', sessions.rows);

const openSessionIds = [...new Set(sessions.rows.map((r) => Number(r.id)))];
for (const sid of openSessionIds.slice(0, 3)) {
  const head = await query(`SELECT supply_ids FROM fbo_purchase_calc_sessions WHERE id = $1`, [sid]);
  const supplyIds = head.rows[0]?.supply_ids;
  console.log('\n=== session', sid, 'supplies', supplyIds);
  const calc = await fboSuppliesPurchaseCalcService.calculate(supplyIds, { profileId: 6 });
  const rows = (calc.rows || []).filter((r) => ids.includes(Number(r.productId)));
  console.log(
    'calc rows',
    rows.map((r) => ({
      key: r.key,
      sku: r.sku,
      onHand: r.onHand,
      incoming: r.incoming,
      incomingTotal: r.incomingTotal,
      toPurchase: r.toPurchase,
      supplyQtyTotal: r.supplyQtyTotal,
    }))
  );
}

await closePool();
process.exit(0);
