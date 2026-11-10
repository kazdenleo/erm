import fs from 'fs';
import pg from 'pg';

for (const line of fs.readFileSync('/opt/erm/server/.env', 'utf8').split(/\n/)) {
  if (!line || line.startsWith('#')) continue;
  const i = line.indexOf('=');
  if (i < 0) continue;
  const k = line.slice(0, i);
  let v = line.slice(i + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  if (!(k in process.env)) process.env[k] = v;
}

const { decryptSecret } = await import('../../src/utils/secretsCrypto.js');
const pool = new pg.Pool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

const key = String(process.env.SECRETS_ENCRYPTION_KEY || '').trim();
console.log(JSON.stringify({ secretsKeyLen: key.length, jwtLen: String(process.env.JWT_SECRET || '').length }));

const r = await pool.query(
  `SELECT code, config
   FROM integrations
   WHERE profile_id = 1 AND code IN ('mikado', 'moskvorechie')
   ORDER BY code`
);

for (const row of r.rows) {
  const cfg = typeof row.config === 'string' ? JSON.parse(row.config) : row.config || {};
  const report = { code: row.code };
  for (const [k, v] of Object.entries(cfg)) {
    if (typeof v !== 'string' || !v) continue;
    if (v.startsWith('enc:v1:')) {
      try {
        const plain = decryptSecret(v);
        report[k] = `ok:${String(plain).length}`;
      } catch {
        report[k] = 'fail';
      }
    } else if (/pass|key|token|secret/i.test(k)) {
      report[k] = `plain:${v.length}`;
    }
  }
  console.log(JSON.stringify(report));
}

await pool.end();
