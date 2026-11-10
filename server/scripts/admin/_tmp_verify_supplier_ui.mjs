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
  { expiresIn: '10m' }
);

function req(path) {
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        hostname: '127.0.0.1',
        port: Number(process.env.PORT || 3001),
        path,
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve(JSON.parse(data)));
      }
    );
    r.on('error', reject);
    r.end();
  });
}

console.log(
  'by supplier',
  (
    await query(
      `SELECT ss.supplier_id, s.name, COUNT(*) FILTER (WHERE COALESCE(ss.stock,0)>0)::int pos, COALESCE(SUM(ss.stock),0)::int qty
       FROM products p
       JOIN supplier_stocks ss ON ss.product_id=p.id
       JOIN suppliers s ON s.id=ss.supplier_id
       WHERE p.profile_id=1
       GROUP BY 1,2 ORDER BY 1`
    )
  ).rows
);

for (const sku of ['AFAD128', 'AFAC167', 'AN1125', 'E500036']) {
  const raw = (
    await query(
      `SELECT p.sku, ss.supplier_id, s.name, ss.stock
       FROM products p JOIN supplier_stocks ss ON ss.product_id=p.id
       LEFT JOIN suppliers s ON s.id=ss.supplier_id
       WHERE p.sku=$1 AND p.profile_id=1`,
      [sku]
    )
  ).rows;
  const api = await req(
    `/api/products?stockList=1&listView=stock&limit=5&offset=0&warehouseId=1&search=${encodeURIComponent(sku)}`
  );
  const row = (api.data || [])[0];
  console.log(sku, {
    raw,
    apiTotal: row?.supplierStockTotal,
    apiBd: row?.supplierBreakdown,
    metaBd: api.supplierBreakdown,
  });
}

const page = await req('/api/products?stockList=1&listView=stock&limit=20&offset=0&warehouseId=1');
const withSup = (page.data || []).filter((p) => (Number(p.supplierStockTotal) || 0) > 0);
console.log('first page with suppliers', withSup.length, withSup.slice(0, 5).map((p) => ({ sku: p.sku, t: p.supplierStockTotal })));
console.log('breakdown meta len', Array.isArray(page.supplierBreakdown) ? page.supplierBreakdown.length : page.supplierBreakdown);

await closePool();
