import { query, closePool } from '../../src/config/database.js';
import stocksRepo from '../../src/repositories/supplier_stocks.repository.pg.js';

const productIds = (
  await query(`
  SELECT p.id
  FROM products p
  JOIN supplier_stocks ss ON ss.product_id = p.id AND ss.supplier_id = 1 AND ss.stock > 0
  WHERE p.profile_id = 1
  ORDER BY ss.updated_at DESC
  LIMIT 10
`)
).rows.map((r) => Number(r.id));

const raw = await query(
  `SELECT ss.product_id, s.code, ss.stock FROM supplier_stocks ss
   JOIN suppliers s ON s.id = ss.supplier_id
   WHERE ss.product_id = ANY($1::int[]) AND COALESCE(ss.stock,0) > 0`,
  [productIds]
);
console.log('raw >0', raw.rows.length, raw.rows.slice(0, 5));

const withExistsAny = await query(
  `SELECT count(*)::int AS n FROM supplier_stocks ss
   JOIN suppliers s ON ss.supplier_id = s.id
   WHERE ss.product_id = ANY($1::int[]) AND COALESCE(ss.stock,0) > 0
     AND EXISTS (
       SELECT 1 FROM warehouses w
       WHERE w.supplier_id = s.id AND w.type='supplier' AND w.main_warehouse_id IS NOT NULL
     )`,
  [productIds]
);
console.log('exists any main link', withExistsAny.rows);

const withExistsKirov = await query(
  `SELECT count(*)::int AS n FROM supplier_stocks ss
   JOIN suppliers s ON ss.supplier_id = s.id
   WHERE ss.product_id = ANY($1::int[]) AND COALESCE(ss.stock,0) > 0
     AND EXISTS (
       SELECT 1 FROM warehouses w
       WHERE w.supplier_id = s.id AND w.type='supplier'
         AND (
           w.main_warehouse_id = $2
           OR EXISTS (
             SELECT 1 FROM supplier_warehouse_main_links l
             WHERE l.supplier_warehouse_id = w.id AND l.main_warehouse_id = $2
           )
         )
     )`,
  [productIds, '4']
);
console.log('exists for Киров(4)', withExistsKirov.rows);

const withExistsMoscow = await query(
  `SELECT count(*)::int AS n FROM supplier_stocks ss
   JOIN suppliers s ON ss.supplier_id = s.id
   WHERE ss.product_id = ANY($1::int[]) AND COALESCE(ss.stock,0) > 0
     AND EXISTS (
       SELECT 1 FROM warehouses w
       WHERE w.supplier_id = s.id AND w.type='supplier'
         AND (
           w.main_warehouse_id = $2
           OR EXISTS (
             SELECT 1 FROM supplier_warehouse_main_links l
             WHERE l.supplier_warehouse_id = w.id AND l.main_warehouse_id = $2
           )
         )
     )`,
  [productIds, '1']
);
console.log('exists for Москва(1)', withExistsMoscow.rows);

const b1 = await stocksRepo.findBreakdownByProductIds(productIds, { mainWarehouseId: 1, profileId: 1 });
console.log('breakdown Москва', b1.slice(0, 5), 'count', b1.length);
const b4 = await stocksRepo.findBreakdownByProductIds(productIds, { mainWarehouseId: 4, profileId: 1 });
console.log('breakdown Киров', b4.slice(0, 5), 'count', b4.length);
const b0 = await stocksRepo.findBreakdownByProductIds(productIds, { profileId: 1 });
console.log('breakdown no filter', b0.slice(0, 5), 'count', b0.length);

// also check orderable after city hint for Moscow
const sampleWh = await query(`SELECT product_id, warehouses, stock FROM supplier_stocks WHERE product_id=$1 AND supplier_id=1`, [productIds[0]]);
console.log('sample warehouses json for', productIds[0], JSON.stringify(sampleWh.rows[0], null, 2)?.slice(0, 800));

await closePool();
