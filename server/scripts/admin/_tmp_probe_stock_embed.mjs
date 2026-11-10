import 'dotenv/config';
import jwt from 'jsonwebtoken';

const token = jwt.sign({ userId: 1, profileId: 1 }, process.env.JWT_SECRET, { expiresIn: '1h' });
const url = new URL('http://localhost:3001/api/products');
url.searchParams.set('stockList', '1');
url.searchParams.set('listView', 'stock');
url.searchParams.set('warehouseId', '1');
url.searchParams.set('organizationId', '1');
url.searchParams.set('categoryId', '1');
url.searchParams.set('limit', '10');
url.searchParams.set('offset', '0');
url.searchParams.set('_t', String(Date.now()));

const res = await fetch(url, {
  headers: { Authorization: `Bearer ${token}`, 'X-Organization-Id': '1' },
});
const body = await res.json();
console.log('status', res.status);
console.log('breakdown rows', (body.supplierBreakdown || []).length);
const sample = (body.data || [])
  .filter((p) => ['AFAC167', 'AFAD128', 'AN1125', 'AN1053'].includes(String(p.sku).toUpperCase()))
  .map((p) => ({
    sku: p.sku,
    qty: p.quantity,
    supplierStockTotal: p.supplierStockTotal,
    supplier_stock_total: p.supplier_stock_total,
    breakdownLen: Array.isArray(p.supplierBreakdown) ? p.supplierBreakdown.length : null,
    breakdown: (p.supplierBreakdown || []).map((r) => `${r.supplier_code}:${r.stock}`),
  }));
console.log('embedded on products', sample);
if (!sample.length) {
  console.log(
    'first 5 products',
    (body.data || []).slice(0, 5).map((p) => ({
      sku: p.sku,
      supplierStockTotal: p.supplierStockTotal,
      bd: (p.supplierBreakdown || []).length,
    }))
  );
}
