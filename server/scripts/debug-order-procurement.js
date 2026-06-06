/**
 * Одноразовая диагностика заказа: node scripts/debug-order-procurement.js 5156499368
 */
import { query, closePool } from '../src/config/database.js';

const orderId = process.argv[2] || '5156499368';

async function main() {
  const o = await query(
    `SELECT id, marketplace, order_id, product_id, quantity, status, profile_id,
            offer_id, marketplace_sku, product_name, delivery_address
     FROM orders WHERE order_id = $1`,
    [orderId]
  );
  console.log('ORDER', JSON.stringify(o.rows, null, 2));
  const row = o.rows?.[0];
  if (!row) {
    await closePool();
    return;
  }
  const dbId = row.id;
  const sm = await query(
    `SELECT type, quantity_change, reason, meta, created_at
     FROM stock_movements
     WHERE (meta ? 'order_id' AND (meta->>'order_id')::bigint = $1)
        OR reason ILIKE $2
     ORDER BY created_at DESC LIMIT 15`,
    [dbId, `%${orderId}%`]
  );
  console.log('MOVEMENTS', JSON.stringify(sm.rows, null, 2));
  const pr = await query(
    `SELECT DISTINCT p.id, p.status, p.supplier_id, p.note, s.name AS supplier_name
     FROM purchase_items pi
     INNER JOIN purchases p ON p.id = pi.purchase_id
     LEFT JOIN suppliers s ON s.id = p.supplier_id
     CROSS JOIN LATERAL jsonb_array_elements(COALESCE(pi.source_orders, '[]'::jsonb)) elem
     WHERE elem->>'orderId' = $1`,
    [orderId]
  );
  console.log('PURCHASES', JSON.stringify(pr.rows, null, 2));
  const pi = await query(
    `SELECT pi.* FROM purchase_items pi
     CROSS JOIN LATERAL jsonb_array_elements(COALESCE(pi.source_orders, '[]'::jsonb)) elem
     WHERE elem->>'orderId' = $1`,
    [orderId]
  );
  console.log('PURCHASE_ITEMS', JSON.stringify(pi.rows, null, 2));
  try {
    const fl = await query(`SELECT * FROM order_fulfillment_lines WHERE order_db_id = $1`, [dbId]);
    console.log('FULFILLMENT', JSON.stringify(fl.rows, null, 2));
  } catch (e) {
    console.log('FULFILLMENT', e.message);
  }
  if (row.product_id) {
    const prod = await query(
      `SELECT id, sku, quantity, incoming_quantity FROM products WHERE id = $1`,
      [row.product_id]
    );
    console.log('PRODUCT', JSON.stringify(prod.rows, null, 2));
    const pws = await query(
      `SELECT warehouse_id, quantity FROM product_warehouse_stock WHERE product_id = $1`,
      [row.product_id]
    );
    console.log('PWS', JSON.stringify(pws.rows, null, 2));
  }
  await closePool();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
