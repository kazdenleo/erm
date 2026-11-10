import fs from 'fs';

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
const supplierStocksService = (await import('../../src/services/supplierStocks.service.js')).default;

const r = await query(`SELECT id, sku FROM products ORDER BY sku ASC LIMIT 50`);
const ids = r.rows.map((x) => Number(x.id));
console.log(
  'first page skus',
  r.rows.slice(0, 10).map((x) => x.sku)
);

const bd1 = await supplierStocksService.getBreakdownByProductIds(ids, {
  mainWarehouseId: '1',
  profileId: '1',
});
console.log('first50 breakdown moscow', bd1.length, bd1.slice(0, 3));

const bd0 = await supplierStocksService.getBreakdownByProductIds(ids, {
  mainWarehouseId: null,
  profileId: '1',
});
console.log('first50 breakdown all', bd0.length);

const r2 = await query(
  `SELECT supplier_id, COUNT(*)::int n, SUM(stock)::int qty
   FROM supplier_stocks
   WHERE product_id = ANY($1::int[]) AND COALESCE(stock,0)>0
   GROUP BY 1 ORDER BY 1`,
  [ids]
);
console.log('first50 raw stocks by supplier', r2.rows);

// supplier 5 share of total stocks
const r3 = await query(
  `SELECT supplier_id, COUNT(*) FILTER (WHERE COALESCE(stock,0)>0)::int pos,
          COUNT(*)::int all_rows
   FROM supplier_stocks GROUP BY 1 ORDER BY 1`
);
console.log('all stocks by supplier', r3.rows);

// decrypt check deeper
const { decryptSecret } = await import('../../src/utils/secretsCrypto.js');
const sup = await query(`SELECT id, name, api_config FROM suppliers ORDER BY id`);
for (const row of sup.rows) {
  const cfg = typeof row.api_config === 'string' ? JSON.parse(row.api_config || '{}') : row.api_config || {};
  console.log('supplier', row.id, row.name, 'api_config keys', Object.keys(cfg));
  const walk = (obj, prefix = '') => {
    if (!obj || typeof obj !== 'object') return;
    for (const [k, v] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (typeof v === 'string' && v.startsWith('enc:v1:')) {
        try {
          const plain = decryptSecret(v);
          console.log(' ', path, 'decrypt ok len', plain?.length);
        } catch (e) {
          console.log(' ', path, 'DECRYPT FAIL', e.message);
        }
      } else if (v && typeof v === 'object') {
        walk(v, path);
      }
    }
  };
  walk(cfg);
}

await closePool();
