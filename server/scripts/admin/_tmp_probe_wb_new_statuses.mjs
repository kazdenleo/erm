import fs from 'fs';
import pg from 'pg';

for (const line of fs.readFileSync('/opt/erm/server/.env', 'utf8').split(/\n/)) {
  if (!line || line.startsWith('#')) continue;
  const i = line.indexOf('=');
  if (i < 0) continue;
  let v = line.slice(i + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  if (!(line.slice(0, i) in process.env)) process.env[line.slice(0, i)] = v;
}

const { decryptConfigSecrets, resetSecretsCryptoCache } = await import('../../src/utils/secretsCrypto.js');
resetSecretsCryptoCache();

const pool = new pg.Pool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

const int = (
  await pool.query(`SELECT config FROM integrations WHERE profile_id=6 AND code='wildberries' LIMIT 1`)
).rows[0];
const cfg = decryptConfigSecrets(typeof int.config === 'string' ? JSON.parse(int.config) : int.config || {});
const apiKey = cfg.api_key || cfg.apiKey;

const newRes = await fetch('https://marketplace-api.wildberries.ru/api/v3/orders/new', {
  headers: { Authorization: String(apiKey), Accept: 'application/json' },
});
const newBody = await newRes.json().catch(() => ({}));
const newOrders = Array.isArray(newBody?.orders) ? newBody.orders : [];
console.log(JSON.stringify({ newFeedStatus: newRes.status, newFeedCount: newOrders.length }));

const dbNew = await pool.query(
  `SELECT order_id, returned_to_new_at, created_at, updated_at
   FROM orders WHERE profile_id=6 AND marketplace IN ('wb','wildberries') AND status='new'
   ORDER BY created_at DESC NULLS LAST LIMIT 20`
);
const ids = dbNew.rows.map((r) => Number(r.order_id)).filter((n) => Number.isFinite(n));
console.log('db new sample', dbNew.rows.slice(0, 5));
console.log('db new count', (await pool.query(`SELECT COUNT(*)::int n FROM orders WHERE profile_id=6 AND marketplace IN ('wb','wildberries') AND status='new'`)).rows[0]);

if (ids.length) {
  const stRes = await fetch('https://marketplace-api.wildberries.ru/api/v3/orders/status', {
    method: 'POST',
    headers: {
      Authorization: String(apiKey),
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ orders: ids.slice(0, 50) }),
  });
  const stBody = await stRes.json().catch(() => ({}));
  console.log(JSON.stringify({ statusApi: stRes.status, body: stBody }).slice(0, 1500));
}

const feedIds = new Set(newOrders.map((o) => String(o.id ?? o.orderId ?? '')));
let inFeed = 0;
let notInFeed = 0;
for (const r of dbNew.rows) {
  if (feedIds.has(String(r.order_id))) inFeed++;
  else notInFeed++;
}
console.log({ sampleInFeed: inFeed, sampleNotInFeed: notInFeed });

// sync status via HTTP
import http from 'http';
import jwt from 'jsonwebtoken';
const user = (await pool.query(`SELECT id, email, role FROM users WHERE profile_id=6 ORDER BY id LIMIT 1`)).rows[0];
const token = jwt.sign({ userId: Number(user.id), email: user.email, role: user.role }, process.env.JWT_SECRET, { expiresIn: '10m' });
const status = await new Promise((resolve, reject) => {
  const r = http.request(
    { hostname: '127.0.0.1', port: 3001, path: '/api/orders/sync-fbs/status', method: 'GET', headers: { Authorization: `Bearer ${token}` } },
    (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve(JSON.parse(d)));
    }
  );
  r.on('error', reject);
  r.end();
});
console.log('sync status', JSON.stringify(status.data || status));

await pool.end();
