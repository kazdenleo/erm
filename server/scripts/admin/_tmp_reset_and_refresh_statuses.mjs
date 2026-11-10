/**
 * Prod: сброс lock sync-fbs + обновление статусов для profile 6 (Док Трейд).
 */
import fs from 'fs';
import pg from 'pg';
import jwt from 'jsonwebtoken';

for (const line of fs.readFileSync('/opt/erm/server/.env', 'utf8').split(/\n/)) {
  if (!line || line.startsWith('#')) continue;
  const i = line.indexOf('=');
  if (i < 0) continue;
  let v = line.slice(i + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  const k = line.slice(0, i);
  if (!(k in process.env)) process.env[k] = v;
}

const BASE = 'http://127.0.0.1:3001';
const PROFILE_ID = 6;

const pool = new pg.Pool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

const secret = process.env.JWT_SECRET || process.env.JWT_ACCESS_SECRET;
if (!secret) throw new Error('JWT_SECRET missing');

const u = (
  await pool.query(
    `SELECT id, email, role, profile_id
     FROM users
     WHERE profile_id = $1
     ORDER BY id ASC LIMIT 1`,
    [PROFILE_ID]
  )
).rows[0];
if (!u) throw new Error('No user for profile 6');

const token = jwt.sign(
  {
    userId: u.id,
    email: u.email,
    role: u.role || 'admin',
    profileId: u.profile_id,
  },
  secret,
  { expiresIn: '30m' }
);
console.log('token ok for', u.email);

async function api(method, path, body) {
  const res = await fetch(`${BASE}/api/orders${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Profile-Id': String(PROFILE_ID),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 500) };
  }
  return { status: res.status, json };
}

console.log('status before', JSON.stringify((await api('GET', '/sync-fbs/status')).json?.data));
console.log('reset', await api('POST', '/sync-fbs/reset'));
console.log('status after reset', JSON.stringify((await api('GET', '/sync-fbs/status')).json?.data));

const start = await api('POST', '/sync-fbs', {
  refreshStatuses: true,
  daysBack: 14,
  force: true,
});
console.log('start', start.status, {
  started: start.json?.started,
  inProgress: start.json?.inProgress,
  message: start.json?.message,
  err: start.json?.message || start.json?.error || start.json?.raw,
});

for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const st = (await api('GET', '/sync-fbs/status')).json?.data || {};
  console.log(
    `poll ${i + 1}`,
    'inProgress=',
    st.inProgress,
    'err=',
    st.lastSyncError,
    'result=',
    JSON.stringify(st.lastSyncResult)
  );
  if (!st.inProgress) break;
}

const counts = await pool.query(
  `SELECT marketplace, status, COUNT(*)::int AS n
   FROM orders WHERE profile_id = $1 AND status = 'new'
   GROUP BY 1 ORDER BY 1`,
  [PROFILE_ID]
);
console.log('new counts after', counts.rows);
await pool.end();
process.exit(0);
