import { query, closePool } from '../../src/config/database.js';
import fboSuppliesPurchaseCalcService from '../../src/services/fboSuppliesPurchaseCalc.service.js';

const skus = ['SM-5005', 'SN-2170'];
const prods = await query(
  `SELECT id, sku FROM products WHERE UPPER(TRIM(sku)) = ANY($1::text[])`,
  [skus.map((s) => s.toUpperCase())]
);
const ids = prods.rows.map((r) => Number(r.id));

const pendingAny = await query(
  `SELECT p.id, p.status, p.warehouse_id, pr.sku,
          pi.expected_quantity, pi.received_quantity,
          GREATEST(0, COALESCE(pi.expected_quantity,0)-COALESCE(pi.received_quantity,0))::int AS pending
   FROM purchase_items pi
   JOIN purchases p ON p.id = pi.purchase_id
   JOIN products pr ON pr.id = pi.product_id
   WHERE pi.product_id = ANY($1::bigint[])
     AND GREATEST(0, COALESCE(pi.expected_quantity,0)-COALESCE(pi.received_quantity,0)) > 0
   ORDER BY p.id DESC`,
  [ids]
);
console.log('ANY status with pending>0', pendingAny.rows);

const statuses = await query(`SELECT status, COUNT(*)::int n FROM purchases GROUP BY status ORDER BY 1`);
console.log('purchase statuses', statuses.rows);

// Latest open calc sessions
const sess = await query(
  `SELECT id, status, supply_ids, updated_at FROM fbo_purchase_calc_sessions
   WHERE profile_id = 6 AND status = 'open' ORDER BY updated_at DESC LIMIT 5`
);
console.log('open sessions', sess.rows);

for (const s of sess.rows || []) {
  const supplyIds = s.supply_ids;
  const calc = await fboSuppliesPurchaseCalcService.calculate(supplyIds, { profileId: 6 });
  const rows = (calc.rows || []).filter(
    (r) => ids.includes(Number(r.productId)) && (Number(r.incoming) > 0 || Number(r.purchasedQty) > 0)
  );
  const anyIncoming = (calc.rows || []).filter((r) => ids.includes(Number(r.productId)));
  console.log(
    'session',
    s.id,
    'matching rows',
    anyIncoming.map((r) => ({
      sku: r.sku,
      key: r.key,
      onHand: r.onHand,
      incoming: r.incoming,
      incomingTotal: r.incomingTotal,
      toPurchase: r.toPurchase,
      need: r.supplyQtyTotal,
    }))
  );
}

await closePool();
process.exit(0);
