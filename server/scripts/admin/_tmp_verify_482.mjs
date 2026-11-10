import { query, closePool } from '../../src/config/database.js';

const items = await query(`
  SELECT i.id, i.product_id, p.sku, i.scanned_quantity, i.expected_quantity, i.unit_price
  FROM purchase_receipt_items i
  LEFT JOIN products p ON p.id = i.product_id
  WHERE i.receipt_id = 482
  ORDER BY i.id
`);
console.log('receipt 482 items', JSON.stringify(items.rows, null, 2));

const tables = await query(`
  SELECT table_name FROM information_schema.tables
  WHERE table_schema='public' AND table_name ILIKE '%receipt%'
  ORDER BY table_name
`);
console.log('receipt tables', tables.rows.map((r) => r.table_name).join(', '));

const lines = await query(`
  SELECT table_name FROM information_schema.tables
  WHERE table_schema='public' AND (
    table_name ILIKE '%warehouse%item%' OR table_name ILIKE '%stock_movement%' OR table_name ILIKE '%document_line%'
  )
  ORDER BY table_name
`);
console.log('stock tables', lines.rows.map((r) => r.table_name).join(', '));

const wrLines = await query(`
  SELECT column_name FROM information_schema.columns
  WHERE table_name = 'warehouse_receipt_lines' OR table_name = 'warehouse_document_items'
     OR table_name = 'warehouse_items'
  ORDER BY table_name, ordinal_position
`);
console.log('possible line cols', JSON.stringify(wrLines.rows, null, 2));

// movements linked to receipt
const mov = await query(`
  SELECT id, product_id, quantity, warehouse_id, type, created_at, meta
  FROM stock_movements
  WHERE meta->>'purchase_receipt_id' = '482'
     OR meta->>'warehouse_receipt_id' = '779'
     OR (meta::text ILIKE '%482%' AND created_at > NOW() - INTERVAL '2 hours')
  ORDER BY id DESC
  LIMIT 30
`).catch(async (e) => {
  console.log('mov err', e.message);
  // try alternate schema
  const cols = await query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'stock_movements' ORDER BY ordinal_position
  `);
  console.log('stock_movements cols', cols.rows.map((r) => r.column_name).join(', '));
  return { rows: [] };
});
console.log('movements', JSON.stringify(mov.rows, null, 2));

const sn = await query(`
  SELECT id, sku,
         COALESCE(quantity,0)::int AS qty,
         COALESCE(reserved_quantity,0)::int AS reserved,
         COALESCE(incoming_quantity,0)::int AS incoming
  FROM products
  WHERE sku ILIKE '%SN-2214%' OR sku ILIKE '%SN2214%'
  ORDER BY sku
`);
console.log('SN-2214', JSON.stringify(sn.rows, null, 2));

const purchaseItems = await query(`
  SELECT pi.id, p.sku, pi.quantity, pi.received_quantity, pi.incoming_quantity
  FROM purchase_items pi
  LEFT JOIN products p ON p.id = pi.product_id
  WHERE pi.purchase_id = 514
  ORDER BY p.sku
`);
console.log('purchase 514 items', JSON.stringify(purchaseItems.rows, null, 2));

const open = await query(`
  SELECT id, purchase_id, status, started_at, completed_at
  FROM purchase_receipts
  WHERE status IS DISTINCT FROM 'completed' AND cancelled_at IS NULL
  ORDER BY id DESC LIMIT 10
`);
console.log('open receipts', JSON.stringify(open.rows, null, 2));

await closePool();
