/**
 * Probe kits / products related to TG-5101..5103
 */
import { query, closePool } from '../../src/config/database.js';

async function main() {
  const products = await query(
    `SELECT id, sku, name, product_type
     FROM products
     WHERE sku ILIKE ANY(ARRAY['%5101%','%5102%','%5103%','%TG-510%'])
        OR name ILIKE ANY(ARRAY['%5101%','%5102%','%5103%'])
     ORDER BY sku
     LIMIT 50`
  );
  console.log('products', JSON.stringify(products.rows, null, 2));

  const comps = await query(
    `SELECT kc.kit_product_id, k.sku AS kit_sku, c.sku AS comp_sku, kc.quantity
     FROM kit_components kc
     JOIN products k ON k.id = kc.kit_product_id
     JOIN products c ON c.id = kc.component_product_id
     WHERE c.sku ILIKE ANY(ARRAY['TG-5101','TG-5102','TG-5103','%5101%','%5103%'])
        OR k.sku ILIKE ANY(ARRAY['%5101%','%5102%','%5103%'])
     ORDER BY k.sku, c.sku`
  );
  console.log('kit links', JSON.stringify(comps.rows, null, 2));
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closePool());
