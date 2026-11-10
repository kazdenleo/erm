import { writeFileSync } from 'fs';
import { query, closePool } from '../../src/config/database.js';
import { batchGetReservedKitUnitsForFboItems } from '../../src/services/kitStock.service.js';

const out = [];
const log = (...a) => out.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));

try {
  const p514 = await query(
    `SELECT p.id, p.status, p.warehouse_id, p.created_at,
            pi.product_id, pr.sku, pi.expected_quantity, pi.received_quantity,
            GREATEST(0, COALESCE(pi.expected_quantity,0)-COALESCE(pi.received_quantity,0))::int AS pending
     FROM purchases p
     JOIN purchase_items pi ON pi.purchase_id = p.id
     JOIN products pr ON pr.id = pi.product_id
     WHERE p.id = 514`
  );
  log('purchase 514', p514.rows);

  const sn2171 = await query(`SELECT id, sku FROM products WHERE sku IN ('SN-2171','SN-2170','SM-5005')`);
  log('skus', sn2171.rows);
  const sn2171Id = Number(sn2171.rows.find((r) => r.sku === 'SN-2171')?.id);

  const pendingAll = await query(
    `SELECT pi.product_id, pr.sku,
            COALESCE(SUM(GREATEST(0, COALESCE(pi.expected_quantity,0)-COALESCE(pi.received_quantity,0))),0)::int AS pending
     FROM purchase_items pi
     JOIN purchases p ON p.id = pi.purchase_id
     JOIN products pr ON pr.id = pi.product_id
     WHERE p.status='open' AND p.warehouse_id=6
       AND pi.product_id IN (525,1270,401,1269${sn2171Id ? `,${sn2171Id}` : ''})
     GROUP BY pi.product_id, pr.sku`
  );
  log('pending pools', pendingAll.rows);

  const queue = await query(
    `SELECT si.id AS supply_item_id, si.fbo_supply_id, si.product_id, p.sku, si.quantity,
            s.status, s.ready_at
     FROM fbo_supply_items si
     JOIN fbo_supplies s ON s.id = si.fbo_supply_id
     JOIN products p ON p.id = si.product_id
     WHERE si.product_id IN (401, 1269)
       AND s.profile_id = 6
       AND s.status IN ('new','ready','ready_for_supply','packed','forming','in_transit','draft')
     ORDER BY si.fbo_supply_id, si.id`
  );
  log('queue', queue.rows);

  const kitEntries = queue.rows.map((r) => ({
    kitProductId: Number(r.product_id),
    fboSupplyItemId: Number(r.supply_item_id),
    lineQty: Number(r.quantity) || 0,
  }));
  const kitReservedByItem = await batchGetReservedKitUnitsForFboItems(kitEntries);
  log('kitReservedByItem', Object.fromEntries([...kitReservedByItem.entries()].map(([k, v]) => [String(k), v])));

  const comps = await query(
    `SELECT kit_product_id, component_product_id, quantity, pr.sku
     FROM kit_components kc
     JOIN products pr ON pr.id = kc.component_product_id
     WHERE kit_product_id IN (401,1269)`
  );
  log('comps', comps.rows);
  const kitComps = new Map();
  for (const c of comps.rows) {
    const kid = Number(c.kit_product_id);
    if (!kitComps.has(kid)) kitComps.set(kid, []);
    kitComps.get(kid).push({
      component_product_id: Number(c.component_product_id),
      quantity: Number(c.quantity),
      sku: c.sku,
    });
  }

  function assemblable(components, poolsMap) {
    let min = Infinity;
    for (const c of components) {
      const per = Math.max(1, c.quantity);
      const have = Math.max(0, poolsMap.get(c.component_product_id) || 0);
      min = Math.min(min, Math.floor(have / per));
    }
    return Number.isFinite(min) ? min : 0;
  }

  function simulate(excludeList, label, mode) {
    const exclude = new Set(excludeList.map(Number));
    const pools = new Map();
    for (const r of pendingAll.rows) pools.set(Number(r.product_id), Number(r.pending) || 0);

    const ranked = [...queue.rows].sort((a, b) => {
      const rank = (st) => {
        if (st === 'packed') return 0;
        if (st === 'ready_for_supply') return 1;
        if (st === 'new') return 2;
        return 3;
      };
      const ra = rank(a.status);
      const rb = rank(b.status);
      if (ra !== rb) return ra - rb;
      const ta = a.ready_at ? new Date(a.ready_at).getTime() : Infinity;
      const tb = b.ready_at ? new Date(b.ready_at).getTime() : Infinity;
      if (ta !== tb) return ta - tb;
      return Number(a.fbo_supply_id) - Number(b.fbo_supply_id) || Number(a.supply_item_id) - Number(b.supply_item_id);
    });

    const steps = [];
    for (const row of ranked) {
      if (exclude.has(Number(row.fbo_supply_id))) continue;
      const pid = Number(row.product_id);
      const qty = Number(row.quantity) || 0;
      const itemId = String(row.supply_item_id);
      const reservedKits = Number(kitReservedByItem.get(itemId) || 0);
      const gap = Math.max(0, qty - reservedKits);
      if (gap <= 0) {
        steps.push({ supply: row.fbo_supply_id, sku: row.sku, qty, reservedKits, gap: 0 });
        continue;
      }
      const components = kitComps.get(pid) || [];
      const direct = pools.get(pid) || 0;
      const fromDirect = Math.min(gap, direct);
      if (fromDirect > 0) pools.set(pid, direct - fromDirect);
      const still = gap - fromDirect;
      let tookComps = 0;
      if (still > 0 && components.length) {
        if (mode === 'assemblable') {
          const can = assemblable(components, pools);
          tookComps = Math.min(still, can);
          for (const c of components) {
            pools.set(
              c.component_product_id,
              Math.max(0, (pools.get(c.component_product_id) || 0) - tookComps * c.quantity)
            );
          }
        } else {
          // claim each component independently for kit gap
          tookComps = still;
          for (const c of components) {
            const need = still * Math.max(1, c.quantity);
            const have = pools.get(c.component_product_id) || 0;
            const take = Math.min(need, have);
            pools.set(c.component_product_id, Math.max(0, have - take));
          }
        }
      }
      steps.push({
        supply: row.fbo_supply_id,
        sku: row.sku,
        qty,
        reservedKits,
        gap,
        fromDirect,
        tookComps,
        sn2170: pools.get(525) || 0,
        sm5005: pools.get(1270) || 0,
        sn2171: sn2171Id ? pools.get(sn2171Id) || 0 : null,
      });
    }
    log(label, {
      final: {
        sn2170: pools.get(525) || 0,
        sm5005: pools.get(1270) || 0,
        sn2171: sn2171Id ? pools.get(sn2171Id) || 0 : null,
      },
      steps,
    });
  }

  simulate([], 'current assemblable exclude none', 'assemblable');
  simulate([206], 'current assemblable exclude 206', 'assemblable');
  simulate([206], 'fixed per-component exclude 206', 'per-component');
  simulate([], 'fixed per-component exclude none', 'per-component');
} catch (e) {
  log('ERROR', e?.stack || e.message);
} finally {
  writeFileSync('/tmp/_tmp_probe_prod_deplete.out.json', out.join('\n'), 'utf8');
  console.log(out.join('\n'));
  await closePool();
}
