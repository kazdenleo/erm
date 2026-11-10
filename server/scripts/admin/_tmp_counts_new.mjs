import fs from 'fs';
import pg from 'pg';

for (const line of fs.readFileSync('/opt/erm/server/.env', 'utf8').split(/\n/)) {
  if (!line || line.startsWith('#')) continue;
  const i = line.indexOf('=');
  if (i < 0) continue;
  let v = line.slice(i + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  const k = line.slice(0, i);
  if (!(k in process.env)) process.env[k] = v;
}

const pool = new pg.Pool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

const r = await pool.query(`
  SELECT marketplace, status, COUNT(*)::int AS n
  FROM orders
  WHERE profile_id = 6
    AND status IN ('new','in_assembly','assembled','in_transit','shipped')
  GROUP BY 1, 2
  ORDER BY 1, 2
`);
console.log(JSON.stringify(r.rows, null, 2));

const health = await fetch('http://127.0.0.1:3001/api/health').then((x) => x.json());
console.log('sync', health?.services?.ordersFbsSync);

await pool.end();
