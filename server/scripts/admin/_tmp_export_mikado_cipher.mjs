import fs from 'fs';
import pg from 'pg';

for (const line of fs.readFileSync('/opt/erm/server/.env', 'utf8').split(/\n/)) {
  if (!line || line.startsWith('#')) continue;
  const i = line.indexOf('=');
  if (i < 0) continue;
  const k = line.slice(0, i);
  let v = line.slice(i + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  if (!(k in process.env)) process.env[k] = v;
}

const pool = new pg.Pool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

const r = await pool.query(
  `SELECT config->>'password' AS p FROM integrations WHERE code='mikado' AND profile_id=1 LIMIT 1`
);
const cipher = r.rows[0]?.p || '';
fs.writeFileSync('/tmp/mikado_pw.cipher', cipher);
console.log(JSON.stringify({ wrote: cipher.length, prefix: cipher.slice(0, 8) }));
await pool.end();
