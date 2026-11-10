import 'dotenv/config';
import { query } from '../../src/config/database.js';

const skus = ['SN-2303', 'SN-2490', 'SN-2173', 'TG-5124', 'SN-2302', 'TG-5400', 'TG-5401', 'SN-2172'];

const products = await query(
  `SELECT id, sku FROM products WHERE sku = ANY($1::text[])`,
  [skus]
);
const ids = products.rows.map((r) => Number(r.id));
const byId = new Map(products.rows.map((r) => [Number(r.id), r.sku]));

// Recent inventory on wh6 for these
const inv = await query(
  `SELECT s.id AS session_id, s.warehouse_id, s.created_at,
          l.product_id, l.quantity_before::int AS before_qty, l.quantity_after::int AS after_qty,
          (l.quantity_after-l.quantity_before)::int AS diff
   FROM inventory_session_lines l
   JOIN inventory_sessions s ON s.id=l.session_id
   WHERE l.product_id = ANY($1::bigint[])
   ORDER BY s.id DESC, l.product_id
   LIMIT 80`,
  [ids]
);
console.log('inventory_any_wh', inv.rows.map((r) => ({
  ...r,
  sku: byId.get(Number(r.product_id)),
})));

const invCols = await query(
  `SELECT column_name FROM information_schema.columns WHERE table_name='inventory_sessions' ORDER BY 1`
);
console.log('inv_session_cols', invCols.rows.map((r) => r.column_name));

// Purchase 514 lines for these
const p514 = await query(
  `SELECT p.sku, pi.expected_quantity::int AS expected, COALESCE(pi.received_quantity,0)::int AS received,
          (COALESCE(pi.received_quantity,0)-pi.expected_quantity)::int AS diff
   FROM purchase_items pi JOIN products p ON p.id=pi.product_id
   WHERE pi.purchase_id=514 AND pi.product_id = ANY($1::bigint[])
   ORDER BY p.sku`,
  [ids]
);
console.log('purchase_514', p514.rows);

// Purchase 344 overages
const p344 = await query(
  `SELECT p.sku, pi.expected_quantity::int AS expected, COALESCE(pi.received_quantity,0)::int AS received,
          (COALESCE(pi.received_quantity,0)-pi.expected_quantity)::int AS diff
   FROM purchase_items pi JOIN products p ON p.id=pi.product_id
   WHERE pi.purchase_id=344 AND pi.product_id = ANY($1::bigint[])
   ORDER BY p.sku`,
  [ids]
);
console.log('purchase_344', p344.rows);

// FBO packing stats: planned vs packed for kits
const kitSkus = ['DTSN2302-03RL', 'DTSN2490-2173RL', 'DTTG5124RL', 'DTTG5400-01RL', 'DTSN2172-73RL'];
const kits = await query(`SELECT id, sku FROM products WHERE sku = ANY($1::text[])`, [kitSkus]);
for (const k of kits.rows) {
  const rows = await query(
    `SELECT s.id, s.status, s.external_shipment_number AS ship, si.quantity::int AS planned,
            COALESCE((
              SELECT SUM(cc.quantity)::int FROM fbo_supply_cargo_contents cc
              JOIN fbo_supply_cargo_units cu ON cu.id=cc.cargo_unit_id AND cu.fbo_supply_id=s.id
              WHERE cc.fbo_supply_item_id=si.id
            ),0) AS packed,
            COALESCE(si.collected_quantity,0)::int AS collected
     FROM fbo_supply_items si
     JOIN fbo_supplies s ON s.id=si.fbo_supply_id
     WHERE si.product_id=$1 AND s.status NOT IN ('closed','return','shipped')
     ORDER BY s.id`,
    [k.id]
  );
  console.log('kit_progress', k.sku, rows.rows);
}

// Physical story: free stock across warehouses vs user claims
for (const sku of ['SN-2303', 'SN-2490', 'SN-2173', 'TG-5124', 'SN-2302', 'TG-5400']) {
  const p = products.rows.find((x) => x.sku === sku);
  if (!p) continue;
  const pws = await query(
    `SELECT warehouse_id::int AS wh, quantity::int AS on_hand FROM product_warehouse_stock WHERE product_id=$1`,
    [p.id]
  );
  console.log('on_hand', sku, pws.rows);
}

process.exit(0);
