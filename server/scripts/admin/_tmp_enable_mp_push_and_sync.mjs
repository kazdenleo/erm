import fs from 'fs';
import http from 'http';
import jwt from 'jsonwebtoken';

for (const line of fs.readFileSync('/opt/erm/server/.env', 'utf8').split(/\n/)) {
  if (!line || line.startsWith('#')) continue;
  const i = line.indexOf('=');
  if (i < 0) continue;
  let v = line.slice(i + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  if (!(line.slice(0, i) in process.env)) process.env[line.slice(0, i)] = v;
}

const { query, closePool } = await import('../../src/config/database.js');

const upd = await query(
  `UPDATE warehouses
   SET push_marketplace_stock = true
   WHERE id IN (1, 4)
   RETURNING id, name, push_marketplace_stock, push_stock_ozon, push_stock_wb, push_stock_ym`
);
console.log('updated', upd.rows);

const user = (await query(`SELECT id, email, role FROM users WHERE id=1`)).rows[0];
const token = jwt.sign(
  { userId: Number(user.id), email: user.email, role: user.role },
  process.env.JWT_SECRET,
  { expiresIn: '30m' }
);

function req(method, path, bodyObj) {
  const body = bodyObj ? JSON.stringify(bodyObj) : null;
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        hostname: '127.0.0.1',
        port: Number(process.env.PORT || 3001),
        path,
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
            : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(data);
          } catch {
            /* ignore */
          }
          resolve({ status: res.statusCode, json, body: data.slice(0, 400) });
        });
      }
    );
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

const start = await req('POST', '/api/marketplace-stock/sync', {
  organizationId: 1,
  force: true,
});
console.log('push start', start.status, start.json || start.body);

for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const st = await req('GET', '/api/marketplace-stock/sync/status');
  const d = st.json?.data || st.json || {};
  console.log('status', i, JSON.stringify(d).slice(0, 250));
  if (d.inProgress === false || d.running === false || d.completed === true) break;
}

await closePool();
