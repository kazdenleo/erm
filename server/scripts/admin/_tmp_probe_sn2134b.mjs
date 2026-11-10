/**
 * Probe DTSN2134-35RL FBO coverage + purchases
 */
import { query, closePool } from '../../src/config/database.js';
import fboSupplyReserveService from '../../src/services/fboSupplyReserve.service.js';
import {
  getKitComponents,
  computeAssemblableFromComponentPoolMap,
  computeKitReservableBreakdown,
} from '../../src/services/kitStock.service.js';

async function main() {
  const kitId = 406;
  const profileId = 6;
  const comps = await getKitComponents(kitId);
  console.log(
    'comps',
    comps.map((c) => ({ id: c.component_product_id, qty: c.quantity, sku: c.sku || c.component_sku }))
  );

  const skus = await query(`SELECT id, sku, quantity, reserved_quantity, incoming_quantity FROM products WHERE id = ANY($1::bigint[])`, [
    comps.map((c) => c.component_product_id),
  ]);
  console.log('comp products', skus.rows);

  // open purchases for both comps
  const open = await query(
    `SELECT p.id, p.warehouse_id, w.name, pr.sku, pi.expected_quantity, pi.received_quantity,
            GREATEST(0, pi.expected_quantity - COALESCE(pi.received_quantity,0)) AS open_qty
     FROM purchase_items pi
     JOIN purchases p ON p.id = pi.purchase_id
     JOIN products pr ON pr.id = pi.product_id
     LEFT JOIN warehouses w ON w.id = p.warehouse_id
     WHERE pi.product_id = ANY($1::bigint[])
       AND p.status = 'open'
       AND pi.expected_quantity > COALESCE(pi.received_quantity, 0)
     ORDER BY p.id, pr.sku`,
    [comps.map((c) => c.component_product_id).concat([kitId])]
  );
  console.log('open purchases', open.rows);

  const prof = await query(`SELECT fbo_deduction_warehouse_id FROM profiles WHERE id = $1`, [profileId]);
  const fboWh = Number(prof.rows[0]?.fbo_deduction_warehouse_id);
  console.log('fbo deduction wh', fboWh);

  // column names for fbo_supplies
  const cols = await query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'fbo_supplies' AND column_name ILIKE '%deduct%' OR
           (table_name = 'fbo_supplies' AND column_name ILIKE '%stock%')
     ORDER BY 1`
  );
  console.log('fbo_supplies stock cols', cols.rows);

  const supplies = await query(
    `SELECT s.id AS supply_id, s.status, s.ready_at,
            s.deduction_warehouse_id, s.external_shipment_number,
            s.profile_id,
            si.id AS item_id, si.quantity, si.product_id, pr.sku
     FROM fbo_supply_items si
     JOIN fbo_supplies s ON s.id = si.fbo_supply_id
     JOIN products pr ON pr.id = si.product_id
     WHERE si.product_id = $1
       AND s.status IN ('new','packed','ready_for_supply')
     ORDER BY
       CASE s.status WHEN 'packed' THEN 0 WHEN 'ready_for_supply' THEN 1 WHEN 'new' THEN 2 ELSE 3 END,
       s.ready_at ASC NULLS LAST, s.id, si.id`,
    [kitId]
  );
  console.log('active supplies', supplies.rows);

  if (supplies.rows.length) {
    const enriched = await fboSupplyReserveService.enrichItemsWithReserved(
      supplies.rows.map((r) => ({
        id: r.item_id,
        productId: r.product_id,
        quantity: r.quantity,
      })),
      { profileId, reserveEnabled: true }
    );
    for (const e of enriched) {
      console.log('item', {
        id: e.id,
        qty: e.quantity,
        reserved: e.reserved ?? e.reservedTotal,
        fromStock: e.reservedFromStock,
        fromIncoming: e.reservedFromIncoming,
        sourceOnHand: e.sourceOnHand,
        sourceIncoming: e.sourceIncoming,
      });
    }
  }

  // kit reservable on FBO wh
  if (fboWh) {
    const br = await computeKitReservableBreakdown(kitId, { warehouseId: fboWh });
    console.log('kit reservable on FBO wh', br);
  }

  // incoming-only assemblable
  const pools = new Map();
  for (const r of skus.rows) {
    pools.set(Number(r.id), Math.max(0, Number(r.incoming_quantity) || 0));
  }
  console.log('incoming pools', [...pools.entries()]);
  console.log('assemblable from incoming-only', computeAssemblableFromComponentPoolMap(comps, pools));

  // mixed: on hand free + incoming as "available for coverage" heuristic
  const mixed = new Map();
  for (const r of skus.rows) {
    const free = Math.max(0, (Number(r.quantity) || 0) - (Number(r.reserved_quantity) || 0));
    const inc = Math.max(0, Number(r.incoming_quantity) || 0);
    mixed.set(Number(r.id), free + inc);
  }
  console.log('mixed free+incoming pools', [...mixed.entries()]);
  console.log('assemblable mixed', computeAssemblableFromComponentPoolMap(comps, mixed));

  // batchGetIncomingPool used by FBO
  const { default: unused } = { default: null };
  void unused;
  const incPool = await query(
    `SELECT pi.product_id, p.warehouse_id,
            SUM(GREATEST(0, pi.expected_quantity - COALESCE(pi.received_quantity,0)))::int AS open_qty
     FROM purchase_items pi
     JOIN purchases p ON p.id = pi.purchase_id
     WHERE pi.product_id = ANY($1::bigint[])
       AND p.status = 'open'
     GROUP BY pi.product_id, p.warehouse_id`,
    [comps.map((c) => c.component_product_id)]
  );
  console.log('incoming by purchase wh', incPool.rows);

  // Does supply have stock writeoff flag?
  if (supplies.rows[0]) {
    const s0 = await query(`SELECT * FROM fbo_supplies WHERE id = $1`, [supplies.rows[0].supply_id]);
    const row = s0.rows[0] || {};
    const keys = Object.keys(row).filter((k) => /deduct|stock|reserv|write/i.test(k));
    console.log('supply flags', Object.fromEntries(keys.map((k) => [k, row[k]])));
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closePool());
