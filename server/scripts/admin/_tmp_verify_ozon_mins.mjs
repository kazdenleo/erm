import { query, closePool } from '../../src/config/database.js';
import { pushForAllProfiles } from '../../src/services/marketplaceMinPricePush.service.js';

const mins = await query(
  `SELECT p.sku, pmp.min_price, pmp.min_price_fbs, pmp.min_price_fbo
     FROM products p
     JOIN product_marketplace_prices pmp ON pmp.product_id=p.id AND pmp.marketplace='ozon'
    WHERE p.sku IN ('AN1014M','CN1293','CN1328K','AN1170','AN1217')
    ORDER BY p.sku`
);
console.log('mins', JSON.stringify(mins.rows, null, 2));

const raised = await query(
  `SELECT count(*)::int AS n
     FROM product_marketplace_prices
    WHERE marketplace='ozon'
      AND min_price_fbs IS NOT NULL
      AND min_price_fbo IS NOT NULL
      AND min_price_fbs::numeric > min_price_fbo::numeric`
);
console.log('fbs_gt_fbo', raised.rows[0]);

const push = await pushForAllProfiles();
console.log('push', JSON.stringify(push, null, 2));
await closePool();
