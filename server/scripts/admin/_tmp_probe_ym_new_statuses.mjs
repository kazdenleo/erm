/**
 * Сверить YM «new» в БД с реальными статусами Яндекс.Маркета (Док Трейд, profile 6).
 */
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
  await pool.query(`SELECT config FROM integrations WHERE profile_id=6 AND code IN ('yandex','yandex_market','ym') LIMIT 1`)
).rows[0];
if (!int) {
  console.log('no yandex integration');
  process.exit(1);
}
const cfg = decryptConfigSecrets(typeof int.config === 'string' ? JSON.parse(int.config) : int.config || {});
const apiKey = cfg.api_key || cfg.apiKey || cfg.token || cfg.oauth_token;
const campaignId = cfg.campaign_id || cfg.campaignId || cfg.business_id || cfg.businessId;
console.log(
  JSON.stringify({
    hasKey: Boolean(apiKey),
    keyLen: apiKey ? String(apiKey).length : 0,
    campaignId,
    cfgKeys: Object.keys(cfg),
  })
);

const dbNew = await pool.query(
  `SELECT order_id, status, updated_at, created_at
   FROM orders
   WHERE profile_id=6 AND marketplace IN ('yandex','ym','yandex_market') AND status='new'
   ORDER BY updated_at DESC NULLS LAST`
);
console.log('db new count', dbNew.rows.length);
console.log(
  'db new sample',
  dbNew.rows.slice(0, 8).map((r) => ({ id: r.order_id, upd: r.updated_at }))
);

const ids = dbNew.rows.map((r) => String(r.order_id).split(':')[0]).filter(Boolean);
const uniqueIds = [...new Set(ids)].slice(0, 30);

async function ymGet(path) {
  const url = `https://api.partner.market.yandex.ru${path}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Api-Key': String(apiKey),
      Accept: 'application/json',
    },
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 300) };
  }
  return { status: res.status, json };
}

// ping campaigns
const camps = await ymGet('/campaigns');
console.log('campaigns', camps.status, {
  err: camps.json?.errors || camps.json?.error || camps.json?.message,
  n: camps.json?.campaigns?.length,
  ids: (camps.json?.campaigns || []).slice(0, 5).map((c) => c.id),
});

const camp =
  campaignId ||
  camps.json?.campaigns?.[0]?.id ||
  null;
console.log('using campaign', camp);

const statusBreakdown = {};
const mismatches = [];
for (const orderId of uniqueIds) {
  const r = await ymGet(`/campaigns/${camp}/orders/${orderId}`);
  const order = r.json?.order || r.json?.result?.order || null;
  const st = order?.status || order?.substatus || r.json?.errors?.[0]?.message || `http_${r.status}`;
  statusBreakdown[st] = (statusBreakdown[st] || 0) + 1;
  if (String(st).toUpperCase() !== 'PROCESSING' && String(st).toLowerCase() !== 'new') {
    mismatches.push({
      orderId,
      status: order?.status,
      substatus: order?.substatus,
      http: r.status,
    });
  }
}

console.log('ym api status breakdown (sample)', statusBreakdown);
console.log('non-processing/new from API', mismatches.slice(0, 15));
console.log('mismatch count', mismatches.length, 'of', uniqueIds.length);

// also check sync lock
const health = await fetch('http://127.0.0.1:3001/api/health').then((r) => r.json());
console.log('ordersFbsSync', health?.services?.ordersFbsSync);

await pool.end();
process.exit(0);
