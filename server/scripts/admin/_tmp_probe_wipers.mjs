import 'dotenv/config';
import { query } from '../../src/config/database.js';
import { NET_RESERVED_MOVEMENT_ROW_CASE_SQL } from '../../src/constants/netReservedStockSql.js';
import fboSupplyReserveService from '../../src/services/fboSupplyReserve.service.js';

const cid = 218;
const globalNet = await query(
  `SELECT warehouse_id,
          GREATEST(0, COALESCE(SUM(${NET_RESERVED_MOVEMENT_ROW_CASE_SQL}),0))::int AS net
   FROM stock_movements
   WHERE product_id=$1 AND type IN ('reserve','unreserve')
   GROUP BY 1 ORDER BY 1`,
  [cid]
);
console.log('global_net', globalNet.rows);

const activeNet = await query(
  `SELECT GREATEST(0, COALESCE(SUM(${NET_RESERVED_MOVEMENT_ROW_CASE_SQL}),0))::int AS net
   FROM stock_movements sm
   JOIN fbo_supplies s ON s.id = (sm.meta->>'fbo_supply_id')::bigint
   WHERE sm.product_id=$1
     AND sm.type IN ('reserve','unreserve')
     AND sm.meta ? 'fbo_supply_id'
     AND s.status = ANY($2::text[])
     AND sm.warehouse_id=6`,
  [cid, ['new', 'collecting', 'packing', 'ready_for_supply']]
);
console.log('active_fbo_net_wh6', activeNet.rows[0]);

const closedNet = await query(
  `SELECT GREATEST(0, COALESCE(SUM(${NET_RESERVED_MOVEMENT_ROW_CASE_SQL}),0))::int AS net
   FROM stock_movements sm
   JOIN fbo_supplies s ON s.id = (sm.meta->>'fbo_supply_id')::bigint
   WHERE sm.product_id=$1
     AND sm.type IN ('reserve','unreserve')
     AND sm.meta ? 'fbo_supply_id'
     AND s.status IN ('closed','shipped','return')
     AND sm.warehouse_id=6`,
  [cid]
);
console.log('closed_fbo_net_wh6', closedNet.rows[0]);

const openNeed = await query(
  `SELECT COALESCE(SUM(si.quantity * kc.quantity),0)::int AS comps_needed
   FROM kit_components kc
   JOIN fbo_supply_items si ON si.product_id = kc.kit_product_id
   JOIN fbo_supplies s ON s.id = si.fbo_supply_id
   WHERE kc.component_product_id=$1
     AND s.deduct_stock AND s.status = ANY($2::text[])`,
  [cid, ['new', 'collecting', 'packing', 'ready_for_supply']]
);
console.log('open_fbo_need_comps', openNeed.rows[0]);

const pws = await query(
  `SELECT warehouse_id, quantity::int FROM product_warehouse_stock WHERE product_id=$1`,
  [cid]
);
console.log('on_hand', pws.rows);

// Clean orphans for profile and rebalance component kits
console.log('--- orphan cleanup + profile tip ---');
const orphan = await fboSupplyReserveService.releaseOrphanReservesForProfile(6, {
  skipMarketplaceSync: true,
});
console.log('orphan', orphan);

const globalNet2 = await query(
  `SELECT warehouse_id,
          GREATEST(0, COALESCE(SUM(${NET_RESERVED_MOVEMENT_ROW_CASE_SQL}),0))::int AS net
   FROM stock_movements
   WHERE product_id=$1 AND type IN ('reserve','unreserve')
   GROUP BY 1 ORDER BY 1`,
  [cid]
);
console.log('global_net_after_orphan', globalNet2.rows);

await fboSupplyReserveService.rebalanceReservesForProduct(772, {
  profileId: 6,
  skipMarketplaceSync: true,
});

const items = await query(
  `SELECT si.id AS item_id, si.fbo_supply_id, si.quantity::int AS qty, s.status, s.external_shipment_number AS ship
   FROM fbo_supply_items si JOIN fbo_supplies s ON s.id=si.fbo_supply_id
   WHERE si.product_id=772 AND s.deduct_stock AND s.status = ANY($1::text[])
   ORDER BY s.id`,
  [['new', 'collecting', 'packing', 'ready_for_supply']]
);
const enriched = await fboSupplyReserveService.enrichItemsWithReserved(
  items.rows.map((r) => ({ id: r.item_id, productId: 772, quantity: r.qty })),
  { profileId: 6, reserveEnabled: true }
);
console.log(
  'H550525-2 after orphan+rebalance',
  enriched.map((it, i) => ({
    supply: items.rows[i].fbo_supply_id,
    status: items.rows[i].status,
    qty: items.rows[i].qty,
    stock: it.reservedFromStock,
    gap: Math.max(0, items.rows[i].qty - (it.reservedFromStock || 0) - (it.reservedFromIncoming || 0)),
  }))
);

const globalNet3 = await query(
  `SELECT warehouse_id,
          GREATEST(0, COALESCE(SUM(${NET_RESERVED_MOVEMENT_ROW_CASE_SQL}),0))::int AS net
   FROM stock_movements
   WHERE product_id=$1 AND type IN ('reserve','unreserve')
   GROUP BY 1 ORDER BY 1`,
  [cid]
);
console.log('global_net_final', globalNet3.rows);

process.exit(0);
