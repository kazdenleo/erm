/**
 * Probe purchase/product 2214 receipt vs expected
 */
import { query, closePool } from '../../src/config/database.js';

async function main() {
  const products = await query(
    `SELECT id, sku, name, COALESCE(quantity,0)::int AS qty,
            COALESCE(reserved_quantity,0)::int AS reserved,
            COALESCE(incoming_quantity,0)::int AS incoming
     FROM products
     WHERE sku ILIKE '%2214%' OR id = 2214
     ORDER BY sku LIMIT 30`
  );
  console.log('products', products.rows);

  const purchases = await query(
    `SELECT id, status, warehouse_id, supplier_id, created_at, note
     FROM purchases WHERE id = 2214`
  );
  console.log('purchase 2214', purchases.rows);

  // items in purchase 2214
  const items = await query(
    `SELECT pi.id, pi.product_id, p.sku, pi.expected_quantity, pi.received_quantity,
            GREATEST(0, pi.expected_quantity - COALESCE(pi.received_quantity,0)) AS open_qty
     FROM purchase_items pi
     JOIN products p ON p.id = pi.product_id
     WHERE pi.purchase_id = 2214
     ORDER BY p.sku`
  );
  console.log('purchase_items', items.rows);

  // or lines mentioning sku 2214 / product
  const bySku = await query(
    `SELECT pi.purchase_id, p.sku, pi.expected_quantity, pi.received_quantity, pur.status, pur.warehouse_id
     FROM purchase_items pi
     JOIN products p ON p.id = pi.product_id
     JOIN purchases pur ON pur.id = pi.purchase_id
     WHERE p.sku ILIKE '%2214%' OR p.sku ILIKE '%SN-2214%' OR p.sku ILIKE '%TG-2214%'
     ORDER BY pi.purchase_id DESC
     LIMIT 40`
  );
  console.log('lines by sku 2214', bySku.rows);

  const receipts = await query(
    `SELECT r.id, r.purchase_id, r.status, r.warehouse_id, r.created_at, r.completed_at
     FROM purchase_receipts r
     WHERE r.purchase_id = 2214
     ORDER BY r.id DESC`
  );
  console.log('receipts for purchase 2214', receipts.rows);

  if (receipts.rows.length) {
    const rids = receipts.rows.map((r) => r.id);
    const ri = await query(
      `SELECT pri.receipt_id, pri.product_id, p.sku,
              pri.expected_quantity, pri.scanned_quantity, pri.unit_price
       FROM purchase_receipt_items pri
       JOIN products p ON p.id = pri.product_id
       WHERE pri.receipt_id = ANY($1::bigint[])
       ORDER BY pri.receipt_id, p.sku`,
      [rids]
    );
    console.log('receipt_items', ri.rows);
  }

  // recent scanning receipts mentioning products with 2214
  const pids = products.rows.map((p) => p.id);
  if (pids.length) {
    const scan = await query(
      `SELECT r.id AS receipt_id, r.purchase_id, r.status, pri.product_id, p.sku,
              pri.expected_quantity AS draft_expected,
              pri.scanned_quantity,
              pi.expected_quantity AS purchase_expected,
              pi.received_quantity AS purchase_received
       FROM purchase_receipt_items pri
       JOIN purchase_receipts r ON r.id = pri.receipt_id
       JOIN products p ON p.id = pri.product_id
       LEFT JOIN purchase_items pi ON pi.purchase_id = r.purchase_id AND pi.product_id = pri.product_id
       WHERE pri.product_id = ANY($1::bigint[])
       ORDER BY r.id DESC
       LIMIT 30`,
      [pids]
    );
    console.log('recent receipt lines for 2214 products', scan.rows);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closePool());
