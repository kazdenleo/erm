import pricesService from '../../src/services/prices.service.js';
import { query, closePool } from '../../src/config/database.js';
import { clearOzonFbsLogisticsLearnedCache, loadOzonFbsLogisticsLearned } from '../../src/utils/ozonLogisticsLearning.js';

clearOzonFbsLogisticsLearnedCache();
const learned = await loadOzonFbsLogisticsLearned({ force: true });
console.log(
  JSON.stringify(
    {
      products: learned.byProductId.size,
      buckets: learned.byVolumeBucket.size,
      an1014m: learned.byProductId.get('51'),
      bucket45: learned.byVolumeBucket.get('4.5'),
    },
    null,
    2
  )
);

const before = await query(
  `SELECT p.sku, pmp.min_price, pmp.min_price_fbs, pmp.min_price_fbo
     FROM products p
     JOIN product_marketplace_prices pmp ON pmp.product_id=p.id AND pmp.marketplace='ozon'
    WHERE p.sku IN ('AN1014M','CN1293','CN1328K','AN1170','AN1217')
    ORDER BY p.sku`
);
console.log('before', JSON.stringify(before.rows, null, 2));

// Recalc from cache for these products
for (const row of before.rows) {
  const id = (
    await query(`SELECT id FROM products WHERE sku=$1`, [row.sku])
  ).rows[0].id;
  const r = await pricesService.recalculateAndSaveForProduct(id, {
    useCalculatorCache: true,
    skipMinPricePush: true,
    skipBuyoutSync: true,
  });
  console.log('recalc', row.sku, JSON.stringify(r || null));
}

const after = await query(
  `SELECT p.sku, pmp.min_price, pmp.min_price_fbs, pmp.min_price_fbo,
          c.calculator->>'logistics_cost' AS log_cost,
          c.calculator->>'logistics_cost_api' AS log_api,
          c.calculator->'logistics_learned' AS learned
     FROM products p
     JOIN product_marketplace_prices pmp ON pmp.product_id=p.id AND pmp.marketplace='ozon'
     LEFT JOIN product_mp_calculator_cache c ON c.product_id=p.id AND c.marketplace='ozon'
    WHERE p.sku IN ('AN1014M','CN1293','CN1328K','AN1170','AN1217')
    ORDER BY p.sku`
);
console.log('after', JSON.stringify(after.rows, null, 2));
await closePool();
