import { query, closePool } from '../../src/config/database.js';
import fboSupplyReserveService from '../../src/services/fboSupplyReserve.service.js';

const PID = 314;

const pwsCols = await query(`
  SELECT column_name FROM information_schema.columns
  WHERE table_name = 'product_warehouse_stock' ORDER BY ordinal_position`);
console.log('pws cols', pwsCols.rows.map((r) => r.column_name).join(', '));

const whCols = await query(`
  SELECT column_name FROM information_schema.columns
  WHERE table_name = 'warehouses' ORDER BY ordinal_position`);
console.log('warehouses cols', whCols.rows.map((r) => r.column_name).join(', '));

const pws = await query(
  `SELECT pws.*, w.name AS warehouse_name
   FROM product_warehouse_stock pws
   LEFT JOIN warehouses w ON w.id = pws.warehouse_id
   WHERE pws.product_id = $1
   ORDER BY pws.warehouse_id`,
  [PID]
);
console.log('=== product_warehouse_stock ===');
console.log(JSON.stringify(pws.rows, null, 2));

const prod = await query(
  `SELECT id, sku,
          COALESCE(quantity,0)::int AS qty,
          COALESCE(reserved_quantity,0)::int AS reserved,
          COALESCE(incoming_quantity,0)::int AS incoming
   FROM products WHERE id = $1`,
  [PID]
);
console.log('=== product ===', JSON.stringify(prod.rows, null, 2));

const items = await query(
  `SELECT s.id AS supply_id, s.status, s.marketplace, s.name,
          s.marketplace_warehouse_name, s.deduction_warehouse_id, s.ready_at,
          s.external_shipment_number, s.placement_cluster,
          si.id AS item_id, si.quantity, si.collected_quantity, si.sku, si.product_id
   FROM fbo_supply_items si
   JOIN fbo_supplies s ON s.id = si.fbo_supply_id
   WHERE si.product_id = $1
   ORDER BY s.ready_at NULLS LAST, s.id`,
  [PID]
);
console.log('=== FBO items TG-5156 ===');
console.log(JSON.stringify(items.rows, null, 2));

const saratov = await query(
  `SELECT s.id, s.status, s.marketplace, s.name, s.marketplace_warehouse_name,
          s.deduction_warehouse_id, s.ready_at, s.placement_cluster,
          si.id AS item_id, si.product_id, p.sku, si.quantity, si.collected_quantity
   FROM fbo_supplies s
   LEFT JOIN fbo_supply_items si ON si.fbo_supply_id = s.id AND si.product_id = $1
   LEFT JOIN products p ON p.id = si.product_id
   WHERE s.marketplace_warehouse_name ILIKE '%Сарат%'
      OR s.name ILIKE '%Сарат%'
      OR COALESCE(s.placement_cluster,'') ILIKE '%Сарат%'
   ORDER BY s.id DESC
   LIMIT 40`,
  [PID]
);
console.log('=== Saratov supplies (with TG-5156 item if any) ===');
console.log(JSON.stringify(saratov.rows, null, 2));

const orderRes = await query(
  `SELECT sm.id, sm.type, sm.quantity_change, sm.reason, sm.warehouse_id, sm.created_at,
          sm.meta->>'order_id' AS order_id,
          sm.meta->>'fbo_supply_id' AS fbo_supply_id,
          sm.meta->>'fbo_supply_item_id' AS fbo_supply_item_id,
          sm.reserved_after, sm.wh_reserved_after
   FROM stock_movements sm
   WHERE sm.product_id = $1 AND sm.type IN ('reserve','unreserve')
   ORDER BY sm.id DESC
   LIMIT 50`,
  [PID]
);
console.log('=== recent reserve/unreserve ===');
console.log(JSON.stringify(orderRes.rows, null, 2));

// Net reserved by fbo item
const netByItem = await query(
  `SELECT (sm.meta->>'fbo_supply_item_id')::bigint AS item_id,
          SUM(CASE WHEN sm.type='reserve' THEN sm.quantity_change
                   WHEN sm.type='unreserve' THEN sm.quantity_change
                   ELSE 0 END)::int AS net
   FROM stock_movements sm
   WHERE sm.product_id = $1
     AND sm.type IN ('reserve','unreserve')
     AND sm.meta ? 'fbo_supply_item_id'
   GROUP BY 1
   ORDER BY 1`,
  [PID]
);
console.log('=== net reserved by fbo item ===', JSON.stringify(netByItem.rows, null, 2));

// Also order-level reserved (no fbo)
const orderNet = await query(
  `SELECT COALESCE(SUM(sm.quantity_change),0)::int AS net_orderish
   FROM stock_movements sm
   WHERE sm.product_id = $1
     AND sm.type IN ('reserve','unreserve')
     AND (sm.meta ? 'order_id')
     AND NOT (sm.meta ? 'fbo_supply_item_id')`,
  [PID]
);
console.log('=== net order reserves (no fbo) ===', orderNet.rows);

const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(fboSupplyReserveService)).filter(
  (m) => typeof fboSupplyReserveService[m] === 'function'
);
console.log('service methods', methods);

// Try enrich
const openItems = items.rows.filter((r) => !['shipped', 'cancelled', 'delivered'].includes(String(r.status)));
if (openItems.length) {
  const enriched = await fboSupplyReserveService.enrichItemsWithReserved(
    openItems.map((r) => ({
      id: r.item_id,
      productId: r.product_id,
      quantity: r.quantity,
      fboSupplyId: r.supply_id,
    })),
    { profileId: 6 }
  );
  console.log('=== enriched open items ===');
  console.log(JSON.stringify(enriched, null, 2));
}

await closePool();
