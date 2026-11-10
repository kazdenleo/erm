import { writeFileSync } from 'fs';
import { query, closePool } from '../../src/config/database.js';
import productLabelsService from '../../src/services/productLabels.service.js';
import repositoryFactory from '../../src/config/repository-factory.js';

const out = [];
const log = (...a) => out.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));

try {
  const kid = 322;
  const product = await repositoryFactory.getProductsRepository().findByIdWithDetails(kid);
  log('product', {
    id: product?.id,
    sku: product?.sku,
    category: product?.user_category_id ?? product?.userCategoryId,
    barcodes: product?.barcodes,
  });

  const template = await productLabelsService.getTemplateForProduct(product, 6);
  log('template', {
    id: template?.id,
    categoryId: template?.category_id ?? template?.categoryId,
    elements: (template?.elements || []).map((e) => ({
      type: e.type,
      enabled: e.enabled,
      fieldKey: e.fieldKey,
      widthMm: e.widthMm,
      heightMm: e.heightMm,
      showText: e.showText,
    })),
  });

  const rendered = await productLabelsService.renderProductLabel(kid, {
    profileId: 6,
    format: 'png',
    marketplace: 'ozon',
  });
  log('rendered', {
    contentType: rendered?.contentType,
    widthMm: rendered?.widthMm,
    heightMm: rendered?.heightMm,
    bufLen: rendered?.buffer?.length,
    pngLen: rendered?.pngBuffer?.length,
  });

  // Save png for visual check
  if (rendered?.buffer) {
    writeFileSync('/tmp/kit322_label.png', rendered.buffer);
    log('saved /tmp/kit322_label.png');
  } else if (rendered?.pngBuffer) {
    writeFileSync('/tmp/kit322_label.png', rendered.pngBuffer);
    log('saved pngBuffer');
  }

  // Also TG-5103 search
  const tg5103 = await query(
    `SELECT id, sku, name FROM products WHERE sku ILIKE '%5103%' ORDER BY sku LIMIT 20`
  );
  log('5103-like', tg5103.rows);

  // Kits with TG-5102 or similar ball joints pairs
  const moreKits = await query(
    `SELECT kp.id, kp.sku, cp.sku AS comp, kc.quantity,
            (SELECT COUNT(*) FROM barcodes b WHERE b.product_id = kp.id) AS bc_count,
            (SELECT string_agg(b.barcode, ', ') FROM barcodes b WHERE b.product_id = kp.id) AS bcs
     FROM kit_components kc
     JOIN products kp ON kp.id = kc.kit_product_id
     JOIN products cp ON cp.id = kc.component_product_id
     WHERE cp.sku IN ('TG-5101','TG-5102','TG-5103','TG-5108','TG-5100')
     ORDER BY kp.sku`
  );
  log('related kits barcodes', moreKits.rows);
} catch (e) {
  log('ERROR', e?.stack || e.message);
} finally {
  writeFileSync('/tmp/_tmp_probe_kit322_label.out.json', out.join('\n'), 'utf8');
  console.log(out.join('\n'));
  await closePool();
}
