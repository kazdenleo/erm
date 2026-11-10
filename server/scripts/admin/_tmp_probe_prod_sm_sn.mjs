import { writeFileSync } from 'fs';
import { query, closePool } from '../../src/config/database.js';
import fboSupplyReserveService from '../../src/services/fboSupplyReserve.service.js';
import fboSuppliesPurchaseCalcService from '../../src/services/fboSuppliesPurchaseCalc.service.js';

const out = [];
const log = (...a) => out.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
const ids = [525, 1270];

try {
  const pending = await query(
    `SELECT pi.product_id, pr.sku, p.id AS purchase_id, p.warehouse_id, p.status,
            GREATEST(0, COALESCE(pi.expected_quantity,0)-COALESCE(pi.received_quantity,0))::int AS pending
     FROM purchase_items pi
     JOIN purchases p ON p.id = pi.purchase_id
     JOIN products pr ON pr.id = pi.product_id
     WHERE pi.product_id = ANY($1::bigint[])
       AND GREATEST(0, COALESCE(pi.expected_quantity,0)-COALESCE(pi.received_quantity,0)) > 0
     ORDER BY p.id DESC LIMIT 40`,
    [ids]
  );
  log('any pending', pending.rows);

  const openPending = await query(
    `SELECT pi.product_id, pr.sku, p.id AS purchase_id, p.warehouse_id,
            GREATEST(0, COALESCE(pi.expected_quantity,0)-COALESCE(pi.received_quantity,0))::int AS pending
     FROM purchase_items pi
     JOIN purchases p ON p.id = pi.purchase_id
     JOIN products pr ON pr.id = pi.product_id
     WHERE pi.product_id = ANY($1::bigint[]) AND p.status = 'open'
       AND GREATEST(0, COALESCE(pi.expected_quantity,0)-COALESCE(pi.received_quantity,0)) > 0`,
    [ids]
  );
  log('open pending', openPending.rows);

  const stock = await query(
    `SELECT product_id, warehouse_id, quantity::int AS qty
     FROM product_warehouse_stock WHERE product_id = ANY($1::bigint[])`,
    [ids]
  );
  log('stock', stock.rows);

  const sess = await query(
    `SELECT id, status, supply_ids, updated_at
     FROM fbo_purchase_calc_sessions
     WHERE profile_id = 6
     ORDER BY updated_at DESC LIMIT 10`
  );
  log('sessions', sess.rows.map((s) => ({ id: s.id, status: s.status, n: s.supply_ids?.length, updated: s.updated_at })));

  for (const s of sess.rows.slice(0, 5)) {
    try {
      const avail = await fboSupplyReserveService.getAvailableStockAndIncomingForPurchaseCalc(ids, {
        profileId: 6,
        warehouseId: 6,
        excludeSupplyIds: s.supply_ids,
      });
      const calc = await fboSuppliesPurchaseCalcService.calculate(s.supply_ids, { profileId: 6 });
      const rows = calc.rows.filter((r) => ids.includes(Number(r.productId)));
      if (!rows.length) continue;
      log('sess', s.id, Object.fromEntries(avail), rows.map((r) => ({
        sku: r.sku,
        need: r.supplyQtyTotal,
        onHand: r.onHand,
        incoming: r.incoming,
        incomingTotal: r.incomingTotal,
        toPurchase: r.toPurchase,
      })));
    } catch (e) {
      log('sess err', s.id, e.message);
    }
  }

  // Find any supply set with sm~18 sn~49 via items of kits
  const kitItems = await query(
    `SELECT si.fbo_supply_id, si.product_id, si.quantity, p.sku, s.status
     FROM fbo_supply_items si
     JOIN fbo_supplies s ON s.id = si.fbo_supply_id
     JOIN products p ON p.id = si.product_id
     WHERE si.product_id IN (401, 1269) AND s.profile_id = 6
       AND s.status IN ('new','ready','ready_for_supply','packed','forming','draft','in_transit')
     ORDER BY si.fbo_supply_id DESC`
  );
  log('active kit items', kitItems.rows);

  const avail0 = await fboSupplyReserveService.getAvailableStockAndIncomingForPurchaseCalc(ids, {
    profileId: 6,
    warehouseId: 6,
    excludeSupplyIds: [],
  });
  log('avail0', Object.fromEntries(avail0));
} catch (e) {
  log('ERROR', e?.stack || e.message);
} finally {
  writeFileSync('/tmp/_tmp_probe_prod_sm_sn.out.json', out.join('\n'), 'utf8');
  console.log(out.join('\n'));
  await closePool();
}
