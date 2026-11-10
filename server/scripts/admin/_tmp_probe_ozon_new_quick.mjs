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
  await pool.query(`SELECT config FROM integrations WHERE profile_id=6 AND code='ozon' LIMIT 1`)
).rows[0];
const cfg = decryptConfigSecrets(typeof int.config === 'string' ? JSON.parse(int.config) : int.config || {});
const clientId = cfg.client_id || cfg.clientId;
const apiKey = cfg.api_key || cfg.apiKey;

const dbNew = await pool.query(
  `SELECT order_id FROM orders WHERE profile_id=6 AND marketplace='ozon' AND status='new' LIMIT 20`
);
console.log('ozon db new', dbNew.rows.length);

const ids = dbNew.rows.map((r) => String(r.order_id)).slice(0, 15);
const breakdown = {};
for (const postingNumber of ids) {
  const res = await fetch('https://api-seller.ozon.ru/v3/posting/fbs/get', {
    method: 'POST',
    headers: {
      'Client-Id': String(clientId),
      'Api-Key': String(apiKey),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ posting_number: postingNumber }),
  });
  const json = await res.json().catch(() => ({}));
  const st = json?.result?.status || json?.message || `http_${res.status}`;
  breakdown[st] = (breakdown[st] || 0) + 1;
}
console.log('ozon api statuses', breakdown);

const health = await fetch('http://127.0.0.1:3001/api/health').then((r) => r.json());
console.log('sync', health?.services?.ordersFbsSync);

// try YM 404 on other campaign
const ymInt = (
  await pool.query(`SELECT config FROM integrations WHERE profile_id=6 AND code IN ('yandex','yandex_market','ym') LIMIT 1`)
).rows[0];
const ymCfg = decryptConfigSecrets(typeof ymInt.config === 'string' ? JSON.parse(ymInt.config) : ymInt.config || {});
const ymKey = ymCfg.api_key;
for (const camp of [138987159, 149210464]) {
  const r = await fetch(`https://api.partner.market.yandex.ru/campaigns/${camp}/orders/62041779202`, {
    headers: { Authorization: `Bearer ${ymKey}`, 'Api-Key': String(ymKey), Accept: 'application/json' },
  });
  const j = await r.json().catch(() => ({}));
  console.log('orphan 62041779202 camp', camp, r.status, j.order?.status, j.order?.substatus || j.errors?.[0]?.message);
}

await pool.end();
process.exit(0);
