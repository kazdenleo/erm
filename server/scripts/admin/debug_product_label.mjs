import { writeFileSync } from 'fs';
import { query } from '../../src/config/database.js';
import productLabelsService from '../../src/services/productLabels.service.js';

const sku = process.argv[2] || '601650475';
const pr = await query(
  `SELECT p.id, p.sku, p.name, p.user_category_id, p.product_type, p.profile_id
   FROM products p WHERE p.sku = $1 LIMIT 1`,
  [sku]
);
const product = pr.rows[0];
if (!product) {
  console.log('Product not found for sku', sku);
  process.exit(1);
}
console.log('Product:', product.id, product.sku, product.name?.slice(0, 60));

const tpl = await productLabelsService.getTemplateForProduct(
  { user_category_id: product.user_category_id, profile_id: product.profile_id },
  product.profile_id
);
writeFileSync('debug-template.json', JSON.stringify(tpl, null, 2));
console.log('Template written to debug-template.json');

const result = await productLabelsService.renderProductLabel(product.id, {
  format: 'png',
  profileId: product.profile_id,
});
const out = `debug-label-${product.id}.png`;
writeFileSync(out, result.buffer);
console.log('Saved', out, result.widthMm, 'x', result.heightMm, 'mm', result.buffer.length, 'bytes');
