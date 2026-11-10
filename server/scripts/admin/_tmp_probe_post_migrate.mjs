import dotenv from 'dotenv';
import pg from 'pg';
import fs from 'fs';

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
  const r = await c.query(sql);
  console.log(`== ${label} ==`);
  console.log(JSON.stringify(r.rows, null, 2));
};

await q('profiles', 'select * from profiles order by id limit 20');
await q(
  'integrations_cols',
  `select column_name from information_schema.columns
   where table_schema='public' and table_name='integrations' order by ordinal_position`
);
await q('integrations_sample', 'select * from integrations order by id limit 5');
await q(
  'pricing_strategies',
  `select column_name from information_schema.columns
   where table_schema='public' and table_name='pricing_strategies' order by ordinal_position`
);
try {
  await q('strategies_rows', 'select * from pricing_strategies order by id limit 50');
} catch (e) {
  console.log('strategies_rows error', e.message);
}
try {
  await q(
    'with_strategy',
    'select count(*)::int as with_strategy from products where pricing_strategy_id is not null'
  );
} catch (e) {
  console.log('with_strategy error', e.message);
}
await q(
  'product_price_cols',
  `select column_name from information_schema.columns
   where table_schema='public' and table_name='products' and column_name ilike '%price%'
   order by 1`
);
await q(
  'orders_cols',
  `select column_name from information_schema.columns
   where table_schema='public' and table_name='orders'
   and column_name in ('marketplace','created_at','status','source')
   order by 1`
);
try {
  await q(
    'orders_3d',
    `select count(*)::int as cnt, max(created_at) as last_created
     from orders where created_at > now() - interval '3 days'`
  );
} catch (e) {
  console.log('orders_3d error', e.message);
}

await c.end();

const tokenPath = '/opt/erm/data/tokenStatusCache.json';
if (fs.existsSync(tokenPath)) {
  console.log('== tokenStatusCache ==');
  console.log(fs.readFileSync(tokenPath, 'utf8'));
}
