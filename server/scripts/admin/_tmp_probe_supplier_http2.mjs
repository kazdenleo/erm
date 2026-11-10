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

const prod = await query(`SELECT id, sku, profile_id, organization_id FROM products WHERE sku='TG-5183' LIMIT 3`);
console.log('product', prod.rows);

const user = (await query(`SELECT * FROM users WHERE id=1`)).rows[0];
console.log('user keys', Object.keys(user));

const token = jwt.sign(
  { userId: Number(user.id), email: user.email, role: user.role },
  process.env.JWT_SECRET,
  { expiresIn: '10m' }
);

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        hostname: '127.0.0.1',
        port: Number(process.env.PORT || 3001),
        path,
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
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
          resolve({ status: res.statusCode, json, body: data.slice(0, 300) });
        });
      }
    );
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

const me = await req('GET', '/api/auth/me');
console.log('me', me.status, me.json?.user ? { id: me.json.user.id, profileId: me.json.user.profileId, role: me.json.user.role } : me.body);

for (const path of [
  '/api/products?stockList=1&listView=stock&limit=5&offset=0',
  '/api/products?stockList=1&listView=stock&limit=5&offset=0&search=TG-5183',
  '/api/products?stockList=1&listView=stock&limit=5&offset=0&warehouseId=1&search=TG-5183',
  '/api/products?limit=5&offset=0&search=TG-5183',
]) {
  const res = await req('GET', path);
  const rows = Array.isArray(res.json?.data) ? res.json.data : [];
  console.log(path, {
    status: res.status,
    n: rows.length,
    total: res.json?.meta?.total,
    bd: Array.isArray(res.json?.supplierBreakdown) ? res.json.supplierBreakdown.length : res.json?.supplierBreakdown,
    sample: rows.slice(0, 2).map((p) => ({
      sku: p.sku,
      supplierStockTotal: p.supplierStockTotal,
      bd: Array.isArray(p.supplierBreakdown) ? p.supplierBreakdown.length : null,
    })),
    err: res.json?.message || res.json?.error,
  });
}

await closePool();
