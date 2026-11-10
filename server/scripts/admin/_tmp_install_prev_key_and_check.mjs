import fs from 'fs';
import pg from 'pg';
import path from 'path';

const envPath = '/opt/erm/server/.env';
const envText = fs.readFileSync(envPath, 'utf8');
const env = {};
for (const line of envText.split(/\n/)) {
  if (!line || line.startsWith('#')) continue;
  const i = line.indexOf('=');
  if (i < 0) continue;
  let v = line.slice(i + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  env[line.slice(0, i)] = v;
  if (!(line.slice(0, i) in process.env)) process.env[line.slice(0, i)] = v;
}

const bakDir = '/opt/erm/server';
const baks = fs
  .readdirSync(bakDir)
  .filter((f) => f.startsWith('.env.bak.secrets.'))
  .map((f) => ({ f, m: fs.statSync(path.join(bakDir, f)).mtimeMs }))
  .sort((a, b) => b.m - a.m);

if (baks.length) {
  const bakPath = path.join(bakDir, baks[0].f);
  const bakText = fs.readFileSync(bakPath, 'utf8');
  let prev = '';
  for (const line of bakText.split(/\n/)) {
    if (line.startsWith('SECRETS_ENCRYPTION_KEY=')) {
      prev = line.slice('SECRETS_ENCRYPTION_KEY='.length).trim();
      break;
    }
  }
  const cur = String(env.SECRETS_ENCRYPTION_KEY || '').trim();
  if (prev && prev !== cur) {
    let next = envText;
    if (/^SECRETS_ENCRYPTION_KEY_PREVIOUS=/m.test(next)) {
      next = next.replace(/^SECRETS_ENCRYPTION_KEY_PREVIOUS=.*$/m, `SECRETS_ENCRYPTION_KEY_PREVIOUS=${prev}`);
    } else {
      next = `${next.replace(/\s*$/, '')}\nSECRETS_ENCRYPTION_KEY_PREVIOUS=${prev}\n`;
    }
    fs.writeFileSync(envPath, next);
    process.env.SECRETS_ENCRYPTION_KEY_PREVIOUS = prev;
    console.log(JSON.stringify({ previousInstalled: true, prevLen: prev.length, from: baks[0].f }));
  } else {
    console.log(JSON.stringify({ previousInstalled: false, reason: 'same_or_empty' }));
  }
} else {
  console.log(JSON.stringify({ previousInstalled: false, reason: 'no_bak' }));
}

const { decryptSecret, resetSecretsCryptoCache } = await import('../../src/utils/secretsCrypto.js');
resetSecretsCryptoCache();

const pool = new pg.Pool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

const r = await pool.query(
  `SELECT id, code, profile_id, config->>'api_key' AS api_key
   FROM integrations
   WHERE config->>'api_key' LIKE 'enc:v1:%'
   ORDER BY id`
);
let ok = 0;
let fail = 0;
for (const row of r.rows) {
  try {
    decryptSecret(row.api_key);
    ok += 1;
    console.log(JSON.stringify({ id: row.id, code: row.code, profile: row.profile_id, decrypt: 'ok' }));
  } catch {
    fail += 1;
    console.log(JSON.stringify({ id: row.id, code: row.code, profile: row.profile_id, decrypt: 'fail' }));
  }
}
console.log(JSON.stringify({ ok, fail }));
await pool.end();
