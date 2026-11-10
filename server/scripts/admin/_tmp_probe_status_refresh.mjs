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

const { decryptConfigSecrets, resetSecretsCryptoCache } = await import('../../src/utils/secretsCrypto.js');
resetSecretsCryptoCache();

const pool = new pg.Pool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

const ints = await pool.query(
  `SELECT id, code, profile_id, organization_id, updated_at, config
   FROM integrations WHERE code IN ('ozon','wildberries','yandex') ORDER BY profile_id, code`
);
for (const row of ints.rows) {
  const cfg = decryptConfigSecrets(
    typeof row.config === 'string' ? JSON.parse(row.config) : row.config || {}
  );
  const apiKey = cfg.api_key ?? cfg.apiKey ?? null;
  const clientId = cfg.client_id ?? cfg.clientId ?? null;
  const out = {
    id: row.id,
    code: row.code,
    profile_id: row.profile_id,
    updated_at: row.updated_at,
    keyLen: apiKey ? String(apiKey).length : 0,
  };
  try {
    if (row.code === 'ozon' && clientId && apiKey) {
      const res = await fetch('https://api-seller.ozon.ru/v2/warehouse/list', {
        method: 'POST',
        headers: {
          'Client-Id': String(clientId),
          'Api-Key': String(apiKey),
          'Content-Type': 'application/json',
        },
        body: '{}',
      });
      out.ping = res.status;
      out.body = (await res.text()).slice(0, 100);
    } else if (row.code === 'wildberries' && apiKey) {
      const res = await fetch('https://marketplace-api.wildberries.ru/api/v3/orders/new', {
        method: 'GET',
        headers: { Authorization: String(apiKey), Accept: 'application/json' },
      });
      out.ping = res.status;
      out.body = (await res.text()).slice(0, 120);
    } else if (row.code === 'yandex' && apiKey) {
      const res = await fetch('https://api.partner.market.yandex.ru/v2/campaigns', {
        method: 'GET',
        headers: { 'Api-Key': String(apiKey), Accept: 'application/json' },
      });
      out.ping = res.status;
      out.body = (await res.text()).slice(0, 100);
    }
  } catch (e) {
    out.err = e.message;
  }
  console.log(JSON.stringify(out));
}

console.log(
  'new by profile/mp',
  (
    await pool.query(
      `SELECT COALESCE(profile_id::text,'?') AS profile_id, marketplace, COUNT(*)::int n
       FROM orders WHERE status='new'
       GROUP BY 1,2 ORDER BY 1,2`
    )
  ).rows
);

console.log(
  'sample new',
  (
    await pool.query(
      `SELECT id, marketplace, marketplace_order_id, status, profile_id, organization_id, created_at, updated_at
       FROM orders WHERE status='new'
       ORDER BY created_at DESC NULLS LAST LIMIT 12`
    )
  ).rows
);

// Find a Dok Trade user for auth
const users = await pool.query(
  `SELECT id, email, role, profile_id FROM users WHERE profile_id IN (1,6) ORDER BY profile_id, id`
);
console.log(
  'users',
  users.rows.map((u) => ({ id: u.id, email: u.email, profile_id: u.profile_id, role: u.role }))
);

const dtUser = users.rows.find((u) => String(u.profile_id) === '6') || users.rows[0];
const token = jwt.sign(
  { userId: Number(dtUser.id), email: dtUser.email, role: dtUser.role },
  process.env.JWT_SECRET,
  { expiresIn: '30m' }
);

function req(method, path, bodyObj) {
  const body = bodyObj ? JSON.stringify(bodyObj) : null;
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        hostname: '127.0.0.1',
        port: Number(process.env.PORT || 3001),
        path,
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
            : {}),
        },
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
          resolve({ status: res.statusCode, json, body: d.slice(0, 400) });
        });
      }
    );
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

console.log('auth as', { id: dtUser.id, profile_id: dtUser.profile_id, email: dtUser.email });
console.log('before', await req('GET', '/api/orders/sync-fbs/status'));
console.log(
  'start refresh',
  await req('POST', '/api/orders/sync-fbs?refreshStatuses=1&daysBack=14', {
    refreshStatuses: true,
    daysBack: 14,
  })
);

for (let i = 0; i < 90; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const st = await req('GET', '/api/orders/sync-fbs/status');
  const d = st.json?.data || {};
  console.log(
    'tick',
    i,
    d.inProgress,
    d.lastSyncError || null,
    d.lastSyncResult
      ? {
          ozon: d.lastSyncResult.ozon?.success,
          wb: d.lastSyncResult.wildberries?.success,
          ym: d.lastSyncResult.yandex?.success,
          ozonFail: d.lastSyncResult.ozon?.failed,
          wbFail: d.lastSyncResult.wildberries?.failed,
          ymFail: d.lastSyncResult.yandex?.failed,
        }
      : null
  );
  if (!d.inProgress && i > 0) break;
}

console.log(
  'new after',
  (
    await pool.query(
      `SELECT COALESCE(profile_id::text,'?') AS profile_id, marketplace, status, COUNT(*)::int n
       FROM orders
       WHERE COALESCE(created_at, updated_at) > NOW() - INTERVAL '14 days'
       GROUP BY 1,2,3
       ORDER BY 1,2,3`
    )
  ).rows
);

await pool.end();
