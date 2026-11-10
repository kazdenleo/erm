import { writeFileSync } from 'fs';
import { query, closePool } from '../../src/config/database.js';
import { pickBarcodeForMarketplace } from '../../src/utils/productBarcodes.js';
import productLabelsService from '../../src/services/productLabels.service.js';
import repositoryFactory from '../../src/config/repository-factory.js';

const out = [];
const log = (...a) => out.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));

try {
  const cols = await query(
    `SELECT column_name FROM information_schema.columns WHERE table_name='barcodes' ORDER BY ordinal_position`
  );
  log('barcodes cols', cols.rows.map((r) => r.column_name));

  const comps = await query(
    `SELECT id, sku, name, product_type
     FROM products
     WHERE UPPER(TRIM(sku)) IN ('TG-5101','TG-5103','DTTG5101X2','DTTG5103X2')
        OR UPPER(TRIM(sku)) LIKE 'DTTG510%'
        OR UPPER(TRIM(sku)) LIKE 'TG-510%'
     ORDER BY sku`
  );
  log('related products', comps.rows);

  const kitIds = (
    await query(
      `SELECT DISTINCT kc.kit_product_id
       FROM kit_components kc
       JOIN products cp ON cp.id = kc.component_product_id
       WHERE UPPER(TRIM(cp.sku)) IN ('TG-5101','TG-5103')`
    )
  ).rows.map((r) => Number(r.kit_product_id));
  log('kit ids', kitIds);

  for (const kid of kitIds) {
    const p = await query(`SELECT id, sku, name, product_type FROM products WHERE id=$1`, [kid]);
    const bc = await query(`SELECT * FROM barcodes WHERE product_id=$1`, [kid]);
    log('kit', p.rows[0], 'barcodes raw', bc.rows);

    const repo = repositoryFactory.getProductsRepository();
    const detailed = await repo.findByIdWithDetails(kid);
    log('detailed barcodes', {
      sku: detailed?.sku,
      barcodes: detailed?.barcodes,
      barcodesType: Array.isArray(detailed?.barcodes)
        ? detailed.barcodes.map((b) => ({ t: typeof b, v: b }))
        : typeof detailed?.barcodes,
    });

    const picked =
      pickBarcodeForMarketplace(detailed?.barcodes, 'ozon') ||
      pickBarcodeForMarketplace(detailed?.barcodes, null) ||
      String(detailed?.sku || '').trim() ||
      '';
    log('picked for label', picked);

    try {
      const rendered = await productLabelsService.renderPng(kid, { marketplace: 'ozon' });
      log('renderPng', {
        ok: Boolean(rendered?.buffer || rendered?.png || rendered),
        keys: rendered && typeof rendered === 'object' ? Object.keys(rendered) : typeof rendered,
        size: rendered?.buffer?.length || rendered?.png?.length || null,
      });
    } catch (e) {
      log('renderPng err', e.message);
    }

    try {
      const html = await productLabelsService.buildPrintHtml?.(kid, { marketplace: 'ozon' });
      if (html) {
        const hasImg = String(html).includes('data:image') || String(html).includes('<image');
        const hasSku = String(html).includes(String(p.rows[0]?.sku || ''));
        log('html', { len: String(html).length, hasImg, hasSku });
      } else {
        log('no buildPrintHtml');
      }
    } catch (e) {
      log('html err', e.message);
    }
  }
} catch (e) {
  log('ERROR', e?.stack || e.message);
} finally {
  writeFileSync('/tmp/_tmp_probe_tg5101_kit_label.out.json', out.join('\n'), 'utf8');
  console.log(out.join('\n'));
  await closePool();
}
