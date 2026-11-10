import { writeFileSync } from 'fs';
import { query, closePool } from '../../src/config/database.js';
import productLabelsService from '../../src/services/productLabels.service.js';
import sharp from 'sharp';

const out = [];
const log = (...a) => out.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));

async function stats(buf) {
  const { data, info } = await sharp(buf).greyscale().raw().toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;
  const y1 = Math.floor(h * 0.4);
  let dark = 0;
  let n = 0;
  let min = 255;
  let max = 0;
  for (let y = 0; y < y1; y++) {
    for (let x = 0; x < w; x++) {
      const v = data[y * w + x];
      if (v < min) min = v;
      if (v > max) max = v;
      if (v < 80) dark++;
      n++;
    }
  }
  return { contrast: max - min, darkRatio: dark / n };
}

try {
  const skus = ['TG-5101', 'TG-5102', 'TG-5108', 'TG-5100', 'DTTG5101x2', 'DTTG-5102x2'];
  for (const sku of skus) {
    const p = await query(`SELECT id, sku FROM products WHERE UPPER(TRIM(sku))=UPPER($1)`, [sku]);
    if (!p.rows[0]) {
      log('missing', sku);
      continue;
    }
    const id = Number(p.rows[0].id);
    const bc = await query(`SELECT barcode, marketplaces FROM barcodes WHERE product_id=$1`, [id]);
    const rendered = await productLabelsService.renderProductLabel(id, {
      profileId: 6,
      format: 'png',
      marketplace: 'ozon',
    });
    const buf = rendered.buffer;
    writeFileSync(`/tmp/label_${sku.replace(/[^a-zA-Z0-9]/g, '_')}.png`, buf);
    log(sku, { id, barcodes: bc.rows, ...(await stats(buf)) });
  }
} catch (e) {
  log('ERROR', e?.stack || e.message);
} finally {
  writeFileSync('/tmp/_tmp_probe_comp_labels.out.json', out.join('\n'), 'utf8');
  console.log(out.join('\n'));
  await closePool();
}
