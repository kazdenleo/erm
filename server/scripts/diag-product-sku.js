#!/usr/bin/env node
/** Диагностика товара по SKU: node scripts/diag-product-sku.js AN1096 */
import '../src/load-env.js';
import { query } from '../src/config/database.js';
import { getProductSupplySnapshotWithClient } from '../src/services/sellableQuantity.service.js';

const sku = process.argv[2] || 'AN1096';
const pr = await query(
  `SELECT id, sku, organization_id, profile_id, quantity, incoming_quantity, reserved_quantity
   FROM products WHERE UPPER(TRIM(sku)) = UPPER(TRIM($1)) LIMIT 5`,
  [sku]
);
console.log('products', pr.rows);
if (!pr.rows[0]) process.exit(0);
const pid = pr.rows[0].id;
const skus = await query(
  `SELECT marketplace, sku, marketplace_product_id FROM product_skus WHERE product_id = $1`,
  [pid]
);
console.log('product_skus', skus.rows);
const pws = await query('SELECT * FROM product_warehouse_stock WHERE product_id = $1', [pid]);
console.log('pws', pws.rows);
const snap = await getProductSupplySnapshotWithClient(null, pid);
console.log('supply snapshot', snap);
const ord = await query(
  `SELECT id, marketplace, order_id, status, quantity, product_id
   FROM orders WHERE product_id = $1 AND status IN ('new','in_procurement','in_assembly','__wb_status_pending__')
   ORDER BY id DESC LIMIT 15`,
  [pid]
);
console.log('orders', ord.rows);
const sm = await query(
  `SELECT id, type, quantity_change, reason, created_at
   FROM stock_movements WHERE product_id = $1 ORDER BY id DESC LIMIT 12`,
  [pid]
);
console.log('movements', sm.rows);
process.exit(0);
