/**
 * Разовый пересчёт резерва по заказу (после закупки / исправления логики).
 * Usage: node scripts/reapply-order-reserve.js <orderId>
 */
import { query } from '../src/config/database.js';
import ordersService from '../src/services/orders.service.js';

const orderId = process.argv[2];
if (!orderId) {
  console.error('Usage: node scripts/reapply-order-reserve.js <orderId>');
  process.exit(1);
}

const o = await query(
  `SELECT id, marketplace, order_id, product_id, quantity, status, offer_id, marketplace_sku,
          product_name, delivery_address
   FROM orders WHERE order_id = $1`,
  [orderId]
);
const row = o.rows?.[0];
if (!row) {
  console.error('Order not found');
  process.exit(1);
}

const orderRow = {
  ...row,
  orderId: row.order_id,
  deliveryAddress: row.delivery_address,
};

console.log('Before', { status: row.status, product_id: row.product_id });
await ordersService._reapplyReserveForOrderRows([orderRow]);

const sm = await query(
  `SELECT id, type, quantity_change, meta FROM stock_movements
   WHERE meta->>'order_id' = $1 AND type IN ('reserve', 'unreserve')`,
  [String(row.id)]
);
console.log('Movements', sm.rows);

const p = await query(
  `SELECT incoming_quantity FROM products p
   INNER JOIN purchase_items pi ON pi.product_id = p.id
   INNER JOIN purchases pu ON pu.id = pi.purchase_id
   WHERE pu.status = 'open'
     AND pi.source_orders @> $1::jsonb
   LIMIT 1`,
  [JSON.stringify([{ orderId: String(orderId), marketplace: 'wildberries' }])]
);
console.log('Incoming via purchase', p.rows?.[0]?.incoming_quantity);

process.exit(0);
