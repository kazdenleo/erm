/**
 * Why DTSN2134-35RL still shows 0 path on supply 202
 */
import { query, closePool } from '../../src/config/database.js';
import fboSupplyReserveService from '../../src/services/fboSupplyReserve.service.js';
import fs from 'fs';

async function main() {
  // Confirm deployed code has the fix
  const src = fs.readFileSync('./src/services/fboSupplyReserve.service.js', 'utf8');
  console.log('has takeKitsCoveredByIncomingWithStock', src.includes('takeKitsCoveredByIncomingWithStock'));
  console.log('has assemblableKitsFromIncomingWithStock', src.includes('assemblableKitsFromIncomingWithStock'));

  const kitId = 406;
  const supplyId = 202;
  const profileId = 6;

  const items = await query(
    `SELECT si.id, si.product_id, si.quantity, pr.sku,
            s.deduct_stock, s.deduction_warehouse_id, s.status
     FROM fbo_supply_items si
     JOIN fbo_supplies s ON s.id = si.fbo_supply_id
     JOIN products pr ON pr.id = si.product_id
     WHERE si.fbo_supply_id = $1 AND si.product_id = $2`,
    [supplyId, kitId]
  );
  console.log('supply item', items.rows);

  const comps = await query(
    `SELECT c.id, c.sku, c.quantity AS stock_qty, c.reserved_quantity, c.incoming_quantity,
            kc.quantity AS per_kit
     FROM kit_components kc
     JOIN products c ON c.id = kc.component_product_id
     WHERE kc.kit_product_id = $1`,
    [kitId]
  );
  console.log('comps', comps.rows);

  for (const c of comps.rows) {
    const wh = await query(
      `SELECT warehouse_id, quantity FROM product_warehouse_stock WHERE product_id = $1 ORDER BY warehouse_id`,
      [c.id]
    );
    const open = await query(
      `SELECT p.id, p.warehouse_id, pi.expected_quantity, pi.received_quantity,
              GREATEST(0, pi.expected_quantity - COALESCE(pi.received_quantity,0)) AS open_qty
       FROM purchase_items pi JOIN purchases p ON p.id = pi.purchase_id
       WHERE pi.product_id = $1 AND p.status='open'
         AND pi.expected_quantity > COALESCE(pi.received_quantity,0)`,
      [c.id]
    );
    console.log(`comp ${c.sku} wh`, wh.rows, 'openPurchases', open.rows);
  }

  const enriched = await fboSupplyReserveService.enrichItemsWithReserved(
    items.rows.map((r) => ({
      id: r.id,
      productId: r.product_id,
      quantity: r.quantity,
    })),
    { profileId, reserveEnabled: true }
  );
  console.log('enrich single-item call', enriched);

  // Full product queue breakdown (same as list)
  const allKitItems = await query(
    `SELECT si.id, si.product_id, si.quantity, s.id AS supply_id, s.ready_at, s.status
     FROM fbo_supply_items si
     JOIN fbo_supplies s ON s.id = si.fbo_supply_id
     WHERE si.product_id = $1 AND s.status IN ('new','packed','ready_for_supply')
     ORDER BY CASE s.status WHEN 'packed' THEN 0 WHEN 'ready_for_supply' THEN 1 WHEN 'new' THEN 2 ELSE 3 END,
              s.ready_at ASC NULLS LAST, s.id, si.id`,
    [kitId]
  );
  const enrichedAll = await fboSupplyReserveService.enrichItemsWithReserved(
    allKitItems.rows.map((r) => ({
      id: r.id,
      productId: r.product_id,
      quantity: r.quantity,
      supplyId: r.supply_id,
    })),
    { profileId, reserveEnabled: true }
  );
  console.log(
    'enrich all kit lines',
    enrichedAll.map((e) => ({
      id: e.id,
      supplyId: e.supplyId,
      qty: e.quantity,
      stock: e.reservedFromStock,
      path: e.reservedFromIncoming,
      srcOn: e.sourceOnHand,
      srcPath: e.sourceIncoming,
    }))
  );

  // What does getSupply detail use?
  const profileWh = await query(`SELECT fbo_deduction_warehouse_id FROM profiles WHERE id=$1`, [profileId]);
  console.log('profile FBO wh', profileWh.rows[0]);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closePool());
