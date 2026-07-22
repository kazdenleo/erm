/**
 * One-time: WB FBS prices were stored in kopecks as rubles.
 * Safe heuristic: price looks like minor units (integer >= 1000) and
 * dividing by 100 yields a plausible order amount.
 *
 * Usage: node scripts/admin/backfill_wb_order_prices_to_rub.mjs [--dry-run]
 */
import { query } from '../../src/config/database.js';

const dryRun = process.argv.includes('--dry-run');

const stats = await query(`
  SELECT
    COUNT(*)::int AS n,
    ROUND(AVG(price)::numeric, 2) AS avg_p,
    ROUND(MIN(price)::numeric, 2) AS min_p,
    ROUND(MAX(price)::numeric, 2) AS max_p,
    COUNT(*) FILTER (WHERE price >= 1000 AND price = trunc(price))::int AS candidates
  FROM orders
  WHERE LOWER(TRIM(marketplace)) IN ('wb', 'wildberries')
    AND price IS NOT NULL
    AND price > 0
`);
console.log('before', stats.rows[0]);

if (dryRun) {
  const sample = await query(`
    SELECT id, order_id, price, ROUND(price / 100.0, 2) AS as_rub
    FROM orders
    WHERE LOWER(TRIM(marketplace)) IN ('wb', 'wildberries')
      AND price IS NOT NULL
      AND price >= 1000
      AND price = trunc(price)
    ORDER BY price DESC
    LIMIT 15
  `);
  console.log('sample', sample.rows);
  process.exit(0);
}

const upd = await query(`
  UPDATE orders
  SET price = ROUND(price / 100.0, 2),
      updated_at = CURRENT_TIMESTAMP
  WHERE LOWER(TRIM(marketplace)) IN ('wb', 'wildberries')
    AND price IS NOT NULL
    AND price >= 1000
    AND price = trunc(price)
  RETURNING id
`);
console.log('updated', upd.rowCount);

const after = await query(`
  SELECT
    COUNT(*)::int AS n,
    ROUND(AVG(price)::numeric, 2) AS avg_p,
    ROUND(MIN(price)::numeric, 2) AS min_p,
    ROUND(MAX(price)::numeric, 2) AS max_p
  FROM orders
  WHERE LOWER(TRIM(marketplace)) IN ('wb', 'wildberries')
    AND price IS NOT NULL
    AND price > 0
`);
console.log('after', after.rows[0]);
process.exit(0);
