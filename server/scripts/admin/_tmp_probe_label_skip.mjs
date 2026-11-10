/**
 * Verify kit labels contain a scannable barcode band (dark/light transitions).
 */
import sharp from 'sharp';
import { query, closePool } from '../../src/config/database.js';
import productLabelsService from '../../src/services/productLabels.service.js';

async function barcodeBandScore(pngBuffer) {
  const { data, info } = await sharp(pngBuffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  // Scan middle horizontal strip for B/W transitions typical of Code128
  const y0 = Math.floor(height * 0.15);
  const y1 = Math.floor(height * 0.55);
  let maxTransitions = 0;
  for (let y = y0; y < y1; y += 2) {
    let transitions = 0;
    let prevDark = null;
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * channels;
      const lum = (data[i] + data[i + 1] + data[i + 2]) / 3;
      const dark = lum < 140;
      if (prevDark != null && dark !== prevDark) transitions += 1;
      prevDark = dark;
    }
    if (transitions > maxTransitions) maxTransitions = transitions;
  }
  return { width, height, maxTransitions, hasBarcodeLike: maxTransitions >= 40 };
}

async function main() {
  for (const id of [322, 320, 451]) {
    const product = (await query(`SELECT id, sku, name, user_category_id FROM products WHERE id = $1`, [id]))
      .rows[0];
    const tpl = await productLabelsService.getTemplateForProduct(product, null);
    const elements = (tpl?.elements || []).map((e) => ({ type: e.type, enabled: e.enabled !== false }));
    const { pngBuffer, widthMm, heightMm } = await productLabelsService.renderProductLabel(id, {
      marketplace: 'ozon',
      format: 'png',
    });
    const score = await barcodeBandScore(pngBuffer);
    console.log(
      JSON.stringify({
        id,
        sku: product.sku,
        nameLen: String(product.name || '').length,
        elements,
        widthMm,
        heightMm,
        ...score,
      })
    );
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closePool());
