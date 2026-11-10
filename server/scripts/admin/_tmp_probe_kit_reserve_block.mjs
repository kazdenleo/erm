import { query, closePool } from '../../src/config/database.js';
import fboSupplyReserveService from '../../src/services/fboSupplyReserve.service.js';

// Peek into internals via dynamic import of module... we'll replicate key queries.

const SKUS = ['H650400-1;', 'SM-3073S', 'SM-3085S', 'H550525-2;', 'SM-3043S', 'SM-3030S'];

const products = await query(
  `SELECT id, sku, product_type,
          COALESCE(quantity,0)::int AS qty,
          COALESCE(reserved_quantity,0)::int AS reserved
   FROM products WHERE sku = ANY($1)`,
  [SKUS]
);
console.log('products', products.rows);

for (const p of products.rows) {
  const pid = Number(p.id);
  console.log('\n========', p.sku, 'id', pid, p.product_type, 'qty', p.qty, 'reserved', p.reserved, 'free', p.qty - p.reserved);

  const comps = await query(
    `SELECT kc.component_product_id, kc.quantity, c.sku,
            COALESCE(c.quantity,0)::int AS qty,
            COALESCE(c.reserved_quantity,0)::int AS reserved
     FROM kit_components kc
     JOIN products c ON c.id = kc.component_product_id
     WHERE kc.kit_product_id = $1`,
    [pid]
  );
  console.log('components', comps.rows);

  for (const c of comps.rows) {
    const cid = Number(c.component_product_id);
    const pws = await query(
      `SELECT warehouse_id, quantity FROM product_warehouse_stock WHERE product_id=$1`,
      [cid]
    );
    const netWh = await query(
      `SELECT warehouse_id,
              COALESCE(SUM(CASE WHEN type='reserve' THEN -quantity_change
                                WHEN type='unreserve' THEN -quantity_change
                                ELSE 0 END),0)::int AS weird,
              COALESCE(SUM(quantity_change),0)::int AS net_change
       FROM stock_movements
       WHERE product_id=$1 AND type IN ('reserve','unreserve')
       GROUP BY warehouse_id`,
      [cid]
    );
    // Correct net reserved: reserve has negative quantity_change typically
    const netCorrect = await query(
      `SELECT warehouse_id,
              GREATEST(0, -COALESCE(SUM(quantity_change),0))::int AS reserved_net
       FROM stock_movements
       WHERE product_id=$1 AND type IN ('reserve','unreserve')
       GROUP BY warehouse_id`,
      [cid]
    );
    console.log('  comp', c.sku, 'pws', pws.rows, 'reserved_by_wh', netCorrect.rows,
      'freeGlobal', c.qty - c.reserved);
  }

  // Open FBO queue for this kit
  const queue = await query(
    `SELECT s.id AS supply_id, s.placement_cluster, s.deduction_warehouse_id,
            si.id AS item_id, si.quantity
     FROM fbo_supply_items si
     JOIN fbo_supplies s ON s.id = si.fbo_supply_id
     WHERE si.product_id = $1 AND s.status = 'new'
     ORDER BY s.ready_at NULLS LAST, s.id`,
    [pid]
  );
  console.log('open queue', queue.rows);

  // Try calling getAvailableStockAndIncomingForPurchaseCalc or enrich
  const items = queue.rows.map((r) => ({
    id: r.item_id,
    productId: pid,
    quantity: r.quantity,
    fboSupplyId: r.supply_id,
  }));
  if (items.length) {
    const enriched = await fboSupplyReserveService.enrichItemsWithReserved(items, { profileId: 6 });
    console.log('enriched', enriched.map((e) => ({
      id: e.id,
      qty: e.quantity,
      reservedFromStock: e.reservedFromStock,
      reservedFromIncoming: e.reservedFromIncoming,
      sourceOnHand: e.sourceOnHand,
    })));
  }
}

// Inspect getWarehouseReservableUnits logic via stock for one component of H650400
const h = products.rows.find((r) => r.sku === 'H650400-1;');
if (h) {
  const comps = await query(
    `SELECT component_product_id, quantity FROM kit_components WHERE kit_product_id=$1`,
    [h.id]
  );
  for (const c of comps.rows) {
    const cid = Number(c.component_product_id);
    // replicate reservable = onHand - netReserved on wh 6
    const oh = await query(
      `SELECT COALESCE(quantity,0)::int AS qty FROM product_warehouse_stock
       WHERE product_id=$1 AND warehouse_id=6`,
      [cid]
    );
    const res = await query(
      `SELECT GREATEST(0, -COALESCE(SUM(quantity_change),0))::int AS reserved
       FROM stock_movements
       WHERE product_id=$1 AND warehouse_id=6 AND type IN ('reserve','unreserve')`,
      [cid]
    );
    console.log('H650400 component', cid, 'wh6 onHand', oh.rows[0]?.qty, 'reserved', res.rows[0]?.reserved,
      'reservable', Math.max(0, (oh.rows[0]?.qty || 0) - (res.rows[0]?.reserved || 0)),
      'needPerKit', c.quantity);
  }
}

await closePool();
