import 'dotenv/config';
import { query } from '../../src/config/database.js';

const sku = 'SN-2302';
const p = (await query(`SELECT id FROM products WHERE sku=$1`, [sku])).rows[0];
const pid = Number(p.id);
const kitId = Number((await query(`SELECT id FROM products WHERE sku='DTSN2302-03RL'`)).rows[0].id);

// Manual + shipment + receipt detail
const detail = await query(
  `SELECT id, type, warehouse_id::int AS wh, quantity_change::int AS dq, created_at, reason,
          meta
   FROM stock_movements
   WHERE product_id=$1 AND type IN ('manual','shipment','receipt','outgoing','sale','writeoff','adjustment')
   ORDER BY id DESC LIMIT 40`,
  [pid]
);
console.log('non_reserve_moves', JSON.stringify(detail.rows, null, 2));

// Closed Oct wave: 193-195 — any kit/component deduct?
for (const sid of [193, 194, 195, 199, 203, 204]) {
  const moves = await query(
    `SELECT product_id::int AS pid, type, warehouse_id::int AS wh, quantity_change::int AS dq, reason, created_at
     FROM stock_movements
     WHERE (meta->>'fbo_supply_id') = $1
       AND type NOT IN ('reserve','unreserve')
     ORDER BY id`,
    [String(sid)]
  );
  const skus = moves.rows.length
    ? await query(`SELECT id::int, sku FROM products WHERE id = ANY($1::int[])`, [
        [...new Set(moves.rows.map((r) => r.pid))],
      ])
    : { rows: [] };
  const sm = new Map(skus.rows.map((r) => [r.id, r.sku]));
  console.log(
    `supply_${sid}_non_reserve`,
    moves.rows.map((r) => ({ ...r, sku: sm.get(r.pid) }))
  );
}

// How many DTSN2302 kits closed without deduct vs with
const deductStats = await query(
  `SELECT
     COUNT(*) FILTER (WHERE s.stock_deducted_at IS NOT NULL)::int AS with_deduct,
     COUNT(*) FILTER (WHERE s.stock_deducted_at IS NULL)::int AS without_deduct,
     COALESCE(SUM(si.quantity) FILTER (WHERE s.stock_deducted_at IS NOT NULL),0)::int AS qty_with,
     COALESCE(SUM(si.quantity) FILTER (WHERE s.stock_deducted_at IS NULL AND s.status='closed'),0)::int AS qty_closed_no_deduct,
     COALESCE(SUM(si.quantity) FILTER (WHERE s.status IN ('packing','collecting','new','ready')),0)::int AS qty_open
   FROM fbo_supply_items si
   JOIN fbo_supplies s ON s.id=si.fbo_supply_id
   WHERE si.product_id=$1`,
  [kitId]
);
console.log('kit_deduct_stats', deductStats.rows[0]);

// Lifetime ledger for SN-2302
const life = await query(
  `SELECT type, COALESCE(SUM(quantity_change),0)::int AS dq, COUNT(*)::int AS n
   FROM stock_movements WHERE product_id=$1
   GROUP BY 1 ORDER BY 1`,
  [pid]
);
console.log('lifetime_by_type', life.rows);

const lifeWh = await query(
  `SELECT warehouse_id::int AS wh, type, COALESCE(SUM(quantity_change),0)::int AS dq
   FROM stock_movements WHERE product_id=$1
   GROUP BY 1,2 ORDER BY 1,2`,
  [pid]
);
console.log('lifetime_wh_type', lifeWh.rows);

// Current pws vs sum of all quantity_change by wh (excluding reserve/unreserve)
const recon = await query(
  `SELECT warehouse_id::int AS wh,
          COALESCE(SUM(quantity_change) FILTER (WHERE type NOT IN ('reserve','unreserve')),0)::int AS on_hand_from_moves,
          COALESCE(SUM(CASE WHEN type='reserve' THEN -quantity_change WHEN type='unreserve' THEN quantity_change ELSE 0 END),0)::int AS weird
   FROM stock_movements WHERE product_id=$1
   GROUP BY 1 ORDER BY 1`,
  [pid]
);
const pws = await query(
  `SELECT warehouse_id::int AS wh, quantity::int AS on_hand FROM product_warehouse_stock WHERE product_id=$1`,
  [pid]
);
console.log('recon_on_hand', recon.rows, 'pws', pws.rows);

// Purchase 344 receipts for SN-2302 — how overage happened
const r344 = await query(
  `SELECT r.id, r.status, r.created_at, ri.quantity::int AS qty, ri.product_id
   FROM purchase_receipt_items ri
   JOIN purchase_receipts r ON r.id=ri.receipt_id
   WHERE r.purchase_id=344 AND ri.product_id=$1
   ORDER BY r.id`,
  [pid]
);
console.log('purchase_344_receipts', r344.rows);

// If closed without deduct: physical left warehouse, system kept stock.
// User has MORE physical → opposite: system understates OR they counted reserved open stock as "left".
// Open packs: packed 28 of 38. Collected not packed: 10.
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
   WHERE si.product_id=$1 AND s.status NOT IN ('closed','return','shipped')
   ORDER BY s.id`,
  [kitId]
);
const o = open.rows;
const sum = (k) => o.reduce((s, r) => s + r[k], 0);
console.log('open_detail', o);
console.log('open_sums', {
  planned: sum('planned'),
  collected: sum('collected'),
  packed: sum('packed'),
  collected_not_packed: sum('collected') - sum('packed'),
});

// Physical hypothesis if they finished TODAY's wave packing partially:
// Shelf "left" after packing 28 of 38 from wh6(38): 10 still for open + 8 wh5 = 18, not 30.
// If they packed nothing from stock yet and only counted after a PREVIOUS closed wave...

// Oct 20 closed qty
const oct20 = await query(
  `SELECT SUM(si.quantity)::int AS q
   FROM fbo_supply_items si JOIN fbo_supplies s ON s.id=si.fbo_supply_id
   WHERE si.product_id=$1 AND s.id IN (193,194,195)`,
  [kitId]
);
console.log('oct20_closed_kits', oct20.rows[0]);

// When was purchase 514 received relative to open supplies
const rec514 = await query(
  `SELECT r.id, r.created_at, ri.quantity::int AS qty
   FROM purchase_receipt_items ri
   JOIN purchase_receipts r ON r.id=ri.receipt_id
   WHERE r.purchase_id=514 AND ri.product_id=$1
   ORDER BY r.id`,
  [pid]
);
console.log('purchase_514_receipts', rec514.rows);

process.exit(0);
