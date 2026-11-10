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

const pool = new pg.Pool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});
const secret = process.env.JWT_SECRET || process.env.JWT_ACCESS_SECRET;
const u = (await pool.query(`SELECT id, email, role, profile_id FROM users WHERE profile_id=6 ORDER BY id LIMIT 1`)).rows[0];
const token = jwt.sign({ userId: u.id, email: u.email, role: u.role || 'admin', profileId: u.profile_id }, secret, {
  expiresIn: '20m',
});

async function api(method, path, body) {
  const res = await fetch(`http://127.0.0.1:3001/api/orders${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Profile-Id': '6',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

const before = await api('GET', '/sync-fbs/status');
console.log(
  'before',
  JSON.stringify({
    inProgress: before.json?.data?.inProgress,
    syncStartedAt: before.json?.data?.syncStartedAt,
    lastSyncError: before.json?.data?.lastSyncError,
    lastSyncResult: before.json?.data?.lastSyncResult,
  })
);

if (before.json?.data?.inProgress) {
  console.log('reset', await api('POST', '/sync-fbs/reset'));
}

const start = await api('POST', '/sync-fbs', { refreshStatuses: true, daysBack: 14, force: true });
console.log('start', start.status, {
  started: start.json?.started,
  inProgress: start.json?.inProgress,
  message: start.json?.message,
});

for (let i = 0; i < 48; i++) {
  await new Promise((r) => setTimeout(r, 10000));
  const st = (await api('GET', '/sync-fbs/status')).json?.data || {};
  const summary = st.lastSyncResult || {};
  const brief = (mp) =>
    mp && typeof mp === 'object'
      ? { success: mp.success, failed: mp.failed, ordersCount: mp.ordersCount ?? mp.orders?.length, reason: mp.reason }
      : mp;
  console.log(
    `poll ${i + 1}`,
    'inProgress=',
    st.inProgress,
    'err=',
    st.lastSyncError,
    'oz=',
    JSON.stringify(brief(summary.ozon)),
    'wb=',
    JSON.stringify(brief(summary.wildberries)),
    'ym=',
    JSON.stringify(brief(summary.yandex))
  );
  if (!st.inProgress) break;
}

const counts = await pool.query(
  `SELECT marketplace, status, COUNT(*)::int n FROM orders
   WHERE profile_id=6 AND status IN ('new','in_assembly','assembled','in_transit','shipped','cancelled','delivered')
   GROUP BY 1,2 ORDER BY 1,2`
);
console.log('counts', counts.rows);
await pool.end();
process.exit(0);
