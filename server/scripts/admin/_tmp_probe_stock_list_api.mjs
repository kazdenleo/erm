import 'dotenv/config';
import jwt from 'jsonwebtoken';

const token = jwt.sign(
  { userId: 1, profileId: 1 },
  process.env.JWT_SECRET,
  { expiresIn: '1h' }
);

const url =
  'http://localhost:3001/api/products?stockList=1&listView=stock&warehouseId=1&organizationId=1&categoryId=' +
  encodeURIComponent('') +
  '&limit=50&offset=0&search=AFAC167';

const res = await fetch(url, {
  headers: {
    Authorization: `Bearer ${token}`,
    'X-Organization-Id': '1',
  },
});
const body = await res.json();
const p = (body.data || []).find((x) => String(x.sku).toUpperCase() === 'AFAC167');
console.log('status', res.status);
console.log('product AFAC167', p && {
  id: p.id,
  sku: p.sku,
  quantity: p.quantity,
  incoming: p.incoming_quantity ?? p.incomingQuantity,
  reserved: p.net_reserved_quantity ?? p.reserved_quantity,
});
const bd = body.supplierBreakdown || [];
console.log(
  'breakdown for product',
  bd.filter((r) => String(r.product_id) === String(p?.id))
);
console.log('breakdown total rows', bd.length);
console.log('sample breakdown', bd.slice(0, 3));
