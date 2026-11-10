/**
 * Purchase 514 / SN-2214 receipt overscan detail
 */
import { query, closePool } from '../../src/config/database.js';

async function main() {
  const pid = 553; // SN-2214
  const purchaseId = 514;

  const pi = await query(
    `SELECT pi.*, p.sku FROM purchase_items pi JOIN products p ON p.id=pi.product_id
     WHERE pi.purchase_id=$1 AND pi.product_id=$2`,
    [purchaseId, pid]
  );
  console.log('purchase_item', pi.rows[0]);

  const cols = await query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name='purchase_receipts' ORDER BY ordinal_position`
  );
  console.log('receipt cols', cols.rows.map((r) => r.column_name));

  const receipts = await query(
    `SELECT * FROM purchase_receipts WHERE purchase_id=$1 ORDER BY id DESC`,
    [purchaseId]
  );
  console.log(
    'receipts',
    receipts.rows.map((r) => ({
      id: r.id,
      status: r.status,
      created_at: r.created_at,
      completed_at: r.completed_at,
      extras_resolved: r.extras_resolved,
    }))
  );

  for (const r of receipts.rows) {
    const items = await query(
      `SELECT pri.product_id, p.sku, pri.expected_quantity, pri.scanned_quantity, pri.scan_meta
       FROM purchase_receipt_items pri
       JOIN products p ON p.id=pri.product_id
       WHERE pri.receipt_id=$1 AND (pri.product_id=$2 OR p.sku ILIKE '%2214%')`,
      [r.id, pid]
    );
    if (items.rows.length) {
      console.log('receipt', r.id, r.status, items.rows);
    }
  }

  // all receipt items for SN-2214 in scanning
  const scan = await query(
    `SELECT r.id AS receipt_id, r.purchase_id, r.status,
            pri.expected_quantity AS draft_expected,
            pri.scanned_quantity,
            pi.expected_quantity AS purchase_expected,
            pi.received_quantity AS purchase_received
     FROM purchase_receipt_items pri
     JOIN purchase_receipts r ON r.id = pri.receipt_id
     LEFT JOIN purchase_items pi ON pi.purchase_id = r.purchase_id AND pi.product_id = pri.product_id
     WHERE pri.product_id = $1
     ORDER BY r.id DESC
     LIMIT 20`,
    [pid]
  );
  console.log('all SN-2214 receipt lines', scan.rows);

  // cargo places?
  const cargo = await query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema='public' AND table_name ILIKE '%cargo%' OR table_name ILIKE '%наклад%'`
  ).catch(() => ({ rows: [] }));
  console.log(
    'cargo tables',
    (await query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='public' AND (table_name ILIKE '%cargo%' OR table_name ILIKE '%waybill%' OR table_name ILIKE '%invoice%')`
    )).rows
  );

  // purchase cargo if any
  const pc = await query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema='public' AND table_name ILIKE '%purchase%cargo%'`
  );
  console.log('purchase cargo tables', pc.rows);

  if (pc.rows.length) {
    for (const t of pc.rows) {
      const sample = await query(
        `SELECT * FROM ${t.table_name} WHERE purchase_id=$1 LIMIT 5`,
        [purchaseId]
      ).catch((e) => ({ rows: [{ err: e.message }] }));
      console.log(t.table_name, sample.rows);
    }
  }

  // product stock / reserved / FBO reserve for SN-2214
  const stock = await query(
    `SELECT warehouse_id, quantity FROM product_warehouse_stock WHERE product_id=$1 ORDER BY warehouse_id`,
    [pid]
  );
  console.log('wh stock', stock.rows);

  const kit = await query(
    `SELECT k.sku AS kit_sku, kc.quantity
     FROM kit_components kc JOIN products k ON k.id=kc.kit_product_id
     WHERE kc.component_product_id=$1`,
    [pid]
  );
  console.log('in kits', kit.rows);

  // FBO active lines using this kit/product
  const fbo = await query(
    `SELECT s.id, s.status, si.quantity, si.collected_quantity, pr.sku,
            s.external_shipment_number
     FROM fbo_supply_items si
     JOIN fbo_supplies s ON s.id=si.fbo_supply_id
     JOIN products pr ON pr.id=si.product_id
     WHERE s.status IN ('new','packed','ready_for_supply')
       AND (si.product_id=$1 OR si.product_id IN (
         SELECT kit_product_id FROM kit_components WHERE component_product_id=$1
       ))
     ORDER BY s.id`,
    [pid]
  );
  console.log('active FBO', fbo.rows);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closePool());
