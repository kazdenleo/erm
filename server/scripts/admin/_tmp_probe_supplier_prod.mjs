import fs from 'fs';
import pg from 'pg';

const env = Object.fromEntries(
  fs
    .readFileSync('/opt/erm/server/.env', 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')];
    })
);

const pool = new pg.Pool({
  host: env.DB_HOST || '127.0.0.1',
  port: Number(env.DB_PORT || 5432),
  database: env.DB_NAME,
  user: env.DB_USER,
  password: env.DB_PASSWORD,
});

const q = async (sql, params = []) => (await pool.query(sql, params)).rows;

console.log('SECRETS_KEY len', (env.SECRETS_KEY || '').length);
console.log('suppliers', await q('SELECT id, name, COALESCE(is_active,true) AS active FROM suppliers ORDER BY id LIMIT 30'));
console.log('profiles sync', await q('SELECT id, name, supplier_sync_enabled FROM profiles ORDER BY id'));
console.log(
  'stock rows',
  await q(
    'SELECT COUNT(*)::int AS n, COUNT(DISTINCT product_id)::int AS products, COUNT(DISTINCT supplier_id)::int AS suppliers, COALESCE(SUM(stock),0)::int AS qty FROM supplier_stocks'
  )
);
console.log(
  'top stocks',
  await q(
    `SELECT ss.supplier_id, s.name, COUNT(*)::int AS rows, SUM(ss.stock)::int AS qty
     FROM supplier_stocks ss LEFT JOIN suppliers s ON s.id=ss.supplier_id
     WHERE COALESCE(ss.stock,0)>0 GROUP BY 1,2 ORDER BY qty DESC LIMIT 15`
  )
);
console.log(
  'supplier warehouses',
  await q(
    `SELECT w.id, w.supplier_id, s.name AS supplier, w.name AS wh, w.type, w.main_warehouse_id, mw.name AS main, w.profile_id
     FROM warehouses w
     LEFT JOIN suppliers s ON s.id=w.supplier_id
     LEFT JOIN warehouses mw ON mw.id=w.main_warehouse_id
     WHERE w.type='supplier'
     ORDER BY w.supplier_id, w.id LIMIT 50`
  )
);
console.log(
  'main links',
  await q(
    `SELECT l.supplier_warehouse_id, sw.name AS sw_name, sw.supplier_id, l.main_warehouse_id, mw.name AS main
     FROM supplier_warehouse_main_links l
     JOIN warehouses sw ON sw.id=l.supplier_warehouse_id
     LEFT JOIN warehouses mw ON mw.id=l.main_warehouse_id
     ORDER BY sw.supplier_id, l.main_warehouse_id LIMIT 40`
  )
);
console.log(
  'sample AN/AFAC',
  await q(
    `SELECT p.id, p.sku, ss.supplier_id, s.name, ss.stock, ss.stock_name
     FROM products p
     JOIN supplier_stocks ss ON ss.product_id=p.id
     LEFT JOIN suppliers s ON s.id=ss.supplier_id
     WHERE p.sku ILIKE '%AN1125%' OR p.sku ILIKE '%AFAC167%' OR p.sku IN ('AN1125','AFAC167')
     ORDER BY p.sku, ss.supplier_id LIMIT 40`
  )
);
console.log(
  'main warehouses',
  await q(`SELECT id, name, type FROM warehouses WHERE type IS DISTINCT FROM 'supplier' ORDER BY id`)
);

await pool.end();
