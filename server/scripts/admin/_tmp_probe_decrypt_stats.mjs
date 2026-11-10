import dotenv from 'dotenv';
import pg from 'pg';
import {
  decryptSecret,
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

async function probe(table) {
  const cols = await c.query(
    `select column_name from information_schema.columns
     where table_schema='public' and table_name=$1 order by ordinal_position`,
    [table]
  );
  const names = cols.rows.map((r) => r.column_name);
  if (!names.includes('config')) {
    console.log(JSON.stringify({ table, skip: true, reason: 'no config column', cols: names }));
    return;
  }
  const idCols = ['id', 'profile_id', 'marketplace', 'type', 'provider', 'name'].filter((x) =>
    names.includes(x)
  );
  const select = [...idCols, 'config'].join(', ');
  const r = await c.query(`select ${select} from ${table}`);
  let enc = 0;
  let ok = 0;
  let fail = 0;
  let plain = 0;
  const fails = [];
  const okBy = {};
  for (const row of r.rows) {
    const cfg = row.config || {};
    for (const [k, v] of Object.entries(cfg)) {
      if (typeof v !== 'string' || !v) continue;
      if (!SECRET_CONFIG_KEYS.includes(k) && !isEncryptedSecret(v)) continue;
      if (!isEncryptedSecret(v)) {
        plain += 1;
        continue;
      }
      enc += 1;
      try {
        decryptSecret(v);
        ok += 1;
        okBy[k] = (okBy[k] || 0) + 1;
      } catch (e) {
        fail += 1;
        if (fails.length < 20) {
          fails.push({
            table,
            id: row.id,
            profile_id: row.profile_id,
            marketplace: row.marketplace,
            type: row.type,
            field: k,
            err: String(e.message || e),
          });
        }
      }
    }
  }
  console.log(
    JSON.stringify({ table, rows: r.rows.length, enc, ok, fail, plain, okBy, sampleFails: fails }, null, 2)
  );
}

for (const t of ['integrations', 'marketplace_cabinets', 'suppliers', 'organizations']) {
  try {
    await probe(t);
  } catch (e) {
    console.log(JSON.stringify({ table: t, error: e.message }));
  }
}

console.log(
  JSON.stringify({
    hasPrimary: Boolean(String(process.env.SECRETS_ENCRYPTION_KEY || '').trim()),
    hasPrevious: Boolean(String(process.env.SECRETS_ENCRYPTION_KEY_PREVIOUS || '').trim()),
    primaryLen: String(process.env.SECRETS_ENCRYPTION_KEY || '').trim().length,
    previousLen: String(process.env.SECRETS_ENCRYPTION_KEY_PREVIOUS || '').trim().length,
  })
);

await c.end();
