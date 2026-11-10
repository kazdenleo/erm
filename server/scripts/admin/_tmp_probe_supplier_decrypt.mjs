import dotenv from 'dotenv';
import pg from 'pg';
import {
  decryptConfigSecrets,
  isEncryptedSecret,
  resetSecretsCryptoCache,
  SECRET_CONFIG_KEYS,
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

const r = await c.query('select id, name, api_config from suppliers');
let enc = 0;
let ok = 0;
let fail = 0;
let plain = 0;
const fails = [];
for (const row of r.rows) {
  const cfg = row.api_config || {};
  for (const [k, v] of Object.entries(cfg)) {
    if (typeof v !== 'string' || !v) continue;
    if (!isEncryptedSecret(v)) {
      if (SECRET_CONFIG_KEYS.includes(k)) plain += 1;
      continue;
    }
    enc += 1;
    try {
      decryptConfigSecrets({ [k]: v });
      ok += 1;
    } catch (e) {
      fail += 1;
      fails.push({ id: row.id, name: row.name, field: k, err: String(e.message || e) });
    }
  }
}
console.log(JSON.stringify({ rows: r.rows.length, enc, ok, fail, plain, fails }, null, 2));
await c.end();
