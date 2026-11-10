import { writeFileSync } from 'fs';
import { query, closePool } from '../../src/config/database.js';

const out = [];
const log = (...a) => out.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));

try {
  const kid = 322;
  const p = await query(
    `SELECT id, sku, name, ozon_product_id, wb_nm_id, ym_shop_sku,
            mp_ozon_sku, mp_wb_sku, mp_ym_sku
     FROM products WHERE id=$1`,
    [kid]
  ).catch(async (e) => {
    log('prod cols err', e.message);
    const cols = await query(
      `SELECT column_name FROM information_schema.columns WHERE table_name='products' AND (column_name ILIKE '%ozon%' OR column_name ILIKE '%wb%' OR column_name ILIKE '%barcode%' OR column_name ILIKE '%sku%' OR column_name ILIKE '%mp_%') ORDER BY 1`
    );
    log('mp-ish cols', cols.rows.map((r) => r.column_name));
    return query(`SELECT * FROM products WHERE id=$1`, [kid]);
  });
  log('product', p.rows[0]);

  const bc = await query(`SELECT * FROM barcodes WHERE product_id=$1`, [kid]);
  log('barcodes', bc.rows);

  // marketplace links
  const links = await query(
    `SELECT * FROM product_marketplace_links WHERE product_id=$1 LIMIT 20`,
    [kid]
  ).catch(async (e) => {
    log('links err', e.message);
    return { rows: [] };
  });
  log('links', links.rows);

  // supply items for this kit recently
  const items = await query(
    `SELECT si.id, si.fbo_supply_id, si.sku, si.barcode, si.quantity, s.status, s.marketplace
     FROM fbo_supply_items si
     JOIN fbo_supplies s ON s.id = si.fbo_supply_id
     WHERE si.product_id = $1
     ORDER BY si.id DESC LIMIT 15`,
    [kid]
  );
  log('supply items', items.rows);
} catch (e) {
  log('ERROR', e?.stack || e.message);
} finally {
  writeFileSync('/tmp/_tmp_probe_kit322_mp_bc.out.json', out.join('\n'), 'utf8');
  console.log(out.join('\n'));
  await closePool();
}
