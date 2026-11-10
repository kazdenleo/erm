import { writeFileSync } from 'fs';
import { query, closePool } from '../../src/config/database.js';
import fboSupplyReserveService from '../../src/services/fboSupplyReserve.service.js';
import fboSuppliesPurchaseCalcService from '../../src/services/fboSuppliesPurchaseCalc.service.js';

const out = [];
const log = (...args) => {
  const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  out.push(line);
};

const ids = [525, 1270];

try {
  const stock = await query(
    `SELECT product_id, warehouse_id, quantity::int AS qty
     FROM product_warehouse_stock WHERE product_id = ANY($1::bigint[])`,
    [ids]
  );
  log('stock', stock.rows);

  const pending = await query(
    `SELECT pi.product_id, p.id AS purchase_id, p.status, p.warehouse_id,
            pi.expected_quantity, pi.received_quantity,
            GREATEST(0, COALESCE(pi.expected_quantity,0)-COALESCE(pi.received_quantity,0))::int AS pending
     FROM purchase_items pi
     INNER JOIN purchases p ON p.id = pi.purchase_id
     WHERE pi.product_id = ANY($1::bigint[])
       AND GREATEST(0, COALESCE(pi.expected_quantity,0)-COALESCE(pi.received_quantity,0)) > 0
     ORDER BY p.id DESC
     LIMIT 30`,
    [ids]
  );
  log('any pending lines', pending.rows);

  const openPending = await query(
    `SELECT pi.product_id, p.id AS purchase_id, p.warehouse_id,
            GREATEST(0, COALESCE(pi.expected_quantity,0)-COALESCE(pi.received_quantity,0))::int AS pending
     FROM purchase_items pi
     INNER JOIN purchases p ON p.id = pi.purchase_id
     WHERE pi.product_id = ANY($1::bigint[])
       AND p.status = 'open'
       AND GREATEST(0, COALESCE(pi.expected_quantity,0)-COALESCE(pi.received_quantity,0)) > 0`,
    [ids]
  );
  log('open pending', openPending.rows);

  const availEmpty = await fboSupplyReserveService.getAvailableStockAndIncomingForPurchaseCalc(ids, {
    profileId: 6,
    warehouseId: 6,
    excludeSupplyIds: [],
  });
  log('avail empty exclude', Object.fromEntries(availEmpty));

  const sess = await query(
    `SELECT id, supply_ids, updated_at
     FROM fbo_purchase_calc_sessions
     WHERE profile_id = 6 AND status = 'open'
     ORDER BY updated_at DESC
     LIMIT 8`
  );
  log('open sessions', sess.rows.length);

  for (const s of sess.rows) {
    const avail = await fboSupplyReserveService.getAvailableStockAndIncomingForPurchaseCalc(ids, {
      profileId: 6,
      warehouseId: 6,
      excludeSupplyIds: s.supply_ids,
    });
    const calc = await fboSuppliesPurchaseCalcService.calculate(s.supply_ids, { profileId: 6 });
    const rows = calc.rows.filter((r) => ids.includes(Number(r.productId)));
    if (!rows.length) continue;
    log('--- session', { id: s.id, updated: s.updated_at, supplies: s.supply_ids });
    log('avail', Object.fromEntries(avail));
    log(
      'rows',
      rows.map((r) => ({
        sku: r.sku,
        need: r.supplyQtyTotal,
        onHand: r.onHand,
        incoming: r.incoming,
        incomingTotal: r.incomingTotal,
        toPurchase: r.toPurchase,
      }))
    );
  }
} catch (e) {
  log('ERROR', e?.stack || e?.message || String(e));
} finally {
  writeFileSync('scripts/admin/_tmp_probe_session_incoming.out.json', out.join('\n'), 'utf8');
  await closePool();
}
