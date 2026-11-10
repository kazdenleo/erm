import fs from 'fs';
import http from 'http';
import jwt from 'jsonwebtoken';
import pg from 'pg';

for (const line of fs.readFileSync('/opt/erm/server/.env', 'utf8').split(/\n/)) {
  if (!line || line.startsWith('#')) continue;
  const i = line.indexOf('=');
  if (i < 0) continue;
  let v = line.slice(i + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  if (!(line.slice(0, i) in process.env)) process.env[line.slice(0, i)] = v;
}

const pool = new pg.Pool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});
const u = (await pool.query('SELECT id, email, role FROM users WHERE id=1')).rows[0];
const token = jwt.sign(
  { userId: Number(u.id), email: u.email, role: u.role },
  process.env.JWT_SECRET,
  { expiresIn: '5m' }
);

function get(path) {
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        hostname: '127.0.0.1',
        port: 3001,
        path,
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve({ status: res.statusCode, body: d.slice(0, 220) }));
      }
    );
    r.on('error', reject);
    r.end();
  });
}

for (const p of [
  '/api/integrations/marketplaces/wildberries/warehouses?organizationId=1',
  '/api/integrations/marketplaces/ozon/warehouses?organizationId=1',
]) {
  const res = await get(p);
  console.log(JSON.stringify({ path: p, status: res.status, body: res.body }));
}
await pool.end();
