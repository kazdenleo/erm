/**
 * Find open FBO lines where hard reserve < qty despite stock.
 */
import { query, closePool } from '../../src/config/database.js';
import { batchIsKitProductIds } from '../../src/services/kitStock.service.js';

const statusR = await query(
  `SELECT status, COUNT(*)::int AS n
   FROM fbo_supplies
   GROUP BY status ORDER BY n DESC`
);
console.log('all supply statuses', statusR.rows);

const OPEN = await query(
  `SELECT s.id AS supply_id, s.status, s.ready_at, s.placement_cluster,
          s.external_shipment_number, s.deduction_warehouse_id, s.profile_id,
          si.id AS item_id, si.product_id, p.sku, p.product_type,
          si.quantity::int AS qty, COALESCE(si.collected_quantity,0)::int AS collected
   FROM fbo_supplies s
   JOIN fbo_supply_items si ON si.fbo_supply_id = s.id
   JOIN products p ON p.id = si.product_id
   WHERE s.stock_deducted_at IS NULL
     AND LOWER(COALESCE(s.status,'')) IN ('new','ready','packing','packed','draft','in_transit','awaiting')
   ORDER BY s.ready_at NULLS LAST, s.id, si.id`
);

console.log('open lines', OPEN.rows.length);
console.log('open statuses', [...new Set(OPEN.rows.map((r) => r.status))]);

const productIds = [...new Set(OPEN.rows.map((r) => Number(r.product_id)))];
const itemIds = OPEN.rows.map((r) => Number(r.item_id));

const nets = await query(
  `SELECT (sm.meta->>'fbo_supply_item_id')::bigint AS item_id,
          sm.product_id,
          COALESCE(SUM(sm.quantity_change),0)::int AS net
   FROM stock_movements sm
   WHERE sm.type IN ('reserve','unreserve')
     AND (sm.meta->>'fbo_supply_item_id')::bigint = ANY($1::bigint[])
   GROUP BY 1, 2`,
  [itemIds]
);
const netByItem = new Map();
for (const r of nets.rows) {
  const k = String(r.item_id);
  if (!netByItem.has(k)) netByItem.set(k, []);
  netByItem.get(k).push({ productId: Number(r.product_id), net: Number(r.net) });
}

const kitFlags = await batchIsKitProductIds(productIds);
const kitIds = productIds.filter((id) => kitFlags.get(id) === true);
const compsR = kitIds.length
  ? await query(
      `SELECT kit_product_id, component_product_id, quantity
       FROM kit_components WHERE kit_product_id = ANY($1::bigint[])`,
      [kitIds]
    )
  : { rows: [] };
const kitComps = new Map();
for (const c of compsR.rows) {
  const kid = Number(c.kit_product_id);
  if (!kitComps.has(kid)) kitComps.set(kid, []);
  kitComps.get(kid).push({
    component_product_id: Number(c.component_product_id),
    quantity: Number(c.quantity),
  });
}

function reservedKitsForItem(itemId, kitProductId) {
  const comps = kitComps.get(kitProductId) || [];
  if (!comps.length) return 0;
  const nets = netByItem.get(String(itemId)) || [];
  let minKits = Infinity;
  for (const c of comps) {
    const n = nets.find((x) => x.productId === c.component_product_id);
    const reservedComp = n ? Math.max(0, -n.net) : 0;
    const per = Math.max(1, Number(c.quantity) || 1);
    minKits = Math.min(minKits, Math.floor(reservedComp / per));
  }
  return minKits === Infinity ? 0 : minKits;
}

function reservedDirectForItem(itemId, productId) {
  const nets = netByItem.get(String(itemId)) || [];
  const n = nets.find((x) => x.productId === productId);
  return n ? Math.max(0, -n.net) : 0;
}

const whIds = [...new Set(OPEN.rows.map((r) => Number(r.deduction_warehouse_id) || 6).filter(Boolean))];
const allPids = new Set(productIds);
for (const comps of kitComps.values()) {
  for (const c of comps) allPids.add(Number(c.component_product_id));
}
const stockPids = [...allPids];

const pws = await query(
  `SELECT product_id, warehouse_id, COALESCE(quantity,0)::int AS qty
   FROM product_warehouse_stock
   WHERE product_id = ANY($1::bigint[]) AND warehouse_id = ANY($2::bigint[])`,
  [stockPids, whIds.length ? whIds : [6]]
);
const onHand = new Map();
for (const r of pws.rows) onHand.set(`${r.product_id}:${r.warehouse_id}`, Number(r.qty));

const prod = await query(
  `SELECT id, sku, COALESCE(quantity,0)::int AS qty, COALESCE(reserved_quantity,0)::int AS reserved
   FROM products WHERE id = ANY($1::bigint[])`,
  [stockPids]
);
const prodMap = new Map(prod.rows.map((r) => [Number(r.id), r]));

const gaps = [];
for (const row of OPEN.rows) {
  const pid = Number(row.product_id);
  const wh = Number(row.deduction_warehouse_id) || 6;
  const qty = Number(row.qty) || 0;
  const isKit = kitFlags.get(pid) === true;
  const reserved = isKit
    ? reservedKitsForItem(row.item_id, pid)
    : reservedDirectForItem(row.item_id, pid);
  const short = Math.max(0, qty - reserved);
  if (short <= 0) continue;

  let freeHint = 0;
  let onHandWh = null;
  if (isKit) {
    const comps = kitComps.get(pid) || [];
    let kitsFree = Infinity;
    for (const c of comps) {
      const cid = Number(c.component_product_id);
      const cp = prodMap.get(cid);
      const freeC = cp ? Math.max(0, Number(cp.qty) - Number(cp.reserved)) : 0;
      const per = Math.max(1, Number(c.quantity) || 1);
      kitsFree = Math.min(kitsFree, Math.floor(freeC / per));
      onHandWh = onHand.get(`${cid}:${wh}`) || 0;
    }
    freeHint = kitsFree === Infinity ? 0 : kitsFree;
  } else {
    const p = prodMap.get(pid);
    freeHint = p ? Math.max(0, Number(p.qty) - Number(p.reserved)) : 0;
    onHandWh = onHand.get(`${pid}:${wh}`) || 0;
  }

  gaps.push({
    supply_id: Number(row.supply_id),
    cluster: row.placement_cluster,
    shipment: row.external_shipment_number,
    status: row.status,
    item_id: Number(row.item_id),
    sku: row.sku,
    product_id: pid,
    isKit,
    qty,
    reserved,
    short,
    freeGlobal: freeHint,
    onHandWh,
    profile_id: Number(row.profile_id),
  });
}

gaps.sort((a, b) => b.short - a.short || a.supply_id - b.supply_id);
console.log('\n=== GAPS reserved<qty ===', gaps.length);
console.log('of which freeGlobal>0', gaps.filter((g) => g.freeGlobal > 0).length);
console.log('of which onHandWh>reserved (simple products)', gaps.filter((g) => !g.isKit && g.onHandWh > g.reserved).length);

console.log('\n=== sample gaps (up to 60) ===');
console.log(JSON.stringify(gaps.slice(0, 60), null, 2));

const bySupply = new Map();
for (const g of gaps) {
  if (!bySupply.has(g.supply_id)) {
    bySupply.set(g.supply_id, {
      supply_id: g.supply_id,
      cluster: g.cluster,
      shipment: g.shipment,
      lines: 0,
      shortUnits: 0,
      withFree: 0,
      skus: [],
    });
  }
  const s = bySupply.get(g.supply_id);
  s.lines += 1;
  s.shortUnits += g.short;
  if (g.freeGlobal > 0 || (!g.isKit && g.onHandWh > g.reserved)) s.withFree += 1;
  if (s.skus.length < 10) s.skus.push(`${g.sku}:${g.reserved}/${g.qty}`);
}
console.log('\n=== by supply ===');
console.log(
  JSON.stringify(
    [...bySupply.values()].sort((a, b) => b.shortUnits - a.shortUnits),
    null,
    2
  )
);

await closePool();
