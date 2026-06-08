/**
 * Быстрая проверка ручного резерва комплекта по order_id.
 * node scripts/test-kit-reserve-order.js 5160866161
 */
import { query } from '../src/config/database.js';
import ordersService from '../src/services/orders.service.js';

const orderId = process.argv[2] || '5160866161';

const o = await query(
  `SELECT id, marketplace, order_id, product_id, quantity, status, offer_id, delivery_address
   FROM orders WHERE order_id = $1 LIMIT 1`,
  [orderId]
);
const order = o.rows[0];
if (!order) {
  console.log('ORDER_NOT_FOUND');
  process.exit(1);
}

const resolved = await ordersService._resolveProductIdForOrderStock({
  ...order,
  orderId: order.order_id,
  deliveryAddress: order.delivery_address,
});
const wh = await ordersService._resolveWarehouseIdForOrderReserve(
  { ...order, orderId: order.order_id, deliveryAddress: order.delivery_address },
  resolved
);

console.log('order_db_id', order.id, 'product', resolved, 'warehouse', wh);

const { getReservedKitUnitsForOrderValidation, getNetReservedForOrderProduct } = await import(
  '../src/services/kitStock.service.js'
);
const oid = Number(order.id);
const onKit = await getNetReservedForOrderProduct(oid, resolved);
const kitUnits = await getReservedKitUnitsForOrderValidation(resolved, oid);
console.log('reserved_on_kit', onKit, 'kit_units_validation', kitUnits);

try {
  const result = await ordersService.setOrderReserveForProduct('wildberries', order.order_id, {
    productId: resolved,
    action: 'reserve',
    quantity: 1,
  });
  console.log('RESERVE_OK', {
    reservedQty: result.reservedQty,
    needQty: result.needQty,
    message: result.message,
  });
} catch (e) {
  console.log('RESERVE_ERR', e?.message, e?.statusCode);
}

const sm = await query(
  `SELECT type, quantity_change, meta->>'order_id' oid
   FROM stock_movements
   WHERE (meta->>'order_id')::bigint = $1::bigint
   ORDER BY id DESC LIMIT 5`,
  [String(order.id)]
);
console.log('MOVEMENTS', sm.rows);
process.exit(0);
