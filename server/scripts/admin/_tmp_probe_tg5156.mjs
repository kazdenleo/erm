import { query, closePool } from '../../src/config/database.js';
import { getKitComponents } from '../../src/services/kitStock.service.js';
import fboSupplyReserveService from '../../src/services/fboSupplyReserve.service.js';

const sku = 'TG-5156';

const products = await query(
  `SELECT id, sku, name, product_type, profile_id,
          COALESCE(quantity,0)::int AS qty,
          COALESCE(reserved_quantity,0)::int AS reserved,
          COALESCE(incoming_quantity,0)::int AS incoming
   FROM products
   WHERE sku ILIKE $1 OR sku ILIKE $2
   ORDER BY sku`,
  [sku, `%${sku}%`]
);
console.log('=== products ===');
console.log(JSON.stringify(products.rows, null, 2));

for (const p of products.rows) {
  const pid = Number(p.id);
  console.log(`\n=== product ${p.sku} id=${pid} free=${p.qty - p.reserved} ===`);

  const comps = await getKitComponents(pid);
  if (comps?.length) {
    console.log(
      'kit comps',
      comps.map((c) => ({
        id: c.component_product_id,
        sku: c.component_sku,
        qty: c.quantity,
      }))
    );
    for (const c of comps) {
      const cr = await query(
        `SELECT id, sku,
                COALESCE(quantity,0)::int AS qty,
                COALESCE(reserved_quantity,0)::int AS reserved,
                COALESCE(incoming_quantity,0)::int AS incoming
         FROM products WHERE id = $1`,
        [c.component_product_id]
      );
      const row = cr.rows[0];
      if (row) {
        console.log('  component stock', {
          sku: row.sku,
          qty: row.qty,
          reserved: row.reserved,
          incoming: row.incoming,
          free: row.qty - row.reserved,
          needPerKit: c.quantity,
        });
      }
    }
  }

  // warehouse balances
  const wh = await query(
    `SELECT wh.id, wh.name, wh.code,
            COALESCE(ws.quantity,0)::int AS qty,
            COALESCE(ws.reserved_quantity,0)::int AS reserved,
            COALESCE(ws.incoming_quantity,0)::int AS incoming
     FROM warehouses wh
     LEFT JOIN warehouse_stocks ws ON ws.warehouse_id = wh.id AND ws.product_id = $1
     WHERE COALESCE(ws.quantity,0) <> 0 OR COALESCE(ws.reserved_quantity,0) <> 0
        OR COALESCE(ws.incoming_quantity,0) <> 0
     ORDER BY wh.id`,
    [pid]
  ).catch(async (e) => {
    console.log('wh stocks err', e.message);
    // try product_warehouse_stocks / warehouse_product_stock
    const tables = await query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema='public' AND (
        table_name ILIKE '%warehouse%stock%' OR table_name ILIKE '%stock%warehouse%'
      ) ORDER BY table_name`);
    console.log('stock tables', tables.rows.map((r) => r.table_name));
    return { rows: [] };
  });
  console.log('warehouse stocks', JSON.stringify(wh.rows, null, 2));

  // FBO supplies mentioning this product / Saratov
  const supplies = await query(
    `SELECT s.id, s.status, s.marketplace, s.warehouse_name, s.name, s.external_id,
            si.id AS item_id, si.quantity, si.reserved_qty, si.product_id, p.sku
     FROM fbo_supply_items si
     JOIN fbo_supplies s ON s.id = si.supply_id
     JOIN products p ON p.id = si.product_id
     WHERE si.product_id = $1
        OR s.warehouse_name ILIKE '%Сарат%' OR s.name ILIKE '%Сарат%'
     ORDER BY s.id DESC
     LIMIT 40`,
    [pid]
  ).catch(async (e) => {
    console.log('fbo query err', e.message);
    const cols = await query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'fbo_supplies' ORDER BY ordinal_position`);
    console.log('fbo_supplies cols', cols.rows.map((r) => r.column_name).join(', '));
    const icols = await query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'fbo_supply_items' ORDER BY ordinal_position`);
    console.log('fbo_supply_items cols', icols.rows.map((r) => r.column_name).join(', '));
    return { rows: [] };
  });
  console.log('fbo supplies (product or Saratov)', JSON.stringify(supplies.rows, null, 2));

  // reserves for this product
  const reserves = await query(
    `SELECT *
     FROM fbo_supply_reserves
     WHERE product_id = $1
     ORDER BY id DESC
     LIMIT 30`,
    [pid]
  ).catch(async (e) => {
    console.log('reserves err', e.message);
    const t = await query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema='public' AND table_name ILIKE '%fbo%reserv%'
      ORDER BY table_name`);
    console.log('reserve tables', t.rows.map((r) => r.table_name));
    return { rows: [] };
  });
  console.log('fbo reserves', JSON.stringify(reserves.rows, null, 2));

  // path / coverage via service if available
  try {
    if (typeof fboSupplyReserveService.getProductCoverage === 'function') {
      const cov = await fboSupplyReserveService.getProductCoverage(pid);
      console.log('coverage', JSON.stringify(cov, null, 2));
    }
  } catch (e) {
    console.log('coverage err', e.message);
  }
}

await closePool();
