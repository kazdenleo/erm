import { query, closePool } from '../../src/config/database.js';

const dok = await query(`
  SELECT p.id, p.sku, p.profile_id, p.quantity AS product_qty,
         ss.stock AS mikado_stock, ss.updated_at AS mikado_upd,
         COALESCE((
           SELECT sum(pws.quantity)::int
           FROM product_warehouse_stock pws
           JOIN warehouses w ON w.id = pws.warehouse_id
           WHERE pws.product_id = p.id
             AND w.supplier_id IS NULL
             AND COALESCE(w.is_fbo_stock,false)=false
         ),0) AS erp_wh_qty
  FROM products p
  JOIN supplier_stocks ss ON ss.product_id = p.id AND ss.supplier_id = 1
  WHERE p.profile_id = 6 AND ss.stock > 0
  ORDER BY ss.stock DESC
  LIMIT 10
`);
console.log('dok trade mikado>0 (stale ok)', dok.rows);

const auto = await query(`
  SELECT p.id, p.sku, p.profile_id,
         ss.stock AS mikado_stock, ss.updated_at AS mikado_upd,
         COALESCE((
           SELECT sum(pws.quantity)::int
           FROM product_warehouse_stock pws
           JOIN warehouses w ON w.id = pws.warehouse_id
           WHERE pws.product_id = p.id
             AND w.supplier_id IS NULL
             AND COALESCE(w.is_fbo_stock,false)=false
         ),0) AS erp_wh_qty
  FROM products p
  JOIN supplier_stocks ss ON ss.product_id = p.id AND ss.supplier_id = 1
  WHERE p.profile_id = 1 AND ss.stock > 0
  ORDER BY ss.updated_at DESC
  LIMIT 8
`);
console.log('auto mikado>0 fresh', auto.rows);

await closePool();
