/**
 * Безопасное сжатие раздутых таблиц (без удаления бизнес-данных).
 * Запускать в окне низкой нагрузки: VACUUM FULL кратко блокирует таблицу.
 *
 *   cd server && node scripts/admin/vacuum_storage_safe.mjs
 */
import dotenv from 'dotenv';
dotenv.config();
import pg from 'pg';

const pool = new pg.Pool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

async function sizeOf(table) {
  const r = await pool.query(
    `SELECT pg_size_pretty(pg_total_relation_size($1::regclass)) AS sz,
            pg_total_relation_size($1::regclass)::bigint AS bytes`,
    [table]
  );
  return r.rows[0];
}

async function run(label, sql) {
  const t0 = Date.now();
  console.log(`>> ${label}`);
  await pool.query(sql);
  console.log(`   done in ${Date.now() - t0}ms`);
}

const beforeDb = await pool.query(
  `SELECT pg_size_pretty(pg_database_size(current_database())) AS db`
);
console.log('DB before', beforeDb.rows[0].db);

const targets = [
  'marketplace_reviews',
  'products',
  'cache_entries',
  'marketplace_fbo_report_lines',
  'marketplace_fbs_report_lines',
];

for (const table of targets) {
  const before = await sizeOf(table);
  console.log(`\n${table}: ${before.sz}`);
  // FULL — вернуть место на диск после UPDATE/DELETE; ANALYZE — обновить статистику планировщика
  await run(`VACUUM (FULL, ANALYZE) ${table}`, `VACUUM (FULL, ANALYZE) ${table}`);
  const after = await sizeOf(table);
  console.log(`${table}: ${before.sz} -> ${after.sz}`);
}

// orders: без FULL (долгая блокировка); обычный VACUUM чистит dead tuples
{
  const before = await sizeOf('orders');
  console.log(`\norders: ${before.sz}`);
  await run('VACUUM (ANALYZE) orders', 'VACUUM (ANALYZE) orders');
  const after = await sizeOf('orders');
  console.log(`orders: ${before.sz} -> ${after.sz}`);
}

const deleted = await pool.query(`
  DELETE FROM cache_entries
  WHERE expires_at IS NOT NULL AND expires_at <= NOW()
  RETURNING id
`);
console.log(`\ncache expired deleted: ${deleted.rowCount}`);

const afterDb = await pool.query(
  `SELECT pg_size_pretty(pg_database_size(current_database())) AS db`
);
console.log('\nDB after', afterDb.rows[0].db);
await pool.end();
