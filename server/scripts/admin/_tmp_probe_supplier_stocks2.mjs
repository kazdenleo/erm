import { query, closePool } from '../../src/config/database.js';

const sample = await query(`
  SELECT s.id, s.code, p.sku, ss.stock, ss.price, ss.updated_at
  FROM supplier_stocks ss
  JOIN suppliers s ON s.id = ss.supplier_id
  JOIN products p ON p.id = ss.product_id
  WHERE ss.updated_at > now() - interval '20 minutes'
  ORDER BY ss.updated_at DESC
  LIMIT 12
`);
console.log('fresh', sample.rows);

const mosk = await query(`
  SELECT count(*) FILTER (WHERE stock>0)::int as pos,
         count(*) FILTER (WHERE stock=0)::int as zero,
         count(*) FILTER (WHERE stock IS NULL)::int as nul
  FROM supplier_stocks WHERE supplier_id=2
`);
console.log('mosk distribution', mosk.rows);

const flags = await query(`
  SELECT id, name, COALESCE(supplier_sync_enabled,true) AS supplier_sync_enabled
  FROM profiles ORDER BY id
`);
console.log('profiles', flags.rows);

const productSupplierLink = await query(`
  SELECT column_name FROM information_schema.columns
  WHERE table_name IN ('product_suppliers','supplier_products','products')
    AND column_name ILIKE '%supplier%'
  ORDER BY table_name, column_name
`);
console.log('supplier-related cols', productSupplierLink.rows);

await closePool();
