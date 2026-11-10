/**
 * Simulate OLD barcode skip condition for kit labels (reserve name+kit below).
 */
import { query, closePool } from '../../src/config/database.js';
import productLabelsService from '../../src/services/productLabels.service.js';
import { pickBarcodeForMarketplace } from '../../src/utils/productBarcodes.js';

const MM_TO_PX = 8;

function wrapApprox(text, maxW, fs) {
  // rough: ~0.55*fs per char
  const charsPerLine = Math.max(1, Math.floor(maxW / (fs * 0.55)));
  const lines = [];
  let s = String(text || '');
  while (s.length) {
    lines.push(s.slice(0, charsPerLine));
    s = s.slice(charsPerLine);
  }
  return Math.max(1, lines.length);
}

async function main() {
  for (const id of [322, 320]) {
    const p = (
      await query(
        `SELECT p.*, COALESCE((SELECT json_agg(json_build_object('barcode',b.barcode,'marketplaces',COALESCE(b.marketplaces,'[]'::jsonb))) FROM barcodes b WHERE b.product_id=p.id),'[]'::json) AS barcodes FROM products p WHERE p.id=$1`,
        [id]
      )
    ).rows[0];
    const tpl = await productLabelsService.getTemplateForProduct(p, null);
    const wMm = Number(tpl.width_mm) || 58;
    const hMm = Number(tpl.height_mm) || 40;
    const padT = Number(tpl.margin_top_mm) || 2;
    const padB = Number(tpl.margin_bottom_mm) || 2;
    const padL = Number(tpl.margin_left_mm) || 2;
    const padR = Number(tpl.margin_right_mm) || 2;
    const heightPx = hMm * MM_TO_PX;
    const widthPx = wMm * MM_TO_PX;
    const maxContentY = heightPx - padB * MM_TO_PX;
    const innerW = widthPx - (padL + padR) * MM_TO_PX;
    const lineGap = 8;
    const blockGap = lineGap;

    // simulate layout: sku then barcode
    let y = padT * MM_TO_PX;
    const skuFs = 9 * (MM_TO_PX / 3.78); // resolveFontSizePx approx — use 20px-ish
    y += 20 + blockGap; // sku one line

    const nameFs = 24;
    const nameLines = wrapApprox(p.name, innerW, nameFs);
    const nameH = nameLines * (nameFs + lineGap) + blockGap;

    const kitLines = 2; // title + "2x TG-5101"
    const kitFs = 20;
    const kitH = (1 + kitLines) * (kitFs + lineGap) + blockGap;

    const reservedBelow = nameH + kitH;
    const slotMaxY = maxContentY - reservedBelow;
    const digitFs = 14;
    const textGap = 2 + digitFs + 4;
    const minBarcodePx = 8 * MM_TO_PX;
    const available = slotMaxY - y - textGap - blockGap;

    const bc = pickBarcodeForMarketplace(p.barcodes, 'ozon') || p.sku;
    console.log(
      JSON.stringify({
        sku: p.sku,
        barcode: bc,
        nameLines,
        nameH,
        kitH,
        reservedBelow,
        yAfterSku: y,
        maxContentY,
        slotMaxY,
        available,
        minBarcodePx,
        wouldSkipOld: available < minBarcodePx,
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
