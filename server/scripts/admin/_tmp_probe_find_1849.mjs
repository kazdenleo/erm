import { writeFileSync } from 'fs';
import { query, closePool } from '../../src/config/database.js';
import fboSuppliesPurchaseCalcService from '../../src/services/fboSuppliesPurchaseCalc.service.js';

const out = [];
const log = (...args) => out.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));

try {
  const statuses = await query(
    `SELECT status, COUNT(*)::int AS n FROM fbo_supplies WHERE profile_id=6 GROUP BY status ORDER BY n DESC`
  );
  log('statuses', statuses.rows);

  // All supplies with these kits regardless of status
  const all = await query(
    `SELECT si.fbo_supply_id, s.status, s.external_shipment_number, s.updated_at,
            SUM(CASE WHEN kc.component_product_id = 1270 THEN si.quantity * kc.quantity ELSE 0 END)::int AS sm5005_need,
            SUM(CASE WHEN kc.component_product_id = 525 THEN si.quantity * kc.quantity ELSE 0 END)::int AS sn2170_need
     FROM fbo_supply_items si
     JOIN fbo_supplies s ON s.id = si.fbo_supply_id
     JOIN kit_components kc ON kc.kit_product_id = si.product_id
       AND kc.component_product_id IN (525, 1270)
     WHERE s.profile_id = 6
     GROUP BY si.fbo_supply_id, s.status, s.external_shipment_number, s.updated_at
     HAVING SUM(CASE WHEN kc.component_product_id = 1270 THEN si.quantity * kc.quantity ELSE 0 END) > 0
         OR SUM(CASE WHEN kc.component_product_id = 525 THEN si.quantity * kc.quantity ELSE 0 END) > 0
     ORDER BY s.updated_at DESC NULLS LAST
     LIMIT 80`
  );
  log('recent with kits', all.rows);

  // Sessions that might match - check ALL sessions including closed
  const sess = await query(
    `SELECT id, status, supply_ids, updated_at
     FROM fbo_purchase_calc_sessions
     WHERE profile_id = 6
     ORDER BY updated_at DESC
     LIMIT 30`
  );

  for (const s of sess.rows) {
    try {
      const calc = await fboSuppliesPurchaseCalcService.calculate(s.supply_ids, { profileId: 6 });
      const rows = calc.rows.filter((r) => [525, 1270, 401, 1269].includes(Number(r.productId)) || ['SM-5005','SN-2170','DT-SM-5005-X2','DTSN2170-71RL'].includes(r.sku));
      const sm = rows.find((r) => r.sku === 'SM-5005');
      const sn = rows.find((r) => r.sku === 'SN-2170');
      if (
        (sm && (Number(sm.supplyQtyTotal) === 18 || Number(sm.incoming) > 0)) ||
        (sn && (Number(sn.supplyQtyTotal) === 49 || Number(sn.incoming) > 0))
      ) {
        log('MATCH session', {
          id: s.id,
          status: s.status,
          updated: s.updated_at,
          supplies: s.supply_ids,
          sm: sm && {
            need: sm.supplyQtyTotal,
            onHand: sm.onHand,
            incoming: sm.incoming,
            incomingTotal: sm.incomingTotal,
            toPurchase: sm.toPurchase,
          },
          sn: sn && {
            need: sn.supplyQtyTotal,
            onHand: sn.onHand,
            incoming: sn.incoming,
            incomingTotal: sn.incomingTotal,
            toPurchase: sn.toPurchase,
          },
        });
      }
    } catch (e) {
      /* skip missing supplies */
    }
  }

  // Also: open purchases ANY warehouse for these + parent kits
  const purchases = await query(
    `SELECT p.id, p.status, p.warehouse_id, pi.product_id, pr.sku,
            pi.expected_quantity, pi.received_quantity,
            GREATEST(0, COALESCE(pi.expected_quantity,0)-COALESCE(pi.received_quantity,0))::int AS pending
     FROM purchase_items pi
     JOIN purchases p ON p.id = pi.purchase_id
     JOIN products pr ON pr.id = pi.product_id
     WHERE pi.product_id IN (525, 1270, 401, 1269)
       AND p.status = 'open'
     ORDER BY p.id DESC`
  );
  log('open purchases kits+comps', purchases.rows);

  // Reserves on components and kits at wh 6
  const reserves = await query(
    `SELECT sm.product_id, pr.sku,
            GREATEST(0, COALESCE(SUM(
              CASE WHEN sm.type='reserve' THEN ABS(sm.quantity_change)
                   WHEN sm.type='unreserve' THEN -ABS(sm.quantity_change)
                   ELSE 0 END
            ),0))::int AS net_reserved,
            COUNT(*)::int AS moves
     FROM stock_movements sm
     JOIN products pr ON pr.id = sm.product_id
     WHERE sm.product_id IN (525, 1270, 401, 1269)
       AND sm.warehouse_id = 6
       AND sm.type IN ('reserve','unreserve')
     GROUP BY sm.product_id, pr.sku`
  );
  log('reserves wh6', reserves.rows);

  // Queue for kits 401, 1269
  const queue = await query(
    `SELECT si.id, si.fbo_supply_id, si.product_id, si.quantity, s.status, s.ready_at, s.external_shipment_number
     FROM fbo_supply_items si
     JOIN fbo_supplies s ON s.id = si.fbo_supply_id
     WHERE si.product_id IN (401, 1269)
       AND s.profile_id = 6
       AND s.status IN ('new','ready','ready_for_supply','packed','in_transit','forming','draft')
     ORDER BY s.status, s.ready_at NULLS LAST, si.fbo_supply_id`
  );
  log('kit queue', queue.rows);
} catch (e) {
  log('ERROR', e?.stack || e.message);
} finally {
  writeFileSync('scripts/admin/_tmp_probe_find_1849.out.json', out.join('\n'), 'utf8');
  await closePool();
}
