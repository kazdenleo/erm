import { query, closePool } from '../../src/config/database.js';
import { pushForProduct } from '../../src/services/marketplaceMinPricePush.service.js';

const res = await query(
  `SELECT DISTINCT product_id FROM product_mp_calculator_cache WHERE marketplace = 'wb' ORDER BY product_id`
);
const ids = (res.rows || []).map((r) => Number(r.product_id)).filter((n) => n > 0);
console.log('push WB', ids.length);
let pushed = 0;
let failed = 0;
for (const productId of ids) {
  try {
    await pushForProduct(productId, { marketplaces: ['wb'] });
    pushed++;
    if (pushed % 100 === 0) console.log('progress', pushed);
  } catch (e) {
    failed++;
    console.error('fail', productId, e?.message || e);
  }
}
const kn = await query(
  `SELECT min_price, min_price_fbo, min_price_fbs, updated_at FROM product_marketplace_prices WHERE product_id = 187 AND marketplace = 'wb'`
);
const cache = await query(
  `SELECT calculator->>'logistics_cost_fbo' AS log_fbo, calculator->>'logistics_localization_index' AS il
     FROM product_mp_calculator_cache WHERE product_id = 187 AND marketplace = 'wb'`
);
console.log('done', { pushed, failed, kn: kn.rows[0], cache: cache.rows[0] });
await closePool();
