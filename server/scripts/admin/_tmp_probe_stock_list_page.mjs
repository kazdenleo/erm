import 'dotenv/config';
import jwt from 'jsonwebtoken';
import { query, closePool } from '../../src/config/database.js';

const token = jwt.sign({ userId: 1, profileId: 1 }, process.env.JWT_SECRET, { expiresIn: '1h' });

const cats = await query(
  `SELECT id, name FROM categories WHERE name ILIKE '%воздуш%' OR name ILIKE '%фильтр%' ORDER BY id LIMIT 20`
);
console.log('categories', cats.rows);

const catId = cats.rows.find((c) => /воздуш/i.test(c.name))?.id ?? cats.rows[0]?.id;
console.log('using category', catId);

const url = new URL('http://localhost:3001/api/products');
url.searchParams.set('stockList', '1');
url.searchParams.set('listView', 'stock');
url.searchParams.set('warehouseId', '1');
url.searchParams.set('organizationId', '1');
if (catId) url.searchParams.set('categoryId', String(catId));
url.searchParams.set('limit', '50');
url.searchParams.set('offset', '0');

const res = await fetch(url, {
  headers: { Authorization: `Bearer ${token}`, 'X-Organization-Id': '1' },
});
const body = await res.json();
const data = body.data || [];
const bd = body.supplierBreakdown || [];
console.log('products', data.length, 'breakdown', bd.length);

const interesting = ['AFAC167', 'AFAD128', 'AN1125', 'AN1053'];
for (const sku of interesting) {
  const p = data.find((x) => String(x.sku).toUpperCase() === sku);
  if (!p) {
    console.log(sku, 'NOT ON PAGE');
    continue;
  }
  const rows = bd.filter((r) => String(r.product_id) === String(p.id));
  const suppliers = rows.reduce((s, r) => s + (Number(r.stock) || 0), 0);
  const onHand = Number(p.quantity) || 0;
  const incoming = Number(p.incoming_quantity ?? p.incomingQuantity) || 0;
  const reserved =
    Number(p.net_reserved_quantity ?? p.netReservedQuantity ?? p.reserved_quantity) || 0;
  const available = Math.max(0, onHand + incoming + suppliers - reserved);
  console.log({
    sku,
    onHand,
    incoming,
    reserved,
    suppliers,
    availableShouldBe: available,
    breakdown: rows.map((r) => `${r.supplier_code}:${r.stock}`),
  });
}

const me = await fetch('http://localhost:3001/api/auth/me', {
  headers: { Authorization: `Bearer ${token}` },
});
const meBody = await me.json();
console.log('me supplier_sync_enabled', meBody?.data?.profile?.supplier_sync_enabled, meBody?.profile?.supplier_sync_enabled);

await closePool();
