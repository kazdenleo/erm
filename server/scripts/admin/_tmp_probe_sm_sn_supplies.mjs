import { writeFileSync } from 'fs';
import { query, closePool } from '../../src/config/database.js';
import fboSuppliesPurchaseCalcService from '../../src/services/fboSuppliesPurchaseCalc.service.js';
import fboSupplyReserveService from '../../src/services/fboSupplyReserve.service.js';

const out = [];
const log = (...args) => out.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));

try {
  // Kit products for SM-5005 / SN-2170
  const kits = await query(
    `SELECT kc.kit_product_id, p.sku, kc.component_product_id, kc.quantity AS per_kit, cp.sku AS comp_sku
     FROM kit_components kc
     JOIN products p ON p.id = kc.kit_product_id
     JOIN products cp ON cp.id = kc.component_product_id
     WHERE kc.component_product_id IN (525, 1270)
     ORDER BY kc.component_product_id, kc.kit_product_id`
  );
  log('kits', kits.rows);

  const kitIds = [...new Set(kits.rows.map((r) => Number(r.kit_product_id)))];

  const items = await query(
    `SELECT si.id, si.fbo_supply_id, si.product_id, si.quantity, si.sku,
            s.status, s.external_shipment_number, s.updated_at
     FROM fbo_supply_items si
     JOIN fbo_supplies s ON s.id = si.fbo_supply_id
     WHERE si.product_id = ANY($1::bigint[])
       AND s.status IN ('new', 'ready', 'packed', 'in_transit', 'draft', 'forming')
     ORDER BY s.updated_at DESC NULLS LAST, si.fbo_supply_id DESC
     LIMIT 80`,
    [kitIds]
  );
  log('active kit supply items', items.rows);

  // Aggregate by supply for SM-5005 kits (per_kit=2) and SN-2170 kits
  const bySupply = new Map();
  for (const row of items.rows) {
    const sid = Number(row.fbo_supply_id);
    if (!bySupply.has(sid)) bySupply.set(sid, { supplyId: sid, status: row.status, items: [] });
    bySupply.get(sid).items.push(row);
  }

  // Find set of recent supplies that could yield need ~18 / ~49
  const recentSupplyIds = [...new Set(items.rows.slice(0, 40).map((r) => Number(r.fbo_supply_id)))];
  log('recent supply ids sample', recentSupplyIds);

  // Also look at ALL open/new supplies that include these kits — sum component need
  const needAgg = await query(
    `SELECT si.fbo_supply_id, s.status, s.external_shipment_number,
            SUM(CASE WHEN kc.component_product_id = 1270 THEN si.quantity * kc.quantity ELSE 0 END)::int AS sm5005_need,
            SUM(CASE WHEN kc.component_product_id = 525 THEN si.quantity * kc.quantity ELSE 0 END)::int AS sn2170_need
     FROM fbo_supply_items si
     JOIN fbo_supplies s ON s.id = si.fbo_supply_id
     JOIN kit_components kc ON kc.kit_product_id = si.product_id
       AND kc.component_product_id IN (525, 1270)
     WHERE s.profile_id = 6
       AND COALESCE(s.status, '') NOT IN ('shipped', 'cancelled', 'canceled', 'done', 'completed', 'closed')
     GROUP BY si.fbo_supply_id, s.status, s.external_shipment_number
     HAVING SUM(CASE WHEN kc.component_product_id = 1270 THEN si.quantity * kc.quantity ELSE 0 END) > 0
         OR SUM(CASE WHEN kc.component_product_id = 525 THEN si.quantity * kc.quantity ELSE 0 END) > 0
     ORDER BY si.fbo_supply_id DESC
     LIMIT 40`
  );
  log('need by supply', needAgg.rows);

  const totalNeed = needAgg.rows.reduce(
    (acc, r) => {
      acc.sm += Number(r.sm5005_need) || 0;
      acc.sn += Number(r.sn2170_need) || 0;
      return acc;
    },
    { sm: 0, sn: 0 }
  );
  log('total active need', totalNeed);

  // Try calculate on all supplies that contribute to SM/SN need (active)
  const supplyIds = needAgg.rows.map((r) => Number(r.fbo_supply_id));
  if (supplyIds.length) {
    // Find subset matching screenshot: sm=18, sn=49
    // Brute: take supplies where sm need sum could be 18
    const withSm = needAgg.rows.filter((r) => Number(r.sm5005_need) > 0);
    log('supplies with SM-5005', withSm);

    // Run calculate on ALL active supplies that have these components
    try {
      const calc = await fboSuppliesPurchaseCalcService.calculate(supplyIds, { profileId: 6 });
      const rows = calc.rows.filter((r) => [525, 1270].includes(Number(r.productId)));
      log(
        'calc ALL active',
        rows.map((r) => ({
          sku: r.sku,
          need: r.supplyQtyTotal,
          onHand: r.onHand,
          incoming: r.incoming,
          incomingTotal: r.incomingTotal,
          toPurchase: r.toPurchase,
        }))
      );
    } catch (e) {
      log('calc ALL error', e.message);
    }

    // Find combination with need 18 and 49 — check single supplies and recent groups
    for (const r of needAgg.rows) {
      if (Number(r.sm5005_need) === 18 || Number(r.sn2170_need) === 49) {
        log('exact match supply', r);
      }
    }

    // Maybe screenshot session is a subset — search combinations of top N
    const top = needAgg.rows.slice(0, 15).map((r) => Number(r.fbo_supply_id));
    // Also check draft sessions / any session with these numbers in response
    const sess = await query(
      `SELECT id, supply_ids, status, updated_at
       FROM fbo_purchase_calc_sessions
       WHERE profile_id = 6
       ORDER BY updated_at DESC
       LIMIT 20`
    );
    for (const s of sess.rows) {
      try {
        const calc = await fboSuppliesPurchaseCalcService.calculate(s.supply_ids, { profileId: 6 });
        const rows = calc.rows.filter((r) => [525, 1270].includes(Number(r.productId)));
        const hit = rows.find(
          (r) =>
            (r.sku === 'SM-5005' && Number(r.supplyQtyTotal) === 18) ||
            (r.sku === 'SN-2170' && Number(r.supplyQtyTotal) === 49)
        );
        if (hit || rows.some((r) => Number(r.incoming) > 0)) {
          log('session hit', {
            id: s.id,
            status: s.status,
            supplies: s.supply_ids,
            rows: rows.map((r) => ({
              sku: r.sku,
              need: r.supplyQtyTotal,
              onHand: r.onHand,
              incoming: r.incoming,
              toPurchase: r.toPurchase,
            })),
          });
        }
      } catch {
        /* skip */
      }
    }

    // Direct avail with exclude = all active that have these kits
    const avail = await fboSupplyReserveService.getAvailableStockAndIncomingForPurchaseCalc([525, 1270], {
      profileId: 6,
      warehouseId: 6,
      excludeSupplyIds: supplyIds,
    });
    log('avail exclude all active with kits', Object.fromEntries(avail));

    // Incoming from stock movements (legacy path)
    const mov = await query(
      `SELECT product_id, GREATEST(0, COALESCE(SUM(quantity_change),0))::int AS net
       FROM stock_movements
       WHERE product_id = ANY($1::bigint[])
         AND LOWER(TRIM(type::text)) = 'incoming'
       GROUP BY product_id`,
      [[525, 1270]]
    );
    log('stock_movements incoming net', mov.rows);

    const prodInc = await query(
      `SELECT id, sku, COALESCE(incoming_quantity,0)::int AS inc FROM products WHERE id = ANY($1::bigint[])`,
      [[525, 1270]]
    );
    log('products.incoming_quantity', prodInc.rows);

    // What does getIncomingPoolForFboProduct return?
    // (legacy single) — import via evaluating service internals is hard; approximate:
    log('legacy-like pool would be max(products.inc, movements)');
  }
} catch (e) {
  log('ERROR', e?.stack || e.message);
} finally {
  writeFileSync('scripts/admin/_tmp_probe_sm_sn_supplies.out.json', out.join('\n'), 'utf8');
  await closePool();
}
