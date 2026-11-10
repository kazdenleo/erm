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
  try {
    const r = await c.query(sql);
    console.log(`== ${label} ==`);
    console.log(JSON.stringify(r.rows, null, 2));
  } catch (e) {
    console.log(`== ${label} ERROR ==`);
    console.log(e.message);
  }
};

await q(
  'price_tables',
  `select table_name from information_schema.tables
   where table_schema='public' and (
     table_name ilike '%price%' or table_name ilike '%tariff%' or table_name ilike '%commission%'
     or table_name ilike '%pricing%'
   ) order by 1`
);

await q(
  'products_price_cols',
  `select column_name, data_type from information_schema.columns
   where table_schema='public' and table_name='products'
     and (column_name ilike '%price%' or column_name ilike '%cost%' or column_name ilike '%strategy%'
          or column_name ilike '%markup%' or column_name ilike '%margin%')
   order by 1`
);

await q('pricing_strategies_count', 'select count(*)::int as cnt from pricing_strategies');
await q(
  'products_with_strategy',
  'select count(*)::int as with_strategy from products where pricing_strategy_id is not null'
);

const caches = [
  '/opt/erm/data/wbTariffsCache.json',
  '/opt/erm/data/ozonActionsCache.json',
  '/opt/erm/data/ozonActionProductsCache.json',
  '/opt/erm/server/data/wbTariffsCache.json',
];
for (const p of caches) {
  if (!fs.existsSync(p)) {
    console.log(`cache missing: ${p}`);
    continue;
  }
  const st = fs.statSync(p);
  console.log(`cache ${p} size=${st.size} mtime=${st.mtime.toISOString()}`);
}

await q(
  'scheduler_jobs',
  `select table_name from information_schema.tables
   where table_schema='public' and table_name ilike '%job%' order by 1`
);

await c.end();
