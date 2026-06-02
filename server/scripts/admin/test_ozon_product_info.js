/**
 * Usage: node scripts/admin/test_ozon_product_info.js MK-5014
 */

import integrationsService from '../../src/services/integrations.service.js';
import { query, closePool } from '../../src/config/database.js';

async function main() {
  const sku = process.argv[2] || 'MK-5014';
  const r = await query(
    `SELECT id, sku, organization_id, profile_id FROM products WHERE sku = $1 LIMIT 1`,
    [sku]
  );
  const p = r.rows?.[0];
  if (!p) {
    console.log('[Test] product not found:', sku);
    return;
  }
  console.log('[Test] product', p);
  const sk = await query(
    `SELECT marketplace, sku, marketplace_product_id FROM product_skus WHERE product_id = $1`,
    [p.id]
  );
  console.log('[Test] product_skus', sk.rows);

  try {
    const item = await integrationsService.getOzonProductInfo({
      offer_id: sku,
      organizationId: p.organization_id,
      profileId: p.profile_id
    });
    console.log('[Test] ozon ok', { id: item?.id, offer_id: item?.offer_id, name: item?.name });
  } catch (e) {
    console.log('[Test] ozon error', e.statusCode, e.message);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closePool());
