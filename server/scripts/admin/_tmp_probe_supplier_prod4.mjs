import fs from 'fs';

for (const line of fs.readFileSync('/opt/erm/server/.env', 'utf8').split(/\n/)) {
  if (!line || line.startsWith('#')) continue;
  const i = line.indexOf('=');
  if (i < 0) continue;
  const k = line.slice(0, i);
  let v = line.slice(i + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  if (!(k in process.env)) process.env[k] = v;
}

const { query, closePool } = await import('../../src/config/database.js');
const { sumOrderableSupplierWarehouseStock } = await import('../../src/utils/supplierProcurementArrival.js');
const supplierStocksService = (await import('../../src/services/supplierStocks.service.js')).default;

const positives = await query(
  `SELECT ss.product_id, p.sku, ss.supplier_id, s.name, ss.stock, ss.warehouses, ss.stock_name, s.api_config
   FROM supplier_stocks ss
   JOIN products p ON p.id = ss.product_id
   JOIN suppliers s ON s.id = ss.supplier_id
   WHERE COALESCE(ss.stock,0) > 0 AND ss.supplier_id = 1
   ORDER BY ss.stock DESC
   LIMIT 8`
);
console.log('--- supplier1 orderable check ---');
for (const row of positives.rows) {
  const orderable = sumOrderableSupplierWarehouseStock({
    apiConfig: row.api_config,
    stockWarehouses: row.warehouses,
    aggregatedStock: row.stock,
    now: new Date(),
    warehouseNameHint: null,
  });
  console.log({
    sku: row.sku,
    stock: row.stock,
    orderable,
    warehousesType: Array.isArray(row.warehouses) ? 'array' : typeof row.warehouses,
    warehousesSample: Array.isArray(row.warehouses)
      ? row.warehouses.slice(0, 3)
      : String(row.warehouses).slice(0, 200),
    apiWh: row.api_config?.warehouses,
  });
}

const pos5 = await query(
  `SELECT ss.product_id, p.sku, ss.supplier_id, ss.stock, ss.warehouses, s.api_config
   FROM supplier_stocks ss
   JOIN products p ON p.id = ss.product_id
   JOIN suppliers s ON s.id = ss.supplier_id
   WHERE COALESCE(ss.stock,0) > 0 AND ss.supplier_id = 5
   ORDER BY ss.stock DESC
   LIMIT 3`
);
console.log('--- supplier5 (no warehouse row) ---');
for (const row of pos5.rows) {
  const orderable = sumOrderableSupplierWarehouseStock({
    apiConfig: row.api_config,
    stockWarehouses: row.warehouses,
    aggregatedStock: row.stock,
    now: new Date(),
    warehouseNameHint: null,
  });
  console.log({ sku: row.sku, stock: row.stock, orderable, wh: row.warehouses?.slice?.(0, 2) });
}

const ids = positives.rows.map((r) => Number(r.product_id));
console.log(
  'breakdown for top supplier1 products',
  await supplierStocksService.getBreakdownByProductIds(ids, { mainWarehouseId: '1', profileId: '1' })
);
console.log(
  'breakdown no profile',
  await supplierStocksService.getBreakdownByProductIds(ids, { mainWarehouseId: '1' })
);
console.log(
  'breakdown no wh filter',
  await supplierStocksService.getBreakdownByProductIds(ids, {})
);

// credentials columns
const cols = await query(
  `SELECT column_name FROM information_schema.columns
   WHERE table_name='suppliers' AND (column_name ILIKE '%key%' OR column_name ILIKE '%pass%' OR column_name ILIKE '%token%' OR column_name ILIKE '%secret%' OR column_name ILIKE '%login%' OR column_name='api_config')
   ORDER BY 1`
);
console.log('supplier secret-ish columns', cols.rows.map((r) => r.column_name));

await closePool();
