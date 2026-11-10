import { writeFileSync } from 'fs';
import { query, closePool } from '../../src/config/database.js';

const out = [];
const log = (...a) => out.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));

try {
  const r = await query(
    `SELECT b.barcode, b.marketplaces, p.id, p.sku, p.name, p.product_type
     FROM barcodes b
     JOIN products p ON p.id = b.product_id
     WHERE b.barcode ILIKE '%5103%' OR p.sku ILIKE '%5103%' OR p.name ILIKE '%5103%'
     ORDER BY p.sku
     LIMIT 40`
  );
  log('hits', r.rows);

  // Also left/right kits that need two different components
  const dual = await query(
    `SELECT kp.id, kp.sku,
            string_agg(cp.sku || '×' || kc.quantity::text, ', ' ORDER BY cp.sku) AS comps,
            COUNT(*)::int AS n
     FROM kit_components kc
     JOIN products kp ON kp.id = kc.kit_product_id
     JOIN products cp ON cp.id = kc.component_product_id
     WHERE kp.product_type = 'kit'
     GROUP BY kp.id, kp.sku
     HAVING COUNT(*) >= 2
        AND bool_or(cp.sku ILIKE 'TG-51%')
     ORDER BY kp.sku
     LIMIT 30`
  );
  log('multi-comp TG-51 kits', dual.rows);
} catch (e) {
  log('ERROR', e?.stack || e.message);
} finally {
  writeFileSync('/tmp/_tmp_probe_bc_5103.out.json', out.join('\n'), 'utf8');
  console.log(out.join('\n'));
  await closePool();
}
