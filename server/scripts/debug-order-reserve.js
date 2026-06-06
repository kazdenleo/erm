import { query } from '../src/config/database.js';
import ordersService from '../src/services/orders.service.js';
import repositoryFactory from '../src/config/repository-factory.js';
import { getProductSupplySnapshotWithClient, computeAvailableQuantity } from '../src/services/sellableQuantity.service.js';
import { getComponentAssemblableUnits } from '../src/services/kitStock.service.js';
import { isKitProductId } from '../src/services/kitStock.service.js';

const orderId = process.argv[2] || '5156499368';

const o = await query(
  `SELECT id, marketplace, order_id, product_id, quantity, status, offer_id, product_name, delivery_address
   FROM orders WHERE order_id = $1`,
  [orderId]
);
const order = o.rows[0];
console.log('ORDER', order);

const p = await query('SELECT id, sku, incoming_quantity, quantity FROM products WHERE id=100');
console.log('PRODUCT', p.rows[0]);

const wm = await query(
  `SELECT * FROM warehouse_mappings WHERE marketplace='wb' AND marketplace_warehouse_id LIKE '1326703%'`
);
console.log('WM', wm.rows);

const repo = repositoryFactory.getOrdersRepository();
const queue = await repo.findReserveQueueOrdersByProductId(100, 10);
console.log(
  'RESERVE_QUEUE',
  queue.filter((r) => String(r.orderId ?? r.order_id) === orderId)
);

const resolved = await ordersService._resolveProductIdForOrderStock({
  ...order,
  orderId: order.order_id,
  deliveryAddress: order.delivery_address,
});
console.log('RESOLVED_PRODUCT', resolved);

const wh = await ordersService._resolveWarehouseIdForOrderReserve(
  { ...order, orderId: order.order_id, deliveryAddress: order.delivery_address },
  resolved
);
console.log('WAREHOUSE', wh);

const avail = await ordersService._availableUnitsForOrderReserve(
  resolved,
  { ...order, orderId: order.order_id, deliveryAddress: order.delivery_address },
  wh
);
console.log('AVAIL', avail);
console.log('IS_KIT', await isKitProductId(resolved));
const snap = await getProductSupplySnapshotWithClient(null, resolved, { warehouseId: wh });
console.log('SNAP', snap);
const comp = await getComponentAssemblableUnits(resolved, { warehouseId: wh });
console.log('COMP_ASSEMBLE', comp);
const cq = await computeAvailableQuantity(resolved, { warehouseId: wh });
console.log('COMPUTE_AVAIL', cq);

console.log('Applying reserve...');
try {
  await ordersService._applyReserveForOrder(resolved, 1, order.order_id, {
    order_id: Number(order.id),
    orderId: order.order_id,
    warehouse_id: wh,
    strict_warehouse: true,
  });
  console.log('APPLY_OK');
} catch (e) {
  console.log('APPLY_ERR', e?.message, e?.statusCode, e?.stack?.split('\n').slice(0, 3));
}

const sm = await query(
  `SELECT id, type, quantity_change, meta FROM stock_movements
   WHERE product_id=100 AND meta->>'order_id' = $1`,
  [String(order.id)]
);
console.log('MOVEMENTS_AFTER', sm.rows);

process.exit(0);
