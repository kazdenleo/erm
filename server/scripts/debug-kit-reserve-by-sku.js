/**
 * Диагностика резерва комплекта по offer_id заказа.
 * node scripts/debug-kit-reserve-by-sku.js DTSN2524R
 */
import { query } from '../src/config/database.js';
import ordersService from '../src/services/orders.service.js';
import {
  applyKitOrderReserve,
  computeKitReservableBreakdown,
  allocateKitReservePriority,
  getReservedKitUnitsForOrderValidation,
  getNetReservedForOrderProduct,
  getReservedKitUnitsFromComponentsForOrder,
  getKitComponents,
} from '../src/services/kitStock.service.js';
import { isKitProductId } from '../src/services/kitStock.service.js';

const sku = process.argv[2] || 'DTSN2524R';
const o = await query(
  `SELECT id, marketplace, order_id, product_id, quantity, offer_id, delivery_address, status
   FROM orders WHERE offer_id ILIKE $1 ORDER BY created_at DESC LIMIT 1`,
  [`%${sku}%`]
);
const order = o.rows[0];
if (!order) {
  console.log('ORDER_NOT_FOUND', sku);
  process.exit(1);
}

const row = {
  ...order,
  orderId: order.order_id,
  deliveryAddress: order.delivery_address,
};
const kitId = await ordersService._resolveProductIdForOrderStock(row);
const wh = await ordersService._resolveWarehouseIdForOrderReserve(row, kitId);
const strictWh = true;

console.log('ORDER', order.order_id, 'db', order.id, 'kit', kitId, 'wh', wh);

const breakdown = await computeKitReservableBreakdown(kitId, { warehouseId: wh });
const alloc = allocateKitReservePriority(1, breakdown);
console.log('BREAKDOWN', breakdown);
console.log('ALLOC', alloc);

const onKit = await getNetReservedForOrderProduct(Number(order.id), kitId);
const fromComp = await getReservedKitUnitsFromComponentsForOrder(kitId, Number(order.id));
console.log('MIXED', { onKit, fromComp });

const comps = await getKitComponents(kitId);
for (const c of comps) {
  const cid = Number(c.component_product_id);
  const av = await ordersService._getAvailableUnitsForOrderReserveLine(cid, row, {
    warehouseId: wh,
    kitProductId: kitId,
  });
  const res = await getNetReservedForOrderProduct(Number(order.id), cid);
  console.log('COMP', cid, 'perKit', c.quantity, 'avail', av, 'reserved', res);
}

try {
  const result = await ordersService.setOrderReserveForProduct(
    order.marketplace === 'wb' ? 'wildberries' : order.marketplace,
    order.order_id,
    { productId: kitId, action: 'reserve', quantity: 1 }
  );
  console.log('OK', result.reservedQty, result.needQty, result.message);
} catch (e) {
  console.log('ERR', e.message, e.statusCode);
}

console.log('AFTER', await getReservedKitUnitsForOrderValidation(kitId, Number(order.id)));
process.exit(0);
