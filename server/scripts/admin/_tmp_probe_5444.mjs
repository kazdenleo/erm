/**
 * Probe kits/products *5444* / *5445*: labels + FBO path coverage
 */
import { query, closePool } from '../../src/config/database.js';
import fboSupplyReserveService from '../../src/services/fboSupplyReserve.service.js';
import productLabelsService from '../../src/services/productLabels.service.js';
import sharp from 'sharp';

async function barcodeBandScore(pngBuffer) {
  const { data, info } = await sharp(pngBuffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const y0 = Math.floor(height * 0.05);
  const y1 = Math.floor(height * 0.7);
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
  const products = await query(
    `SELECT id, sku, name, product_type, profile_id,
            COALESCE(quantity,0)::int AS qty,
            COALESCE(reserved_quantity,0)::int AS reserved,
            COALESCE(incoming_quantity,0)::int AS incoming
     FROM products
     WHERE sku ILIKE '%5444%' OR sku ILIKE '%5445%'
        OR name ILIKE '%5444%' OR name ILIKE '%5445%'
     ORDER BY sku
     LIMIT 40`
  );
  console.log('products', JSON.stringify(products.rows, null, 2));

  const links = await query(
    `SELECT k.id AS kit_id, k.sku AS kit_sku, k.product_type,
            c.id AS comp_id, c.sku AS comp_sku, kc.quantity,
            COALESCE(c.quantity,0)::int AS stock_qty,
            COALESCE(c.incoming_quantity,0)::int AS incoming
     FROM kit_components kc
     JOIN products k ON k.id = kc.kit_product_id
     JOIN products c ON c.id = kc.component_product_id
     WHERE k.sku ILIKE '%5444%' OR k.sku ILIKE '%5445%'
        OR c.sku ILIKE '%5444%' OR c.sku ILIKE '%5445%'
     ORDER BY k.sku, c.sku`
  );
  console.log('kit links', JSON.stringify(links.rows, null, 2));

  const kitIds = [...new Set(links.rows.map((r) => Number(r.kit_id)))];
  for (const kid of kitIds) {
    const p = products.rows.find((r) => Number(r.id) === kid) || (
      await query(`SELECT id, sku, name, product_type, profile_id FROM products WHERE id=$1`, [kid])
    ).rows[0];
    if (!p) continue;
    console.log('\n=== kit', p.sku, 'id', p.id, '===');
    try {
      const { pngBuffer } = await productLabelsService.renderProductLabel(Number(p.id), {
        marketplace: 'ozon',
        format: 'png',
      });
      const score = await barcodeBandScore(pngBuffer);
      console.log('label', { pngBytes: pngBuffer.length, ...score });
    } catch (e) {
      console.log('label err', e.message);
    }

    const supplies = await query(
      `SELECT s.id AS supply_id, s.status, si.id AS item_id, si.quantity, si.product_id
       FROM fbo_supply_items si
       JOIN fbo_supplies s ON s.id = si.fbo_supply_id
       WHERE si.product_id = $1 AND s.status IN ('new','packed','ready_for_supply')
       ORDER BY s.id`,
      [p.id]
    );
    if (!supplies.rows.length) {
      console.log('no active FBO lines');
      continue;
    }
    const enriched = await fboSupplyReserveService.enrichItemsWithReserved(
      supplies.rows.map((r) => ({ id: r.item_id, productId: r.product_id, quantity: r.quantity })),
      { profileId: p.profile_id, reserveEnabled: true }
    );
    console.log(
      'fbo',
      enriched.map((e, i) => ({
        supply: supplies.rows[i].supply_id,
        qty: e.quantity,
        stock: e.reservedFromStock,
        path: e.reservedFromIncoming,
        srcOn: e.sourceOnHand,
        srcPath: e.sourceIncoming,
      }))
    );
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closePool());
