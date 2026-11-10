import { query, closePool } from '../../src/config/database.js';

async function main() {
  const cargoItems = await query(
    `SELECT cpi.cargo_place_id, cp.barcode, cp.status, cpi.product_id, p.sku, cpi.quantity
     FROM purchase_cargo_place_items cpi
     JOIN purchase_cargo_places cp ON cp.id = cpi.cargo_place_id
     JOIN products p ON p.id = cpi.product_id
     WHERE cp.purchase_id = 514 AND (p.sku ILIKE '%2214%' OR cpi.product_id = 553)
     ORDER BY cp.id`
  );
  console.log('cargo SN-2214', cargoItems.rows);
  const sum = await query(
    `SELECT COALESCE(SUM(cpi.quantity),0)::int AS qty
     FROM purchase_cargo_place_items cpi
     JOIN purchase_cargo_places cp ON cp.id = cpi.cargo_place_id
     WHERE cp.purchase_id = 514 AND cpi.product_id = 553`
  );
  console.log('cargo sum SN-2214', sum.rows[0]);

  const allSum = await query(
    `SELECT p.sku, SUM(cpi.quantity)::int AS qty
     FROM purchase_cargo_place_items cpi
     JOIN purchase_cargo_places cp ON cp.id = cpi.cargo_place_id
     JOIN products p ON p.id = cpi.product_id
     WHERE cp.purchase_id = 514
     GROUP BY p.sku
     HAVING SUM(cpi.quantity) > 0
     ORDER BY qty DESC
     LIMIT 20`
  );
  console.log('top cargo by sku', allSum.rows);

  // how receiptItemExpectedQty works - remaining = expected - received = 37-15=22
  console.log('remaining needed', 37 - 15);
  console.log('scanned now', 60, 'overscan', 60 - 22);
}

main().catch(console.error).finally(() => closePool());
