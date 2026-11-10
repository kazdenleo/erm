import { query, closePool } from '../../src/config/database.js';

const cols = await query(`
  SELECT column_name FROM information_schema.columns
  WHERE table_name = 'purchase_receipts' ORDER BY ordinal_position
`);
console.log('cols', cols.rows.map((r) => r.column_name).join(', '));

const r = await query(`SELECT * FROM purchase_receipts WHERE id = 482`);
console.log('receipt', JSON.stringify(r.rows, null, 2));

const items = await query(`
  SELECT i.id, i.product_id, p.sku, i.expected_quantity, i.received_quantity, i.purchase_item_id
  FROM purchase_receipt_items i
  LEFT JOIN products p ON p.id = i.product_id
  WHERE i.receipt_id = 482
  ORDER BY i.id
`);
console.log('items count', items.rows.length);
console.log('items', JSON.stringify(items.rows.slice(0, 30), null, 2));
const over = items.rows.filter((x) => Number(x.received_quantity) > Number(x.expected_quantity));
const under = items.rows.filter((x) => Number(x.received_quantity) < Number(x.expected_quantity));
console.log('overscan', over.length, 'underscan', under.length);
console.log('over sample', JSON.stringify(over.slice(0, 10), null, 2));

const purchase = await query(`
  SELECT id, status, number, supplier_id FROM purchases WHERE id = (
    SELECT purchase_id FROM purchase_receipts WHERE id = 482
  )
`);
console.log('purchase', JSON.stringify(purchase.rows, null, 2));

await closePool();
