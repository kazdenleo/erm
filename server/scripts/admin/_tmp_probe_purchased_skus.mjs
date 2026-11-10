import { query, closePool } from '../../src/config/database.js';
import fboPurchaseCalcSessionService from '../../src/services/fboPurchaseCalcSession.service.js';

const skus = ['SM-5005', 'SN-2170'];
const prods = await query(
  `SELECT id, sku FROM products WHERE UPPER(TRIM(sku)) = ANY($1::text[])`,
  [skus.map((s) => s.toUpperCase())]
);
const ids = prods.rows.map((r) => Number(r.id));
const byId = new Map(prods.rows.map((r) => [Number(r.id), r.sku]));

const rs = await query(
  `SELECT s.id AS session_id, s.status, rs.row_key, rs.product_id, rs.purchased_qty, s.updated_at
   FROM fbo_purchase_calc_row_state rs
   JOIN fbo_purchase_calc_sessions s ON s.id = rs.session_id
   WHERE rs.product_id = ANY($1::bigint[])
   ORDER BY s.updated_at DESC, rs.purchased_qty DESC
   LIMIT 40`,
  [ids]
);
console.log(
  'row state',
  rs.rows.map((r) => ({
    session: r.session_id,
    status: r.status,
    sku: byId.get(Number(r.product_id)),
    key: r.row_key,
    purchased: r.purchased_qty,
    updated: r.updated_at,
  }))
);

const openSess = await query(
  `SELECT id FROM fbo_purchase_calc_sessions WHERE profile_id = 6 AND status = 'open' ORDER BY updated_at DESC LIMIT 3`
);
for (const s of openSess.rows || []) {
  const view = await fboPurchaseCalcSessionService.getSessionView(s.id, { profileId: 6 });
  const rows = (view.calc?.rows || []).filter((r) => ids.includes(Number(r.productId)));
  console.log(
    'view session',
    s.id,
    rows.map((r) => ({
      sku: r.sku,
      purchasedQty: r.purchasedQty,
      incoming: r.incoming,
      onHand: r.onHand,
      toPurchase: r.toPurchase,
      remaining: r.remainingToPurchase,
      need: r.supplyQtyTotal,
    }))
  );
}

await closePool();
process.exit(0);
