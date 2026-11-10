import { query, closePool } from '../../src/config/database.js';
import stocksRepo from '../../src/repositories/supplier_stocks.repository.pg.js';

const skus = [
  'AFAD128',
  'AFAC167',
  'AFAC165',
  'AFAD51',
  'AN1125',
  'AN1053',
  'AN1246',
  'AN1013',
];

const products = await query(
  `SELECT id, sku, name, profile_id, organization_id, quantity
   FROM products
   WHERE UPPER(REPLACE(TRIM(sku),' ','')) = ANY($1::text[])
   ORDER BY profile_id, sku`,
  [skus.map((s) => s.toUpperCase())]
);
console.log('products', products.rows);

const ids = products.rows.map((r) => Number(r.id));
if (!ids.length) {
  await closePool();
  process.exit(0);
}

const stocks = await query(
  `SELECT p.sku, p.profile_id, s.id AS supplier_id, s.code, ss.stock, ss.updated_at, ss.warehouses
   FROM supplier_stocks ss
   JOIN products p ON p.id = ss.product_id
   JOIN suppliers s ON s.id = ss.supplier_id
   WHERE ss.product_id = ANY($1::int[])
   ORDER BY p.sku, s.id`,
  [ids]
);
console.log(
  'supplier_stocks',
  stocks.rows.map((r) => ({
    sku: r.sku,
    profile: r.profile_id,
    code: r.code,
    stock: r.stock,
    updated: r.updated_at,
    whCount: Array.isArray(r.warehouses)
      ? r.warehouses.length
      : typeof r.warehouses === 'string'
        ? JSON.parse(r.warehouses || '[]').length
        : null,
  }))
);

const whQty = await query(
  `SELECT p.sku, w.id AS wid, w.name, w.address, pws.quantity
   FROM product_warehouse_stock pws
   JOIN products p ON p.id = pws.product_id
   JOIN warehouses w ON w.id = pws.warehouse_id
   WHERE pws.product_id = ANY($1::int[])
   ORDER BY p.sku, w.id`,
  [ids]
);
console.log('erp warehouse qty', whQty.rows);

const org = await query(`SELECT id, name, profile_id FROM organizations ORDER BY id`);
console.log('orgs', org.rows);

const profile1Ids = products.rows.filter((r) => String(r.profile_id) === '1').map((r) => Number(r.id));
if (profile1Ids.length) {
  const b = await stocksRepo.findBreakdownByProductIds(profile1Ids, {
    mainWarehouseId: 1,
    profileId: 1,
  });
  console.log('breakdown Москва profile1', b);
}

const lastSync = await query(
  `SELECT max(updated_at) AS last_upd,
          count(*) FILTER (WHERE updated_at > now() - interval '2 hours')::int AS fresh_2h,
          count(*)::int AS total
   FROM supplier_stocks ss
   JOIN products p ON p.id = ss.product_id
   WHERE p.profile_id = 1`
);
console.log('profile1 supplier_stocks freshness', lastSync.rows);

await closePool();
