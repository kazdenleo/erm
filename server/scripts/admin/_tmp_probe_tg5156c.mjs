import { query, closePool } from '../../src/config/database.js';
import fboSupplyReserveService from '../../src/services/fboSupplyReserve.service.js';

const PID = 314;

// All open/new/ready/packed supplies with this product
const open = await query(
  `SELECT s.id, s.status, s.ready_at, s.marketplace_warehouse_name, s.placement_cluster,
          s.external_shipment_number, s.deduction_warehouse_id,
          si.id AS item_id, si.quantity, si.collected_quantity
   FROM fbo_supply_items si
   JOIN fbo_supplies s ON s.id = si.fbo_supply_id
   WHERE si.product_id = $1
     AND s.status NOT IN ('closed', 'cancelled', 'shipped', 'delivered')
   ORDER BY s.ready_at NULLS LAST, s.id`,
  [PID]
);
console.log('=== OPEN supplies with TG-5156 ===');
console.log(JSON.stringify(open.rows, null, 2));

// Net reserved for those items
const itemIds = open.rows.map((r) => Number(r.item_id));
const nets = await query(
  `SELECT (sm.meta->>'fbo_supply_item_id')::bigint AS item_id,
          COALESCE(SUM(sm.quantity_change),0)::int AS net
   FROM stock_movements sm
   WHERE sm.product_id = $1
     AND sm.type IN ('reserve','unreserve')
     AND (sm.meta->>'fbo_supply_item_id')::bigint = ANY($2::bigint[])
   GROUP BY 1`,
  [PID, itemIds]
);
const netMap = new Map(nets.rows.map((r) => [String(r.item_id), Number(r.net)]));
console.log('=== open items reserved (net; negative=reserved) ===');
for (const r of open.rows) {
  const net = netMap.get(String(r.item_id)) || 0;
  console.log({
    supply: r.id,
    item: r.item_id,
    status: r.status,
    ready_at: r.ready_at,
    cluster: r.placement_cluster,
    qty: r.quantity,
    reserved: -Math.min(0, net),
    net,
    shipment: r.external_shipment_number,
  });
}

const fboQty = await query(
  `SELECT COALESCE(quantity,0)::int AS qty FROM product_warehouse_stock
   WHERE product_id=$1 AND warehouse_id=6`,
  [PID]
);
const prod = await query(
  `SELECT COALESCE(quantity,0)::int AS qty, COALESCE(reserved_quantity,0)::int AS reserved
   FROM products WHERE id=$1`,
  [PID]
);
console.log('FBO wh qty', fboQty.rows[0], 'product', prod.rows[0],
  'free product', prod.rows[0].qty - prod.rows[0].reserved);

// What does rebalance think?
console.log('\n=== running rebalanceReservesForProduct ===');
const before = { ...prod.rows[0] };
await fboSupplyReserveService.rebalanceReservesForProduct(PID, 6, { profileId: 6 });

const afterProd = await query(
  `SELECT COALESCE(quantity,0)::int AS qty, COALESCE(reserved_quantity,0)::int AS reserved
   FROM products WHERE id=$1`,
  [PID]
);
const afterNets = await query(
  `SELECT (sm.meta->>'fbo_supply_item_id')::bigint AS item_id,
          COALESCE(SUM(sm.quantity_change),0)::int AS net
   FROM stock_movements sm
   WHERE sm.product_id = $1
     AND sm.type IN ('reserve','unreserve')
     AND (sm.meta->>'fbo_supply_item_id')::bigint = ANY($2::bigint[])
   GROUP BY 1`,
  [PID, itemIds]
);
console.log('before', before, 'after', afterProd.rows[0]);
console.log('after nets', afterNets.rows);

const saratov = afterNets.rows.find((r) => String(r.item_id) === '11335');
console.log('Saratov item 11335 after rebalance', saratov);

await closePool();
