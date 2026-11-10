import fs from 'fs';
import http from 'http';

for (const line of fs.readFileSync('/opt/erm/server/.env', 'utf8').split(/\n/)) {
  if (!line || line.startsWith('#')) continue;
  const i = line.indexOf('=');
  if (i < 0) continue;
  const k = line.slice(0, i);
  let v = line.slice(i + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  if (!(k in process.env)) process.env[k] = v;
}

const { query, closePool } = await import('../../src/config/database.js');
const jwt = (await import('jsonwebtoken')).default;

const user = (await query(`SELECT id, email, role FROM users WHERE id=1`)).rows[0];
const token = jwt.sign(
  { userId: Number(user.id), email: user.email, role: user.role },
  process.env.JWT_SECRET,
  { expiresIn: '30m' }
);

function req(method, path) {
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        hostname: '127.0.0.1',
        port: Number(process.env.PORT || 3001),
        path,
        method,
        headers: { Authorization: `Bearer ${token}` },
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
          resolve({ status: res.statusCode, json, body: data.slice(0, 500) });
        });
      }
    );
    r.on('error', reject);
    r.end();
  });
}

console.log('before', (
  await query(
    `SELECT COUNT(*) FILTER (WHERE COALESCE(ss.stock,0)>0)::int positive,
            COALESCE(SUM(ss.stock),0)::int qty
     FROM products p JOIN supplier_stocks ss ON ss.product_id=p.id
     WHERE p.profile_id=1`
  )
).rows[0]);

const start = await req('POST', '/api/products/refresh-supplier-stocks');
console.log('start', start.status, start.json || start.body);

for (let i = 0; i < 90; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const st = await req('GET', '/api/products/refresh-supplier-stocks/status');
  const s = st.json?.data || st.json || {};
  console.log('status', i, s.running, s.done, s.total, s.error || s.message || '');
  if (s.running === false || s.running == null && i > 2) {
    if (s.running === false) break;
  }
  if (String(s.status || '').includes('done') || s.finished === true) break;
}

console.log('after', (
  await query(
    `SELECT COUNT(*) FILTER (WHERE COALESCE(ss.stock,0)>0)::int positive,
            COALESCE(SUM(ss.stock),0)::int qty
     FROM products p JOIN supplier_stocks ss ON ss.product_id=p.id
     WHERE p.profile_id=1`
  )
).rows[0]);

console.log(
  'sample',
  (
    await query(
      `SELECT p.sku, ss.supplier_id, ss.stock
       FROM products p JOIN supplier_stocks ss ON ss.product_id=p.id
       WHERE p.profile_id=1 AND COALESCE(ss.stock,0)>0
       ORDER BY ss.stock DESC LIMIT 15`
    )
  ).rows
);

const httpCheck = await req(
  'GET',
  '/api/products?stockList=1&listView=stock&limit=20&offset=0&warehouseId=1&search=AFAC167'
);
const rows = Array.isArray(httpCheck.json?.data) ? httpCheck.json.data : [];
console.log(
  'AFAC167 api',
  rows.map((p) => ({
    sku: p.sku,
    supplierStockTotal: p.supplierStockTotal,
    bd: p.supplierBreakdown,
  }))
);

await closePool();
