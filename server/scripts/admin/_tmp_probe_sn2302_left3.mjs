import 'dotenv/config';
import { query } from '../../src/config/database.js';

const pid = 528;
const rows = await query(
  `SELECT id, type, quantity_change::int AS dq, created_at, reason,
          meta->>'warehouse_balance_before' AS before,
          meta->>'warehouse_balance_after' AS after
   FROM stock_movements
   WHERE product_id=$1 AND warehouse_id=6
     AND type NOT IN ('reserve','unreserve','incoming')
     AND created_at >= '2026-10-14'
   ORDER BY id`,
  [pid]
);
console.log('oct14_plus', rows.rows);

const p484 = await query(`SELECT id, status FROM purchases WHERE id=484`);
const pi = await query(
  `SELECT expected_quantity::int AS e, COALESCE(received_quantity,0)::int AS r
   FROM purchase_items WHERE purchase_id=484 AND product_id=$1`,
  [pid]
);
console.log('p484', p484.rows, pi.rows);

const open = await query(
  `SELECT s.id, s.status, s.external_shipment_number AS ship,
          si.quantity::int AS planned,
          COALESCE(si.collected_quantity,0)::int AS collected,
          COALESCE((
            SELECT SUM(cc.quantity)::int FROM fbo_supply_cargo_contents cc
            JOIN fbo_supply_cargo_units cu ON cu.id=cc.cargo_unit_id AND cu.fbo_supply_id=s.id
            WHERE cc.fbo_supply_item_id=si.id
          ),0) AS packed
   FROM fbo_supply_items si
   JOIN fbo_supplies s ON s.id=si.fbo_supply_id
   WHERE si.product_id=403 AND s.status NOT IN ('closed','return','shipped')
   ORDER BY s.id`
);
console.log('open', open.rows);
const planned = open.rows.reduce((s, r) => s + r.planned, 0);
const packed = open.rows.reduce((s, r) => s + r.packed, 0);
console.log({ planned, packed, left_for_open_not_in_boxes: planned - packed, wh6: 38, wh5: 8 });

// If user finished packing partially: shelf after pulling packed only
console.log('if_pulled_only_packed', {
  shelf_wh6_left: 38 - packed,
  plus_wh5: 8,
  total_visible: 38 - packed + 8,
});
// If they pulled all collected (38): shelf 0 + wh5 8
console.log('if_pulled_all_collected', { shelf: 0 + 8 });

process.exit(0);
