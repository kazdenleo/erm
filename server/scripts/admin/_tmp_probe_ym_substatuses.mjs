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
const cfg = decryptConfigSecrets(typeof int.config === 'string' ? JSON.parse(int.config) : int.config || {});
const apiKey = cfg.api_key || cfg.apiKey;
const campaignId = cfg.campaign_id || '149210464';

const dbNew = await pool.query(
  `SELECT order_id FROM orders
   WHERE profile_id=6 AND marketplace IN ('yandex','ym','yandex_market') AND status='new'`
);
const ids = [...new Set(dbNew.rows.map((r) => String(r.order_id).split(':')[0]))];

function mapYM(status, substatus) {
  const normalized = String(status || '').toUpperCase();
  const sub = String(substatus || '').toUpperCase();
  if (normalized === 'PROCESSING') {
    if (sub === 'READY_TO_SHIP' || sub === 'PACKAGING') return 'in_assembly';
    return 'new';
  }
  const map = {
    PENDING: 'new',
    UNPAID: 'new',
    PLACING: 'new',
    RESERVED: 'new',
    DELIVERY: 'in_transit',
    DELIVERED: 'delivered',
    CANCELLED: 'cancelled',
    PICKUP: 'in_transit',
  };
  return map[normalized] || normalized.toLowerCase();
}

const breakdown = {};
const rows = [];
for (const orderId of ids) {
  const res = await fetch(`https://api.partner.market.yandex.ru/campaigns/${campaignId}/orders/${orderId}`, {
    headers: { Authorization: `Bearer ${apiKey}`, 'Api-Key': String(apiKey), Accept: 'application/json' },
  });
  const json = await res.json().catch(() => ({}));
  const order = json.order || {};
  const key = `${order.status || 'http_' + res.status}/${order.substatus || '-'}`;
  breakdown[key] = (breakdown[key] || 0) + 1;
  rows.push({
    orderId,
    status: order.status,
    substatus: order.substatus,
    mapped: mapYM(order.status, order.substatus),
    wouldStayNewDueToPreventAuto: mapYM(order.status, order.substatus) === 'in_assembly',
  });
}

console.log('substatus breakdown', breakdown);
console.log(
  'would map to in_assembly (blocked by preventAutoInAssembly)',
  rows.filter((r) => r.wouldStayNewDueToPreventAuto).length
);
console.log(
  'sample',
  rows.slice(0, 12).map((r) => ({ id: r.orderId, s: r.status, sub: r.substatus, mapped: r.mapped }))
);

// Also: YM orders that API says cancelled/delivered/in_transit but DB still new? already covered.
// Check if any DB new should force-advance (delivered/cancelled/in_transit)
const advanced = rows.filter((r) => ['delivered', 'cancelled', 'in_transit', 'shipped'].includes(r.mapped));
console.log('should force advance from new', advanced);

await pool.end();
process.exit(0);
