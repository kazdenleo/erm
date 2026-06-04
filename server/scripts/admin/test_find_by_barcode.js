/**
 * node scripts/admin/test_find_by_barcode.js DT-00229
 */
import repositoryFactory from '../../src/config/repository-factory.js';
import { query } from '../../src/config/database.js';

const code = process.argv[2] || 'DT-00229';
const digits = code.replace(/\D/g, '');

const repo = repositoryFactory.getProductsRepository();
const product = await repo.findByBarcode(code);
console.log('findByBarcode:', product?.id, product?.sku, product?.name);

const fuzzy = await query(
  `SELECT DISTINCT p.id, p.sku, p.name
   FROM products p
   WHERE COALESCE(p.is_archived, false) = false
     AND (
       p.name ILIKE $1 OR p.sku ILIKE $1
       OR EXISTS (SELECT 1 FROM barcodes bc WHERE bc.product_id = p.id AND bc.barcode ILIKE $1)
     )
   ORDER BY p.id LIMIT 10`,
  [`%${code}%`]
);
console.log('ILIKE search matches:', fuzzy.rows);

if (digits) {
  const dig = await query(
    `SELECT p.id, p.sku, p.name, b.barcode
     FROM barcodes b JOIN products p ON p.id = b.product_id
     WHERE REGEXP_REPLACE(b.barcode, '\\D', '', 'g') = $1
     ORDER BY b.id LIMIT 10`,
    [digits]
  );
  console.log(`digit-only ${digits}:`, dig.rows);
}

process.exit(0);
