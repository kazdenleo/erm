#!/bin/bash
set -e
cd /opt/erm/server
grep -E '^(DB_|DATABASE|PG)' .env | sed 's/=.*/=***/'
echo '---'
# reuse existing pool helper if any
node <<'NODE'
import fs from 'fs';
import pg from 'pg';
const env = fs.readFileSync('/opt/erm/server/.env', 'utf8');
const keys = [...env.matchAll(/^([A-Z0-9_]+)=/gm)].map(m => m[1]);
console.log('env keys sample:', keys.filter(k => /DB|PG|SQL|DATABASE/i.test(k)).join(', '));
const get = (k) => {
  const m = env.match(new RegExp('^' + k + '=(.*)$', 'm'));
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
};
const config = get('DATABASE_URL')
  ? { connectionString: get('DATABASE_URL') }
  : {
      host: get('DB_HOST') || '127.0.0.1',
      port: Number(get('DB_PORT') || 5432),
      user: get('DB_USER') || get('PGUSER') || 'postgres',
      password: get('DB_PASSWORD') || get('PGPASSWORD') || '',
      database: get('DB_NAME') || get('PGDATABASE') || 'erm',
    };
const pool = new pg.Pool(config);
const r = await pool.query(`
  SELECT id, purchase_id, status, created_at, completed_at
  FROM purchase_receipts
  WHERE status IN ('in_progress','draft','open')
     OR (status = 'completed' AND completed_at > NOW() - INTERVAL '6 hours')
  ORDER BY id DESC
  LIMIT 20
`);
console.log(JSON.stringify(r.rows, null, 2));
await pool.end();
NODE
