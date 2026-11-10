import 'dotenv/config';
import pg from 'pg';

const c = new pg.Client({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME || 'erp_system',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD,
});
await c.connect();
const a = await c.query(`select count(*)::int n from orders where archived_at is null`);
const b = await c.query(
  `select count(*)::int n from orders where marketplace='ozon' and status='new' and archived_at is null`
);
const d = await c.query(`
  select profile_id, count(*)::int n
  from orders
  where marketplace='ozon' and created_at > now() - interval '2 hours'
  group by 1 order by 1
`);
const e = await c.query(`
  select pid, now()-query_start as age, state, left(query,160) as q
  from pg_stat_activity
  where state <> 'idle' and query not like '%pg_stat%'
  order by query_start nulls last
`);
const f = await c.query(`
  select profile_id, order_id, status, created_at
  from orders
  where marketplace='ozon' and archived_at is null
  order by created_at desc nulls last
  limit 15
`);
console.log(
  JSON.stringify(
    {
      total: a.rows[0].n,
      ozonNew: b.rows[0].n,
      ozonLast2h: d.rows,
      active: e.rows,
      latestOzon: f.rows,
    },
    null,
    2
  )
);
await c.end();
