import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config({ path: '/opt/erm/server/.env' });

const c = new pg.Client({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});
await c.connect();

const q = async (label, sql) => {
  try {
    const r = await c.query(sql);
    console.log(`== ${label} ==`);
    console.log(JSON.stringify(r.rows, null, 2));
  } catch (e) {
    console.log(`== ${label} ERROR ==`);
    console.log(e.message);
  }
};

await q('pmp_count', 'select count(*)::int as cnt from product_marketplace_prices');
await q(
  'pmp_by_mp',
  `select marketplace, count(*)::int as cnt,
          count(price)::int as with_price,
          count(min_price)::int as with_min,
          max(updated_at) as last_upd
   from product_marketplace_prices
   group by 1 order by 1`
);
await q(
  'price_changes_7d',
  `select count(*)::int as cnt, max(created_at) as last
   from marketplace_price_changes
   where created_at > now() - interval '7 days'`
);
await q('wb_commissions', 'select count(*)::int as cnt, max(updated_at) as last from wb_commissions');
await q(
  'cat_commission_cache',
  `select marketplace, count(*)::int as cnt, max(updated_at) as last
   from marketplace_category_commission_cache
   group by 1 order by 1`
);

await c.end();
