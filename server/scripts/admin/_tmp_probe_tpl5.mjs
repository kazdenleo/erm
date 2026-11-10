import { writeFileSync } from 'fs';
import { query, closePool } from '../../src/config/database.js';

const out = [];
const log = (...a) => out.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));

try {
  const t = await query(
    `SELECT id, user_category_id, profile_id, size_preset, width_mm, height_mm, elements
     FROM category_label_templates
     WHERE user_category_id = 12 OR id = 5
     ORDER BY id`
  );
  for (const row of t.rows) {
    const els = typeof row.elements === 'string' ? JSON.parse(row.elements) : row.elements;
    log('tpl', {
      id: row.id,
      cat: row.user_category_id,
      profile: row.profile_id,
      size: row.size_preset,
      wh: [row.width_mm, row.height_mm],
      elements: (els || []).map((e, i) => ({
        i,
        type: e.type,
        enabled: e.enabled,
        widthMm: e.widthMm,
        heightMm: e.heightMm,
        showText: e.showText,
        showSku: e.showSku,
        showName: e.showName,
      })),
    });
  }

  // recent collect scans for TG-5101
  const scans = await query(
    `SELECT s.id, s.fbo_supply_id, s.product_id, kp.sku AS kit_sku, s.scanned_product_id, cp.sku AS scanned_sku,
            s.barcode, s.created_at, s.user_name
     FROM fbo_supply_collect_scans s
     LEFT JOIN products kp ON kp.id = s.product_id
     LEFT JOIN products cp ON cp.id = s.scanned_product_id
     WHERE s.scanned_product_id = 451 OR s.product_id = 322
        OR cp.sku IN ('TG-5101','TG-5102','TG-5103')
     ORDER BY s.id DESC
     LIMIT 30`
  ).catch(async (e) => {
    log('scans err', e.message);
    const tables = await query(
      `SELECT table_name FROM information_schema.tables WHERE table_name ILIKE '%collect%'`
    );
    log('collect tables', tables.rows);
    return { rows: [] };
  });
  log('recent scans', scans.rows);
} catch (e) {
  log('ERROR', e?.stack || e.message);
} finally {
  writeFileSync('/tmp/_tmp_probe_tpl5.out.json', out.join('\n'), 'utf8');
  console.log(out.join('\n'));
  await closePool();
}
