import dotenv from 'dotenv';
import pg from 'pg';
import {
  decryptSecret,
  isEncryptedSecret,
  resetSecretsCryptoCache,
} from '../../src/utils/secretsCrypto.js';

dotenv.config({ path: '/opt/erm/server/.env' });
resetSecretsCryptoCache();

const c = new pg.Client({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});
await c.connect();

async function scan(label, sql, cfgField = 'config') {
  const r = await c.query(sql);
  let enc = 0;
  let ok = 0;
  let fail = 0;
  const fails = [];
  for (const row of r.rows) {
    const cfg = row[cfgField] || {};
    const walk = (obj, path = '') => {
      if (!obj || typeof obj !== 'object') return;
      for (const [k, v] of Object.entries(obj)) {
        const p = path ? `${path}.${k}` : k;
        if (typeof v === 'string' && isEncryptedSecret(v)) {
          enc += 1;
          try {
            decryptSecret(v);
            ok += 1;
          } catch (e) {
            fail += 1;
            if (fails.length < 25) {
              fails.push({
                id: row.id,
                name: row.name || row.code || null,
                field: p,
                err: String(e.message || e),
              });
            }
          }
        } else if (v && typeof v === 'object' && !Array.isArray(v)) {
          walk(v, p);
        }
      }
    };
    walk(cfg);
  }
  console.log(JSON.stringify({ label, rows: r.rows.length, enc, ok, fail, fails }, null, 2));
}

await scan('integrations', 'select id, code, config from integrations');
await scan('marketplace_cabinets', 'select id, name, config from marketplace_cabinets');
await scan('suppliers', 'select id, name, api_config as config from suppliers');
await scan('profiles_ai', 'select id, name, ai_settings as config from profiles');
await scan('profiles_parts', 'select id, name, partsindex_keys as config from profiles');

await c.query(`
  select column_name from information_schema.columns
  where table_schema='public' and table_name='product_marketplace_prices'
  order by ordinal_position
`).then((r) => console.log('pmp_cols', r.rows.map((x) => x.column_name).join(',')));

const pmp = await c.query(`
  select marketplace,
         count(*)::int as cnt,
         max(updated_at) as last_upd
  from product_marketplace_prices
  group by 1 order by 1
`);
console.log('pmp_by_mp', JSON.stringify(pmp.rows, null, 2));

await c.end();
