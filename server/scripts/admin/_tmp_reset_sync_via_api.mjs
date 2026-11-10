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

const user = (await pool.query(`SELECT id, email, role, profile_id FROM users WHERE id=1`)).rows[0];
const token = jwt.sign(
  { userId: Number(user.id), email: user.email, role: user.role },
  process.env.JWT_SECRET,
  { expiresIn: '15m' }
);

function req(method, path) {
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        hostname: '127.0.0.1',
        port: Number(process.env.PORT || 3001),
        path,
        method,
        headers: { Authorization: `Bearer ${token}` },
      },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(d);
          } catch {
            /* ignore */
          }
          resolve({ status: res.statusCode, json, body: d.slice(0, 500) });
        });
      }
    );
    r.on('error', reject);
    r.end();
  });
}

console.log('before status', await req('GET', '/api/orders/sync-fbs/status'));
console.log('mp status', await req('GET', '/api/marketplace-stock/sync/status'));
console.log('reset', await req('POST', '/api/orders/sync-fbs/reset'));
console.log('after status', await req('GET', '/api/orders/sync-fbs/status'));

// integrations health for profile 1
const ints = await pool.query(
  `SELECT id, code, profile_id, organization_id,
          CASE WHEN config->>'api_key' LIKE 'enc:v1:%' THEN 'enc' ELSE 'plain_or_empty' END AS key_kind
   FROM integrations
   WHERE code IN ('ozon','wildberries','yandex')
   ORDER BY profile_id, code`
);
console.log('integrations', ints.rows);

const wh = await pool.query(
  `SELECT id, name, push_marketplace_stock, push_stock_ozon FROM warehouses WHERE id IN (1,4,5) ORDER BY id`
);
console.log('wh flags', wh.rows);

await pool.end();
