import { query } from '../../src/config/database.js';

async function main() {
  const products = await query(
    `SELECT id, sku, profile_id, organization_id FROM products WHERE id IN (397,519,520)`
  );
  console.log('PRODUCTS', products.rows);

  const wh = await query(
    `SELECT id, address, organization_id, type, is_fbo_stock FROM warehouses WHERE id IN (5,6)`
  );
  console.log('WAREHOUSES', wh.rows);

  const supplies = await query(
    `SELECT id, profile_id, status, placement_cluster, deduction_warehouse_id, deduct_stock
     FROM fbo_supplies WHERE id IN (197,199,201,202,203,204)`
  );
  console.log('SUPPLIES', supplies.rows);

  // How stock movement passes profile - check recent API path isn't needed;
  // simulate queue with profile from product 520
  const p520 = products.rows.find((r) => String(r.id) === '520');
  const prof = p520?.profile_id;
  console.log('product 520 profile', prof);

  const qWrong = await query(
    `SELECT si.id, s.id AS supply_id, s.profile_id, s.status
     FROM fbo_supply_items si
     JOIN fbo_supplies s ON s.id = si.fbo_supply_id
     WHERE si.product_id = 397
       AND s.profile_id = $1
       AND s.deduction_warehouse_id IS NOT NULL
       AND COALESCE(s.deduct_stock, false) = true
       AND s.status = ANY($2::text[])`,
    [prof, ['new', 'collecting', 'packing', 'ready_for_supply']]
  );
  console.log('QUEUE_KIT_WITH_PRODUCT_PROFILE', qWrong.rows);

  const qNull = await query(
    `SELECT si.id, s.id AS supply_id, s.profile_id, s.status
     FROM fbo_supply_items si
     JOIN fbo_supplies s ON s.id = si.fbo_supply_id
     WHERE si.product_id = 397
       AND s.deduction_warehouse_id IS NOT NULL
       AND COALESCE(s.deduct_stock, false) = true
       AND s.status = ANY($1::text[])`,
    [['new', 'collecting', 'packing', 'ready_for_supply']]
  );
  console.log('QUEUE_KIT_NO_PROFILE_FILTER', qNull.rows);

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
