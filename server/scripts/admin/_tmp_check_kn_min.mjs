import { query, closePool } from '../../src/config/database.js';

const price = await query(
  `SELECT min_price, min_price_fbo, min_price_fbs, updated_at,
          calculation_details->>'logistics_cost_fbo' AS log_fbo,
          calculation_details->>'logistics_localization_index' AS il
     FROM product_marketplace_prices
    WHERE product_id = 187 AND marketplace = 'wb'`
);
const cache = await query(
  `SELECT calculator->>'logistics_cost_fbo' AS log_fbo,
          calculator->>'logistics_localization_index' AS il
     FROM product_mp_calculator_cache
    WHERE product_id = 187 AND marketplace = 'wb'`
);
console.log(JSON.stringify({ price: price.rows[0], cache: cache.rows[0] }, null, 2));
await closePool();
