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

const users = await query(
  `SELECT id, email, role, profile_id FROM users ORDER BY id LIMIT 10`
);
console.log(
  'users',
  users.rows.map((u) => ({ id: u.id, email: u.email, role: u.role, profile_id: u.profile_id }))
);

const admin =
  users.rows.find((u) => String(u.profile_id) === '1') ||
  users.rows.find((u) => String(u.role || '').toLowerCase() === 'admin') ||
  users.rows[0];
if (!admin) throw new Error('no user');
console.log('auth as', admin);

const token = jwt.sign(
  {
    userId: Number(admin.id),
    id: Number(admin.id),
    email: admin.email,
    role: admin.role,
    profileId: admin.profile_id != null ? Number(admin.profile_id) : null,
  },
  process.env.JWT_SECRET,
  { expiresIn: '10m' }
);

function get(path) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: Number(process.env.PORT || 3001),
        path,
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'X-Profile-Id': String(admin.profile_id || 1),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, json: JSON.parse(body) });
          } catch {
            resolve({ status: res.statusCode, body: body.slice(0, 500) });
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

const sku = 'TG-5183';
const search = encodeURIComponent(sku);
for (const wh of ['', '1', '4']) {
  const qs = `stockList=1&listView=stock&limit=20&offset=0&search=${search}${wh ? `&warehouseId=${wh}` : ''}`;
  const res = await get(`/api/products?${qs}`);
  const rows = Array.isArray(res.json?.data) ? res.json.data : [];
  const bd = res.json?.supplierBreakdown;
  console.log('HTTP', {
    wh: wh || null,
    status: res.status,
    n: rows.length,
    breakdownN: Array.isArray(bd) ? bd.length : bd,
    first: rows[0]
      ? {
          sku: rows[0].sku,
          supplierStockTotal: rows[0].supplierStockTotal,
          supplier_stock_total: rows[0].supplier_stock_total,
          breakdownLen: Array.isArray(rows[0].supplierBreakdown) ? rows[0].supplierBreakdown.length : null,
        }
      : null,
  });
}

await closePool();
