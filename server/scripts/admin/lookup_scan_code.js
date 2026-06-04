/**
 * Проверка, кто в БД совпадает с кодом сканера.
 * node scripts/admin/lookup_scan_code.js DT-00230
 */
import { query } from '../../src/config/database.js';

const code = process.argv[2] || 'DT-00230';

const r1 = await query(
  `SELECT p.id, p.sku, p.name, b.barcode
   FROM barcodes b JOIN products p ON p.id = b.product_id
   WHERE LOWER(TRIM(b.barcode)) = LOWER(TRIM($1))`,
  [code]
);
const r2 = await query(
  `SELECT p.id, p.sku, p.name FROM products p
   WHERE LOWER(TRIM(p.sku)) = LOWER(TRIM($1)) AND COALESCE(p.is_archived, false) = false`,
  [code]
);
const r3 = await query(
  `SELECT p.id, p.sku, p.name, ps.marketplace, ps.sku AS mp_sku
   FROM product_skus ps JOIN products p ON p.id = ps.product_id
   WHERE LOWER(TRIM(ps.sku::text)) = LOWER(TRIM($1))`,
  [code]
);
const r4 = await query(
  `SELECT p.id, p.sku, p.name, b.barcode
   FROM barcodes b JOIN products p ON p.id = b.product_id
   WHERE REGEXP_REPLACE(b.barcode, '\\D', '', 'g') = '00230'`
);

console.log('=== exact barcode (case-insensitive) ===');
console.log(r1.rows);
console.log('=== exact product.sku ===');
console.log(r2.rows);
console.log('=== exact product_skus.sku ===');
console.log(r3.rows);
console.log('=== digit-only 00230 in barcodes ===');
console.log(r4.rows);
process.exit(0);
