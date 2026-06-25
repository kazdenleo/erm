#!/usr/bin/env node
/** node scripts/diag-order-reserve.js 5237414075 */
import '../src/load-env.js';
import { query } from '../src/config/database.js';

const orderId = process.argv[2] || '5237414075';
const o = await query(
  `SELECT id, marketplace, order_id, product_id, offer_id, status, quantity, warehouse_id, profile_id
   FROM orders WHERE order_id = $1 LIMIT 1`,
  [orderId]
);
console.log('order', o.rows[0]);
const oid = o.rows[0]?.id;
const pid = o.rows[0]?.product_id;
if (!pid) {
  process.exit(0);
}

const p = await query(
  `SELECT id, sku, incoming_quantity, quantity, reserved_quantity, supplier_id FROM products WHERE id = $1`,
  [pid]
);
console.log('product', p.rows[0]);

const sm = await query(
  `SELECT id, type, quantity_change, warehouse_id, reason,
          meta->>'order_id' AS order_db_id
   FROM stock_movements
   WHERE product_id = $1 AND type IN ('reserve', 'unreserve', 'incoming')
   ORDER BY id DESC LIMIT 15`,
  [pid]
);
console.log('movements', sm.rows);

const net = await query(
  `SELECT GREATEST(0, COALESCE(SUM(CASE WHEN type = 'reserve' THEN ABS(quantity_change)
    WHEN type = 'unreserve' THEN -ABS(quantity_change) ELSE 0 END), 0))::int AS net
   FROM stock_movements WHERE product_id = $1 AND meta->>'order_id' = $2`,
  [pid, String(oid)]
);
console.log('reserve for order', net.rows[0]);

const pi = await query(
  `SELECT pi.purchase_id, pi.expected_quantity, pi.received_quantity, pi.source_orders, p.ordered_at
   FROM purchase_items pi
   JOIN purchases p ON p.id = pi.purchase_id
   WHERE pi.source_orders::text LIKE $1 LIMIT 5`,
  [`%${orderId}%`]
);
console.log('purchase items', pi.rows);

const { default: ordersService } = await import('../src/services/orders.service.js');
const row = o.rows[0];
row.orderId = row.order_id;
row.productId = row.product_id;
const wh = await ordersService._resolveWarehouseIdForOrderReserve(row, pid);
console.log('resolve warehouse', wh);

const { getProductSupplySnapshotWithClient } = await import('../src/services/sellableQuantity.service.js');
const snapGlobal = await getProductSupplySnapshotWithClient(null, pid);
const snapWh = await getProductSupplySnapshotWithClient(null, pid, { warehouseId: wh });
console.log('snap global', snapGlobal);
console.log('snap wh', snapWh);

const avail = await ordersService._availableUnitsForOrderReserve(pid, row, wh);
console.log('avail for order', avail);

const blocked = await ordersService._manualUnreserveBlocksAutoReserve(oid, pid, orderId);
console.log('manual unreserve blocks', blocked);

if (process.argv.includes('--apply')) {
  await ordersService
    ._applyReserveForOrderIfAbsent(row, { allowDespiteManualUnreserve: true })
    .catch((e) => console.log('apply err', e.message));
}

const net2 = await query(
  `SELECT GREATEST(0, COALESCE(SUM(CASE WHEN type = 'reserve' THEN ABS(quantity_change)
    WHEN type = 'unreserve' THEN -ABS(quantity_change) ELSE 0 END), 0))::int AS net
   FROM stock_movements WHERE product_id = $1 AND meta->>'order_id' = $2`,
  [pid, String(oid)]
);
console.log('reserve after apply', net2.rows[0]);

process.exit(0);
