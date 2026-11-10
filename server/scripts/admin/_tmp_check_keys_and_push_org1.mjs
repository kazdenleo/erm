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
  `SELECT id, code, profile_id, organization_id, config FROM integrations WHERE code IN ('ozon','wildberries','yandex') ORDER BY profile_id, code`
);

for (const row of ints.rows) {
  const cfg = decryptConfigSecrets(
    typeof row.config === 'string' ? JSON.parse(row.config) : row.config || {}
  );
  const clientId = cfg.client_id ?? cfg.clientId ?? null;
  const apiKey = cfg.api_key ?? cfg.apiKey ?? null;
  const report = {
    id: row.id,
    code: row.code,
    profile_id: row.profile_id,
    organization_id: row.organization_id,
    apiKeyLen: apiKey ? String(apiKey).length : 0,
    stillEnc: String(apiKey || '').startsWith('enc:v1:'),
  };

  try {
    if (row.code === 'ozon' && clientId && apiKey && !report.stillEnc) {
      const res = await fetch('https://api-seller.ozon.ru/v2/warehouse/list', {
        method: 'POST',
        headers: {
          'Client-Id': String(clientId),
          'Api-Key': String(apiKey),
          'Content-Type': 'application/json',
        },
        body: '{}',
      });
      report.ping = res.status;
      report.pingBody = (await res.text()).slice(0, 120);
    } else if (row.code === 'wildberries' && apiKey && !report.stillEnc) {
      const res = await fetch('https://marketplace-api.wildberries.ru/api/v3/warehouses', {
        method: 'GET',
        headers: { Authorization: String(apiKey), Accept: 'application/json' },
      });
      report.ping = res.status;
      report.pingBody = (await res.text()).slice(0, 120);
    } else if (row.code === 'yandex' && apiKey && !report.stillEnc) {
      const res = await fetch('https://api.partner.market.yandex.ru/v2/campaigns', {
        method: 'GET',
        headers: { 'Api-Key': String(apiKey), Accept: 'application/json' },
      });
      report.ping = res.status;
      report.pingBody = (await res.text()).slice(0, 120);
    }
  } catch (e) {
    report.pingErr = e.message;
  }
  console.log(JSON.stringify(report));
}

const user = (await pool.query(`SELECT id, email, role FROM users WHERE id=1`)).rows[0];
const token = jwt.sign(
  { userId: Number(user.id), email: user.email, role: user.role },
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
          resolve({ status: res.statusCode, json });
        });
      }
    );
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

// Push for Autolyubitel org 1 only, with many product ids so it goes background
const ids = (
  await pool.query(`SELECT id FROM products WHERE profile_id=1 ORDER BY id LIMIT 200`)
).rows.map((r) => Number(r.id));
console.log('org1 products', ids.length);
const push = await req('POST', '/api/marketplace-stock/sync', {
  organizationId: 1,
  productIds: ids,
  force: true,
});
console.log('push', push.status, push.json);

await pool.end();
