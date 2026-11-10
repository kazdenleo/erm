import 'dotenv/config';
import { query } from '../../src/config/database.js';
import { NET_RESERVED_MOVEMENT_ROW_CASE_SQL } from '../../src/constants/netReservedStockSql.js';

const sku = 'SN-2302';
const p = (
  await query(
    `SELECT id, sku, name, quantity::int AS qty, reserved_quantity::int AS reserved
     FROM products WHERE sku=$1`,
    [sku]
  )
).rows[0];
console.log('product', p);
const pid = Number(p.id);

const pws = await query(
  `SELECT warehouse_id::int AS wh, quantity::int AS on_hand
   FROM product_warehouse_stock WHERE product_id=$1 ORDER BY 1`,
  [pid]
);
const nets = await query(
  `SELECT warehouse_id::int AS wh,
          GREATEST(0, COALESCE(SUM(${NET_RESERVED_MOVEMENT_ROW_CASE_SQL}),0))::int AS reserved
   FROM stock_movements WHERE product_id=$1 AND type IN ('reserve','unreserve')
   GROUP BY 1 ORDER BY 1`,
  [pid]
);
console.log('pws', pws.rows);
console.log('nets', nets.rows);

// Pair component
const pair = (
  await query(`SELECT id, sku, quantity::int AS qty, reserved_quantity::int AS reserved FROM products WHERE sku='SN-2303'`)
).rows[0];
const pairPws = await query(
  `SELECT warehouse_id::int AS wh, quantity::int AS on_hand FROM product_warehouse_stock WHERE product_id=$1 ORDER BY 1`,
  [pair.id]
);
const pairNets = await query(
  `SELECT warehouse_id::int AS wh,
          GREATEST(0, COALESCE(SUM(${NET_RESERVED_MOVEMENT_ROW_CASE_SQL}),0))::int AS reserved
   FROM stock_movements WHERE product_id=$1 AND type IN ('reserve','unreserve')
   GROUP BY 1 ORDER BY 1`,
  [pair.id]
);
console.log('pair_SN-2303', pair, pairPws.rows, pairNets.rows);

const kit = (
  await query(`SELECT id, sku FROM products WHERE sku='DTSN2302-03RL'`)
).rows[0];
console.log('kit', kit);

// All FBO lines for kit recently closed/shipped/open
const lines = await query(
  `SELECT s.id, s.status, s.external_shipment_number AS ship, s.stock_deducted_at, s.deduct_stock,
          s.ready_at, s.updated_at, si.quantity::int AS planned,
          COALESCE(si.collected_quantity,0)::int AS collected,
          COALESCE((
            SELECT SUM(cc.quantity)::int FROM fbo_supply_cargo_contents cc
            JOIN fbo_supply_cargo_units cu ON cu.id=cc.cargo_unit_id AND cu.fbo_supply_id=s.id
            WHERE cc.fbo_supply_item_id=si.id
          ),0) AS packed
   FROM fbo_supply_items si
   JOIN fbo_supplies s ON s.id=si.fbo_supply_id
   WHERE si.product_id=$1
   ORDER BY s.id DESC
   LIMIT 25`,
  [kit.id]
);
console.log('kit_fbo_lines', lines.rows);

const openNeed = lines.rows
  .filter((r) => !['closed', 'return', 'shipped'].includes(r.status) && r.deduct_stock)
  .reduce((s, r) => s + r.planned, 0);
const closedRecent = lines.rows.filter((r) => ['closed', 'shipped'].includes(r.status)).slice(0, 8);
console.log({ openNeed, closedRecentCount: closedRecent.length });

// Stock movements last 60d detailed for SN-2302
const moves = await query(
  `SELECT id, type, warehouse_id::int AS wh, quantity_change::int AS dq, created_at, reason,
          meta->>'fbo_supply_id' AS supply_id,
          meta->>'fbo_supply_item_id' AS item_id,
          meta->>'kit_product_id' AS kit_id,
          meta->>'purchase_id' AS purchase_id,
          meta->>'receipt_id' AS receipt_id
   FROM stock_movements
   WHERE product_id=$1 AND created_at >= NOW() - INTERVAL '60 days'
   ORDER BY id DESC
   LIMIT 80`,
  [pid]
);
console.log(
  'moves_60d',
  moves.rows.map((r) => ({
    id: r.id,
    type: r.type,
    wh: r.wh,
    dq: r.dq,
    at: r.created_at,
    reason: r.reason,
    supply: r.supply_id,
    purchase: r.purchase_id,
    receipt: r.receipt_id,
    kit: r.kit_id,
  }))
);

// Sum by type
const sums = await query(
  `SELECT type, warehouse_id::int AS wh, COALESCE(SUM(quantity_change),0)::int AS dq, COUNT(*)::int AS n
   FROM stock_movements
   WHERE product_id=$1 AND created_at >= NOW() - INTERVAL '60 days'
   GROUP BY 1,2 ORDER BY 1,2`,
  [pid]
);
console.log('sums_60d', sums.rows);

// Purchases received totals
const purch = await query(
  `SELECT p.id, p.status, p.warehouse_id::int AS wh,
          pi.expected_quantity::int AS expected,
          COALESCE(pi.received_quantity,0)::int AS received,
          (COALESCE(pi.received_quantity,0)-pi.expected_quantity)::int AS over
   FROM purchase_items pi JOIN purchases p ON p.id=pi.purchase_id
   WHERE pi.product_id=$1
   ORDER BY p.id DESC LIMIT 12`,
  [pid]
);
console.log('purchases', purch.rows);
const totalOver = purch.rows.reduce((s, r) => s + Math.max(0, r.over), 0);
const totalReceived = purch.rows.reduce((s, r) => s + r.received, 0);
console.log({ totalReceived_listed: totalReceived, totalOver_listed: totalOver });

// Active FBO hard reserve detail for SN-2302
const res = await query(
  `SELECT meta->>'fbo_supply_id' AS supply_id,
          meta->>'kit_product_id' AS kit_id,
          warehouse_id::int AS wh,
          GREATEST(0, COALESCE(SUM(${NET_RESERVED_MOVEMENT_ROW_CASE_SQL}),0))::int AS net
   FROM stock_movements
   WHERE product_id=$1 AND type IN ('reserve','unreserve') AND meta ? 'fbo_supply_item_id'
   GROUP BY 1,2,3
   HAVING GREATEST(0, COALESCE(SUM(${NET_RESERVED_MOVEMENT_ROW_CASE_SQL}),0)) > 0
   ORDER BY net DESC`,
  [pid]
);
const sids = res.rows.map((r) => Number(r.supply_id)).filter(Boolean);
const st = sids.length
  ? await query(`SELECT id, status, external_shipment_number AS ship FROM fbo_supplies WHERE id=ANY($1::bigint[])`, [sids])
  : { rows: [] };
const smap = new Map(st.rows.map((s) => [String(s.id), s]));
console.log(
  'hard_reserves',
  res.rows.map((r) => ({
    net: r.net,
    wh: r.wh,
    supply: r.supply_id,
    status: smap.get(String(r.supply_id))?.status,
    ship: smap.get(String(r.supply_id))?.ship,
  }))
);

// Hypothesis: physical leftover = wh5 free + historical over + not yet shipped open?
console.log('HYPOTHESIS', {
  system_total: p.qty,
  system_reserved: p.reserved,
  system_free: p.qty - p.reserved,
  wh6_on: pws.rows.find((w) => w.wh === 6)?.on_hand || 0,
  wh5_on: pws.rows.find((w) => w.wh === 5)?.on_hand || 0,
  open_fbo_need: openNeed,
  pair_2303_total: pair.qty,
  pair_2303_wh6: pairPws.rows.find((w) => w.wh === 6)?.on_hand || 0,
  pair_2303_wh5: pairPws.rows.find((w) => w.wh === 5)?.on_hand || 0,
  asymmetry_2302_minus_2303: p.qty - pair.qty,
});

process.exit(0);
