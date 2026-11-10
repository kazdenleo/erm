import 'dotenv/config';
import { query } from '../../src/config/database.js';
import { NET_RESERVED_MOVEMENT_ROW_CASE_SQL } from '../../src/constants/netReservedStockSql.js';
import fboSupplyReserveService from '../../src/services/fboSupplyReserve.service.js';

const kitId = 426;
const compId = 567;
const profileId = 6;

const open = await query(
  `SELECT si.id AS item_id, si.fbo_supply_id AS supply_id, si.quantity::int AS qty,
          s.status, s.external_shipment_number AS ship
   FROM fbo_supply_items si
   JOIN fbo_supplies s ON s.id = si.fbo_supply_id
   WHERE si.product_id = $1
     AND s.status NOT IN ('closed', 'return', 'shipped')
     AND s.deduct_stock IS TRUE
   ORDER BY s.id`,
  [kitId]
);
const itemIds = open.rows.map((r) => String(r.item_id));
const byId = new Map(open.rows.map((r) => [String(r.item_id), r]));
console.log(
  'need',
  open.rows.reduce((s, r) => s + r.qty, 0),
  'kits =',
  open.rows.reduce((s, r) => s + r.qty * 2, 0),
  'comps'
);

const stockComp = await query(`SELECT * FROM product_warehouse_stock WHERE product_id = $1`, [compId]);
console.log('comp_stock', stockComp.rows);

const totalNet = await query(
  `SELECT warehouse_id,
          GREATEST(0, COALESCE(SUM(${NET_RESERVED_MOVEMENT_ROW_CASE_SQL}), 0))::int AS net
   FROM stock_movements
   WHERE product_id = $1 AND type IN ('reserve', 'unreserve')
   GROUP BY 1 ORDER BY 1`,
  [compId]
);
console.log('total_net_reserved_comp', totalNet.rows);

const fboRes = await query(
  `SELECT meta->>'fbo_supply_item_id' AS item_id,
          meta->>'fbo_supply_id' AS supply_id,
          warehouse_id,
          GREATEST(0, COALESCE(SUM(${NET_RESERVED_MOVEMENT_ROW_CASE_SQL}), 0))::int AS net
   FROM stock_movements
   WHERE product_id = $1
     AND type IN ('reserve', 'unreserve')
     AND meta ? 'fbo_supply_item_id'
   GROUP BY 1, 2, 3
   HAVING GREATEST(0, COALESCE(SUM(${NET_RESERVED_MOVEMENT_ROW_CASE_SQL}), 0)) > 0
   ORDER BY net DESC`,
  [compId]
);
console.log('fbo_hard_on_comp', fboRes.rows);

const nonFbo = await query(
  `SELECT COALESCE(meta->>'order_id','') AS order_id,
          COALESCE(meta->>'source','') AS source,
          warehouse_id,
          GREATEST(0, COALESCE(SUM(${NET_RESERVED_MOVEMENT_ROW_CASE_SQL}), 0))::int AS net
   FROM stock_movements
   WHERE product_id = $1
     AND type IN ('reserve', 'unreserve')
     AND NOT (meta ? 'fbo_supply_item_id')
   GROUP BY 1, 2, 3
   HAVING GREATEST(0, COALESCE(SUM(${NET_RESERVED_MOVEMENT_ROW_CASE_SQL}), 0)) > 0
   ORDER BY net DESC
   LIMIT 40`,
  [compId]
);
console.log('non_fbo_reserves', nonFbo.rows);

const pCols = await query(
  `SELECT column_name FROM information_schema.columns WHERE table_name='purchases' AND column_name ILIKE '%num%' OR (table_name='purchases' AND column_name IN ('id','status','warehouse_id','title','name','code')) ORDER BY 1`
);
console.log('purchase_cols_sample', pCols.rows);

const purchasesComp = await query(
  `SELECT p.id, p.status, p.warehouse_id,
          pi.expected_quantity::int AS expected,
          COALESCE(pi.received_quantity,0)::int AS received,
          GREATEST(COALESCE(pi.expected_quantity,0)-COALESCE(pi.received_quantity,0),0)::int AS pending
   FROM purchase_items pi
   JOIN purchases p ON p.id = pi.purchase_id
   WHERE pi.product_id = $1
   ORDER BY p.id DESC LIMIT 25`,
  [compId]
);
console.log('comp_purchases', purchasesComp.rows);

const incomingWh6 = await query(
  `SELECT COALESCE(SUM(GREATEST(0, COALESCE(pi.expected_quantity,0)-COALESCE(pi.received_quantity,0))),0)::int AS pending
   FROM purchase_items pi JOIN purchases p ON p.id = pi.purchase_id
   WHERE pi.product_id = $1 AND p.status='open' AND p.warehouse_id=6`,
  [compId]
);
console.log('comp_incoming_open_wh6', incomingWh6.rows[0]);

const fakeItems = open.rows.map((r) => ({ id: r.item_id, productId: kitId, quantity: r.qty }));
const show = async (label) => {
  const enriched = await fboSupplyReserveService.enrichItemsWithReserved(fakeItems, {
    profileId,
    reserveEnabled: true,
  });
  console.log(
    label,
    enriched.map((it) => {
      const o = byId.get(String(it.id));
      const stock = Number(it.reservedFromStock) || 0;
      const path = Number(it.reservedFromIncoming) || 0;
      return {
        supply: o.supply_id,
        ship: o.ship,
        status: o.status,
        kits: o.qty,
        stock,
        path,
        gap: Math.max(0, o.qty - stock - path),
      };
    })
  );
};

await show('before');
await fboSupplyReserveService.rebalanceReservesForProduct(kitId, {
  profileId,
  skipMarketplaceSync: true,
});
await show('after_rebalance');

const fboRes2 = await query(
  `SELECT meta->>'fbo_supply_item_id' AS item_id,
          meta->>'fbo_supply_id' AS supply_id,
          warehouse_id,
          GREATEST(0, COALESCE(SUM(${NET_RESERVED_MOVEMENT_ROW_CASE_SQL}), 0))::int AS net
   FROM stock_movements
   WHERE product_id = $1
     AND type IN ('reserve', 'unreserve')
     AND meta ? 'fbo_supply_item_id'
   GROUP BY 1, 2, 3
   HAVING GREATEST(0, COALESCE(SUM(${NET_RESERVED_MOVEMENT_ROW_CASE_SQL}), 0)) > 0
   ORDER BY 2, 1`,
  [compId]
);
console.log('fbo_hard_after', fboRes2.rows);

const totalNet2 = await query(
  `SELECT warehouse_id,
          GREATEST(0, COALESCE(SUM(${NET_RESERVED_MOVEMENT_ROW_CASE_SQL}), 0))::int AS net
   FROM stock_movements
   WHERE product_id = $1 AND type IN ('reserve', 'unreserve')
   GROUP BY 1 ORDER BY 1`,
  [compId]
);
console.log('total_net_after', totalNet2.rows);

process.exit(0);
