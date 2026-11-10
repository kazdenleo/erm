import { query, closePool } from '../../src/config/database.js';
import fboSupplyReserveService from '../../src/services/fboSupplyReserve.service.js';

const OPEN = await query(
  `SELECT s.id AS supply_id, s.placement_cluster, s.external_shipment_number,
          s.deduction_warehouse_id, si.id AS item_id, si.product_id, p.sku,
          si.quantity::int AS qty
   FROM fbo_supplies s
   JOIN fbo_supply_items si ON si.fbo_supply_id = s.id
   JOIN products p ON p.id = si.product_id
   WHERE s.status = 'new' AND s.stock_deducted_at IS NULL
   ORDER BY s.id, si.id`
);

const items = OPEN.rows.map((r) => ({
  id: r.item_id,
  productId: r.product_id,
  quantity: r.qty,
  fboSupplyId: r.supply_id,
  _sku: r.sku,
  _cluster: r.placement_cluster,
  _shipment: r.external_shipment_number,
  _wh: r.deduction_warehouse_id,
}));

const enriched = await fboSupplyReserveService.enrichItemsWithReserved(items, { profileId: 6 });

const gaps = [];
for (let i = 0; i < enriched.length; i++) {
  const e = enriched[i];
  const raw = items[i];
  const qty = Number(e.quantity) || 0;
  const fromStock = Number(e.reservedFromStock) || 0;
  const short = Math.max(0, qty - fromStock);
  if (short <= 0) continue;
  gaps.push({
    supply_id: raw.fboSupplyId,
    cluster: raw._cluster,
    shipment: raw._shipment,
    sku: raw._sku,
    item_id: raw.id,
    qty,
    reservedFromStock: fromStock,
    reservedFromIncoming: Number(e.reservedFromIncoming) || 0,
    short,
    sourceOnHand: e.sourceOnHand,
  });
}

console.log('open lines', items.length, 'hard-reserve gaps', gaps.length);
console.log(JSON.stringify(gaps, null, 2));

// For each gap SKU, show component free on FBO vs FBS
const skus = [...new Set(gaps.map((g) => g.sku))];
for (const sku of skus) {
  const p = await query(`SELECT id, sku, product_type FROM products WHERE sku=$1`, [sku]);
  const row = p.rows[0];
  if (!row) continue;
  const pid = Number(row.id);
  if (row.product_type === 'kit') {
    const comps = await query(
      `SELECT c.sku, kc.quantity AS per,
              COALESCE(c.quantity,0)::int AS qty, COALESCE(c.reserved_quantity,0)::int AS reserved,
              COALESCE((SELECT quantity FROM product_warehouse_stock WHERE product_id=c.id AND warehouse_id=6),0)::int AS fbo,
              COALESCE((SELECT quantity FROM product_warehouse_stock WHERE product_id=c.id AND warehouse_id=5),0)::int AS fbs,
              GREATEST(0, -(SELECT COALESCE(SUM(quantity_change),0) FROM stock_movements
                 WHERE product_id=c.id AND warehouse_id=6 AND type IN ('reserve','unreserve')))::int AS fbo_reserved
       FROM kit_components kc
       JOIN products c ON c.id = kc.component_product_id
       WHERE kc.kit_product_id=$1`,
      [pid]
    );
    console.log('\nKIT', sku, comps.rows.map((c) => ({
      sku: c.sku,
      per: c.per,
      fbo: c.fbo,
      fbo_reserved: c.fbo_reserved,
      fbo_free: c.fbo - c.fbo_reserved,
      fbs: c.fbs,
      freeGlobal: c.qty - c.reserved,
    })));
  } else {
    const st = await query(
      `SELECT
         COALESCE((SELECT quantity FROM product_warehouse_stock WHERE product_id=$1 AND warehouse_id=6),0)::int AS fbo,
         COALESCE((SELECT quantity FROM product_warehouse_stock WHERE product_id=$1 AND warehouse_id=5),0)::int AS fbs,
         GREATEST(0, -(SELECT COALESCE(SUM(quantity_change),0) FROM stock_movements
            WHERE product_id=$1 AND warehouse_id=6 AND type IN ('reserve','unreserve')))::int AS fbo_reserved,
         COALESCE(quantity,0)::int AS qty, COALESCE(reserved_quantity,0)::int AS reserved
       FROM products WHERE id=$1`,
      [pid]
    );
    const c = st.rows[0];
    console.log('\nPRODUCT', sku, {
      fbo: c.fbo,
      fbo_reserved: c.fbo_reserved,
      fbo_free: c.fbo - c.fbo_reserved,
      fbs: c.fbs,
      freeGlobal: c.qty - c.reserved,
    });
  }
}

await closePool();
