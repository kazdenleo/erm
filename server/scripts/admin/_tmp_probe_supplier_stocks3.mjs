import { query, closePool } from '../../src/config/database.js';

const byProfile = await query(`
  SELECT profile_id, count(*)::int AS products
  FROM products
  GROUP BY profile_id
  ORDER BY profile_id NULLS LAST
`);
console.log('products by profile', byProfile.rows);

const stocksByProfile = await query(`
  SELECT p.profile_id,
         s.code,
         count(*)::int AS rows,
         count(*) FILTER (WHERE ss.stock > 0)::int AS with_stock,
         max(ss.updated_at) AS last_upd
  FROM supplier_stocks ss
  JOIN products p ON p.id = ss.product_id
  JOIN suppliers s ON s.id = ss.supplier_id
  GROUP BY p.profile_id, s.code
  ORDER BY p.profile_id, s.code
`);
console.log('stocks by product profile', stocksByProfile.rows);

const p6fresh = await query(`
  SELECT count(*)::int AS n, max(ss.updated_at) AS last_upd
  FROM supplier_stocks ss
  JOIN products p ON p.id = ss.product_id
  WHERE p.profile_id = 6 AND ss.updated_at > now() - interval '1 day'
`);
console.log('profile6 stocks updated last day', p6fresh.rows);

const p1fresh = await query(`
  SELECT count(*)::int AS n, max(ss.updated_at) AS last_upd
  FROM supplier_stocks ss
  JOIN products p ON p.id = ss.product_id
  WHERE p.profile_id = 1 AND ss.updated_at > now() - interval '1 hour'
`);
console.log('profile1 stocks updated last hour', p1fresh.rows);

await closePool();
