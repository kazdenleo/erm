import { query, closePool } from '../../src/config/database.js';
import supplierStocksRepository from '../../src/repositories/supplier_stocks.repository.pg.js';

const linked = await query(`
  SELECT w.id, w.name, w.address, w.type, w.supplier_id, w.main_warehouse_id, w.profile_id,
         s.code AS supplier_code
  FROM warehouses w
  LEFT JOIN suppliers s ON s.id = w.supplier_id
  WHERE w.supplier_id IS NOT NULL
  ORDER BY w.id
`);
console.log('supplier warehouses count', linked.rows.length);
console.log(linked.rows.slice(0, 30));

const mains = await query(`
  SELECT id, name, address, type, profile_id, organization_id
  FROM warehouses
  WHERE supplier_id IS NULL AND COALESCE(is_fbo_stock,false)=false
  ORDER BY id
`);
console.log('main warehouses', mains.rows);

const productIds = (
  await query(`
  SELECT p.id
  FROM products p
  JOIN supplier_stocks ss ON ss.product_id = p.id AND ss.supplier_id = 1 AND ss.stock > 0
  WHERE p.profile_id = 1
  ORDER BY ss.updated_at DESC
  LIMIT 15
`)
).rows.map((r) => Number(r.id));
console.log('sample product ids', productIds);

const repo = new supplierStocksRepository.constructor
  ? null
  : null;

// instantiate via factory
const { default: repositoryFactory } = await import('../../src/repositories/repositoryFactory.js');
const stocksRepo = repositoryFactory.getSupplierStocksRepository();

const rawNoFilter = await query(`
  SELECT ss.product_id, s.code, ss.stock
  FROM supplier_stocks ss
  JOIN suppliers s ON s.id = ss.supplier_id
  WHERE ss.product_id = ANY($1::int[]) AND COALESCE(ss.stock,0) > 0
`, [productIds]);
console.log('raw stocks >0', rawNoFilter.rows);

const withExists = await query(`
  SELECT ss.product_id, s.code, ss.stock, s.id AS supplier_id
  FROM supplier_stocks ss
  JOIN suppliers s ON ss.supplier_id = s.id
  WHERE ss.product_id = ANY($1::int[])
    AND COALESCE(ss.stock, 0) > 0
    AND EXISTS (
      SELECT 1 FROM warehouses w
      WHERE w.supplier_id = s.id
        AND w.type = 'supplier'
        AND w.main_warehouse_id IS NOT NULL
    )
`, [productIds]);
console.log('after warehouse EXISTS filter', withExists.rows);

const breakdownAll = await stocksRepo.findBreakdownByProductIds(productIds, {});
console.log('breakdown no mainWarehouse', breakdownAll);

const mainId = mains.rows[0]?.id;
if (mainId) {
  const breakdownMain = await stocksRepo.findBreakdownByProductIds(productIds, {
    mainWarehouseId: mainId,
    profileId: 1,
  });
  console.log('breakdown mainWarehouse', mainId, breakdownMain);
}

await closePool();
