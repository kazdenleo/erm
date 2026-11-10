import { query, closePool } from '../../src/config/database.js';
import { sumOrderableSupplierWarehouseStock } from '../../src/utils/supplierProcurementArrival.js';
import stocksRepo from '../../src/repositories/supplier_stocks.repository.pg.js';

const s = await query(`SELECT id, code, api_config FROM suppliers WHERE id IN (1,2)`);
for (const row of s.rows) {
  console.log('supplier', row.id, row.code, 'warehouses cfg', JSON.stringify(row.api_config?.warehouses || [], null, 2));
}

const skus = ['AFAC167', 'AFAD128', 'AN1125'];
const products = await query(
  `SELECT p.id, p.sku, ss.stock, ss.warehouses, s.api_config, s.code
   FROM products p
   JOIN supplier_stocks ss ON ss.product_id = p.id
   JOIN suppliers s ON s.id = ss.supplier_id
   WHERE p.sku = ANY($1::text[]) AND s.id = 1`,
  [skus]
);

const now = new Date();
console.log('now', now.toString());
for (const row of products.rows) {
  const orderable = sumOrderableSupplierWarehouseStock({
    apiConfig: row.api_config,
    stockWarehouses: row.warehouses,
    aggregatedStock: row.stock,
    now,
    warehouseNameHint: null,
  });
  console.log({
    sku: row.sku,
    agg: row.stock,
    orderable,
    warehouses: typeof row.warehouses === 'string' ? row.warehouses.slice(0, 200) : row.warehouses,
  });
}

const ids = products.rows.map((r) => Number(r.id));
const bd = await stocksRepo.findBreakdownByProductIds(ids, { mainWarehouseId: 1, profileId: 1 });
console.log('breakdown', bd);

await closePool();
