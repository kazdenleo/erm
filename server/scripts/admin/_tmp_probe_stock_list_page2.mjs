import 'dotenv/config';
import jwt from 'jsonwebtoken';
import { query, closePool } from '../../src/config/database.js';

const token = jwt.sign({ userId: 1, profileId: 1 }, process.env.JWT_SECRET, { expiresIn: '1h' });

const p = await query(
  `SELECT id, sku, user_category_id FROM products WHERE sku IN ('AFAC167','AFAD128','AN1125')`
);
console.log('product cats', p.rows);

const uc = await query(
  `SELECT id, name FROM user_categories WHERE name ILIKE '%воздуш%' OR name ILIKE '%фильтр%' ORDER BY id LIMIT 30`
).catch(() => ({ rows: [] }));
console.log('user_categories', uc.rows);

const catId = p.rows[0]?.user_category_id;
console.log('using', catId, (await query(`SELECT id, name FROM user_categories WHERE id=$1`, [catId])).rows);

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

const interesting = ['AFAC167', 'AFAD128', 'AN1125', 'AN1053', 'AFAC165'];
for (const sku of interesting) {
  const prod = data.find((x) => String(x.sku).toUpperCase() === sku);
  if (!prod) {
    console.log(sku, 'NOT ON PAGE');
    continue;
  }
  const rows = bd.filter((r) => String(r.product_id) === String(prod.id));
  const suppliers = rows.reduce((s, r) => s + (Number(r.stock) || 0), 0);
  const onHand = Number(prod.quantity) || 0;
  const incoming = Number(prod.incoming_quantity ?? prod.incomingQuantity) || 0;
  const reserved =
    Number(prod.net_reserved_quantity ?? prod.netReservedQuantity ?? prod.reserved_quantity) || 0;
  console.log({
    sku,
    onHand,
    incoming,
    reserved,
    suppliers,
    availableShouldBe: Math.max(0, onHand + incoming + suppliers - reserved),
    bd: rows.map((r) => `${r.supplier_code}:${r.stock}`),
  });
}

await closePool();
