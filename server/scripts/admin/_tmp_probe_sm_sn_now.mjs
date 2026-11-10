import { query, closePool } from '../../src/config/database.js';
import fboSuppliesPurchaseCalcService from '../../src/services/fboSuppliesPurchaseCalc.service.js';
import fboSupplyReserveService from '../../src/services/fboSupplyReserve.service.js';

const skus = ['SM-5005', 'SN-2170'];
const prods = await query(
  `SELECT id, sku FROM products WHERE UPPER(REPLACE(TRIM(sku), ' ', '')) = ANY($1::text[])`,
  [skus.map((s) => s.replace(/\s+/g, '').toUpperCase())]
);
console.log('products', prods.rows);
const ids = prods.rows.map((r) => Number(r.id));

const pending = await query(
  `SELECT p.id, p.status, p.warehouse_id, w.is_fbo_stock, pr.sku,
          pi.expected_quantity, pi.received_quantity,
          GREATEST(0, COALESCE(pi.expected_quantity,0)-COALESCE(pi.received_quantity,0))::int AS pending
   FROM purchase_items pi
   JOIN purchases p ON p.id = pi.purchase_id
   JOIN products pr ON pr.id = pi.product_id
   LEFT JOIN warehouses w ON w.id = p.warehouse_id
   WHERE pi.product_id = ANY($1::bigint[])
     AND GREATEST(0, COALESCE(pi.expected_quantity,0)-COALESCE(pi.received_quantity,0)) > 0`,
  [ids]
);
console.log('pending any', pending.rows);

const stock = await query(
  `SELECT pws.product_id, pr.sku, pws.warehouse_id, pws.quantity::int AS qty, w.is_fbo_stock
   FROM product_warehouse_stock pws
   JOIN products pr ON pr.id = pws.product_id
   JOIN warehouses w ON w.id = pws.warehouse_id
   WHERE pws.product_id = ANY($1::bigint[])`,
  [ids]
);
console.log('stock', stock.rows);

const reserved = await query(
  `SELECT sm.product_id, pr.sku, sm.warehouse_id,
          GREATEST(0, COALESCE(SUM(
            CASE WHEN sm.type = 'reserve' THEN sm.quantity
                 WHEN sm.type = 'unreserve' THEN -sm.quantity ELSE 0 END
          ), 0))::int AS net,
          sm.meta->>'fbo_supply_id' AS supply_id
   FROM stock_movements sm
   JOIN products pr ON pr.id = sm.product_id
   WHERE sm.product_id = ANY($1::bigint[])
     AND sm.type IN ('reserve', 'unreserve')
     AND sm.warehouse_id = 6
   GROUP BY sm.product_id, pr.sku, sm.warehouse_id, sm.meta->>'fbo_supply_id'
   ORDER BY pr.sku, net DESC`,
  [ids]
);
console.log('reserves by supply on wh6', reserved.rows);

const avail = await fboSupplyReserveService.getAvailableStockAndIncomingForPurchaseCalc(ids, {
  profileId: 6,
  warehouseId: 6,
  excludeSupplyIds: [],
});
console.log('available exclude none', [...avail.entries()]);

// Newest open session
const sess = await query(
  `SELECT id, supply_ids FROM fbo_purchase_calc_sessions
   WHERE profile_id = 6 AND status = 'open' ORDER BY updated_at DESC LIMIT 1`
);
if (sess.rows[0]) {
  const calc = await fboSuppliesPurchaseCalcService.calculate(sess.rows[0].supply_ids, {
    profileId: 6,
  });
  const rows = (calc.rows || []).filter((r) => ids.includes(Number(r.productId)));
  console.log(
    'latest session',
    sess.rows[0].id,
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

await closePool();
process.exit(0);
