import { query, closePool } from '../../src/config/database.js';

const itemIds = [10971, 11226, 11568, 11733, 11869, 11335];

const rows = await query(
  `SELECT s.id AS supply_id, s.status, s.ready_at, s.placement_cluster,
          s.external_shipment_number, s.stock_deducted_at,
          si.id AS item_id, si.product_id, p.sku, si.quantity, si.collected_quantity
   FROM fbo_supply_items si
   JOIN fbo_supplies s ON s.id = si.fbo_supply_id
   JOIN products p ON p.id = si.product_id
   WHERE si.id = ANY($1::bigint[])
   ORDER BY s.ready_at NULLS LAST, s.id`,
  [itemIds]
);
console.log('=== supplies holding TG-5156-related item reserves ===');
console.log(JSON.stringify(rows.rows, null, 2));

// Also check if those supplies are "in_transit" or similar
const supplies = await query(
  `SELECT id, status, ready_at, placement_cluster, external_shipment_number,
          stock_deducted_at, deduct_stock
   FROM fbo_supplies
   WHERE id IN (197,199,201,202,203,204)
   ORDER BY id`
);
console.log('=== supply heads ===');
console.log(JSON.stringify(supplies.rows, null, 2));

// Current nets after rebalance
const nets = await query(
  `SELECT (sm.meta->>'fbo_supply_item_id')::bigint AS item_id,
          COALESCE(SUM(sm.quantity_change),0)::int AS net
   FROM stock_movements sm
   WHERE sm.product_id = 314
     AND sm.type IN ('reserve','unreserve')
     AND (sm.meta->>'fbo_supply_item_id')::bigint = ANY($1::bigint[])
   GROUP BY 1
   ORDER BY 1`,
  [itemIds]
);
console.log('=== current nets ===', nets.rows);

const prod = await query(
  `SELECT COALESCE(quantity,0)::int AS qty, COALESCE(reserved_quantity,0)::int AS reserved
   FROM products WHERE id=314`
);
const pws = await query(
  `SELECT warehouse_id, quantity FROM product_warehouse_stock WHERE product_id=314`
);
console.log('product', prod.rows[0], 'pws', pws.rows);

await closePool();
