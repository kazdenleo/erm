import { query, closePool } from '../../src/config/database.js';

const mov = await query(`
  SELECT id, product_id, type, reason, quantity_change, balance_after, warehouse_id, created_at, meta
  FROM stock_movements
  WHERE meta->>'purchase_receipt_id' = '482'
     OR meta->>'warehouse_receipt_id' = '779'
  ORDER BY id
`);
console.log('movements 482/779', JSON.stringify(mov.rows, null, 2));

const lines = await query(`
  SELECT l.*, p.sku FROM warehouse_receipt_lines l
  LEFT JOIN products p ON p.id = l.product_id
  WHERE l.receipt_id = 779
`);
console.log('wh lines', JSON.stringify(lines.rows, null, 2));

const piCols = await query(`
  SELECT column_name FROM information_schema.columns
  WHERE table_name = 'purchase_items' ORDER BY ordinal_position
`);
console.log('purchase_items cols', piCols.rows.map((r) => r.column_name).join(', '));

const purchase = await query(`SELECT * FROM purchases WHERE id = 514`);
console.log('purchase 514', JSON.stringify(purchase.rows.map((r) => ({
  id: r.id, status: r.status, number: r.number, warehouse_id: r.warehouse_id
})), null, 2));

const items = await query(`
  SELECT pi.id, p.sku, pi.*
  FROM purchase_items pi
  LEFT JOIN products p ON p.id = pi.product_id
  WHERE pi.purchase_id = 514
  ORDER BY p.sku
`);
// print key fields only
console.log('purchase items', JSON.stringify(items.rows.map((r) => ({
  id: r.id,
  sku: r.sku,
  ordered: r.ordered_quantity ?? r.qty ?? r.quantity_ordered ?? null,
  received: r.received_quantity ?? r.qty_received ?? null,
  keys: Object.keys(r).filter((k) => /qty|quant|receiv|order|incom/i.test(k))
})), null, 2));

const skus = ['SM-3026', 'SM-3043S', 'TG-5263', 'SN-2341', 'SN-2214'];
const stock = await query(`
  SELECT id, sku,
         COALESCE(quantity,0)::int AS qty,
         COALESCE(reserved_quantity,0)::int AS reserved,
         COALESCE(incoming_quantity,0)::int AS incoming
  FROM products WHERE sku = ANY($1)
`, [skus]);
console.log('stock now', JSON.stringify(stock.rows, null, 2));

await closePool();
