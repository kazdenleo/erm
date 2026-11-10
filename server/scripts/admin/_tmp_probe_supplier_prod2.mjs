import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// load env like the app
for (const line of fs.readFileSync('/opt/erm/server/.env', 'utf8').split(/\r?\n/)) {
  if (!line || line.startsWith('#')) continue;
  const i = line.indexOf('=');
  if (i < 0) continue;
  const k = line.slice(0, i).trim();
  let v = line.slice(i + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  if (!(k in process.env)) process.env[k] = v;
}

const { query, closePool } = await import('../../src/config/database.js');
const supplierStocksService = (await import('../../src/services/supplierStocks.service.js')).default;

const q = async (sql, params = []) => (await query(sql, params)).rows;

console.log('env SECRETS_KEY', process.env.SECRETS_KEY ? `len=${process.env.SECRETS_KEY.length}` : 'MISSING');
console.log('env SECRETS_ENCRYPTION_KEY', process.env.SECRETS_ENCRYPTION_KEY ? `len=${process.env.SECRETS_ENCRYPTION_KEY.length}` : 'MISSING');

const positives = await q(
  `SELECT p.sku, ss.supplier_id, s.name, ss.stock
   FROM supplier_stocks ss
   JOIN products p ON p.id=ss.product_id
   JOIN suppliers s ON s.id=ss.supplier_id
   WHERE COALESCE(ss.stock,0)>0
   ORDER BY ss.stock DESC
   LIMIT 15`
);
console.log('top positive rows', positives);

console.log(
  'supplier5 warehouses',
  await q(`SELECT id, name, type, supplier_id, main_warehouse_id, profile_id FROM warehouses WHERE supplier_id=5 OR id=5`)
);

const sampleIds = await q(
  `SELECT DISTINCT product_id FROM supplier_stocks WHERE COALESCE(stock,0)>0 ORDER BY product_id LIMIT 20`
);
const ids = sampleIds.map((r) => Number(r.product_id));
console.log('sample product ids', ids);

for (const wh of [null, '1', '4']) {
  const rows = await supplierStocksService.getBreakdownByProductIds(ids, {
    mainWarehouseId: wh,
    profileId: '1',
  });
  console.log(`breakdown wh=${wh} count=${rows.length}`, rows.slice(0, 8));
}

// check secrets decrypt for suppliers
try {
  const { decryptSecret } = await import('../../src/utils/secretsCrypto.js');
  const rows = await q(`SELECT id, name, api_config FROM suppliers ORDER BY id`);
  for (const r of rows) {
    const cfg = typeof r.api_config === 'string' ? JSON.parse(r.api_config) : r.api_config || {};
    const keys = Object.keys(cfg).filter((k) => /key|pass|token|secret/i.test(k));
    const report = {};
    for (const k of keys) {
      const v = cfg[k];
      if (v == null || v === '') {
        report[k] = 'empty';
        continue;
      }
      if (typeof v === 'string' && v.startsWith('enc:v1:')) {
        try {
          decryptSecret(v);
          report[k] = 'ok';
        } catch (e) {
          report[k] = `fail:${e.message}`;
        }
      } else {
        report[k] = 'plain';
      }
    }
    console.log(`supplier ${r.id} ${r.name} secrets`, report);
  }
} catch (e) {
  console.log('secrets check error', e.message);
}

process.exit(0);
