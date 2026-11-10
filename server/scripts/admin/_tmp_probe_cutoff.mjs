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
const {
  sumOrderableSupplierWarehouseStock,
  sumPurchasableSupplierWarehouseStock,
} = await import('../../src/utils/supplierProcurementArrival.js');
const supplierStocksService = (await import('../../src/services/supplierStocks.service.js')).default;

const now = new Date();
console.log('now ISO', now.toISOString(), 'MSK approx', new Date(now.getTime() + 3 * 3600e3).toISOString());

const row = (
  await query(
    `SELECT ss.product_id, p.sku, ss.stock, ss.warehouses, s.api_config, s.id AS supplier_id
     FROM supplier_stocks ss
     JOIN products p ON p.id=ss.product_id
     JOIN suppliers s ON s.id=ss.supplier_id
     WHERE p.sku='AFAC167' AND p.profile_id=1 AND ss.supplier_id=1`
  )
).rows[0];

console.log({
  sku: row.sku,
  stock: row.stock,
  orderable: sumOrderableSupplierWarehouseStock({
    apiConfig: row.api_config,
    stockWarehouses: row.warehouses,
    aggregatedStock: row.stock,
    now,
  }),
  purchasable: sumPurchasableSupplierWarehouseStock({
    apiConfig: row.api_config,
    stockWarehouses: row.warehouses,
    aggregatedStock: row.stock,
  }),
  orderableMorning: sumOrderableSupplierWarehouseStock({
    apiConfig: row.api_config,
    stockWarehouses: row.warehouses,
    aggregatedStock: row.stock,
    now: new Date('2026-11-08T10:00:00+03:00'),
  }),
});

const bd = await supplierStocksService.getBreakdownByProductIds([Number(row.product_id)], {
  mainWarehouseId: '1',
  profileId: '1',
});
console.log('breakdown now', bd);

await closePool();
