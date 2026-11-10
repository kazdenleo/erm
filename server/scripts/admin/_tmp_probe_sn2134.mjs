/**
 * Probe SN2134-35: purchase incoming, FBO reserve coverage, stock
 */
import { query, closePool } from '../../src/config/database.js';
import fboSupplyReserveService from '../../src/services/fboSupplyReserve.service.js';
import { getKitComponents } from '../../src/services/kitStock.service.js';

async function main() {
  const products = await query(
    `SELECT id, sku, name, product_type, profile_id,
            COALESCE(quantity,0)::int AS qty,
            COALESCE(reserved_quantity,0)::int AS reserved,
            COALESCE(incoming_quantity,0)::int AS incoming
     FROM products
     WHERE sku ILIKE '%SN2134%' OR sku ILIKE '%SN-2134%' OR sku ILIKE '%2134-35%'
        OR sku ILIKE '%SN2135%' OR name ILIKE '%SN2134%'
     ORDER BY sku`
  );
  console.log('=== products ===');
  console.log(JSON.stringify(products.rows, null, 2));

  for (const p of products.rows) {
    const pid = Number(p.id);
    console.log(`\n=== product ${p.sku} id=${pid} ===`);

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
        console.log('  comp stock', cr.rows[0]);
        const wh = await query(
          `SELECT warehouse_id, quantity FROM product_warehouse_stock
           WHERE product_id = $1 AND quantity <> 0 ORDER BY warehouse_id`,
          [c.component_product_id]
        );
        if (wh.rows.length) console.log('  comp wh', wh.rows);
      }
    }

    const openPi = await query(
      `SELECT p.id AS purchase_id, p.status, p.warehouse_id, w.name AS wh_name,
              pi.expected_quantity, pi.received_quantity,
              GREATEST(0, pi.expected_quantity - COALESCE(pi.received_quantity,0)) AS open_qty,
              p.ordered_at
       FROM purchase_items pi
       JOIN purchases p ON p.id = pi.purchase_id
       LEFT JOIN warehouses w ON w.id = p.warehouse_id
       WHERE pi.product_id = $1
         AND p.status = 'open'
         AND pi.expected_quantity > COALESCE(pi.received_quantity, 0)
       ORDER BY p.id DESC
       LIMIT 20`,
      [pid]
    );
    console.log('open purchases (direct)', openPi.rows);

    if (comps?.length) {
      for (const c of comps) {
        const openC = await query(
          `SELECT p.id AS purchase_id, p.status, p.warehouse_id, w.name AS wh_name,
                  pi.product_id, pr.sku,
                  pi.expected_quantity, pi.received_quantity,
                  GREATEST(0, pi.expected_quantity - COALESCE(pi.received_quantity,0)) AS open_qty
           FROM purchase_items pi
           JOIN purchases p ON p.id = pi.purchase_id
           JOIN products pr ON pr.id = pi.product_id
           LEFT JOIN warehouses w ON w.id = p.warehouse_id
           WHERE pi.product_id = $1
             AND p.status = 'open'
             AND pi.expected_quantity > COALESCE(pi.received_quantity, 0)
           ORDER BY p.id DESC
           LIMIT 10`,
          [c.component_product_id]
        );
        console.log(`open purchases comp ${c.component_sku}`, openC.rows);
      }
    }

    const supplies = await query(
      `SELECT s.id AS supply_id, s.status, s.ready_at, s.deduct_stock_on_ship,
              s.deduction_warehouse_id, s.external_shipment_number,
              si.id AS item_id, si.quantity, si.product_id,
              pr.sku
       FROM fbo_supply_items si
       JOIN fbo_supplies s ON s.id = si.fbo_supply_id
       JOIN products pr ON pr.id = si.product_id
       WHERE si.product_id = $1
         AND s.status IN ('new','packed','ready_for_supply')
       ORDER BY s.ready_at NULLS LAST, s.id, si.id`,
      [pid]
    );
    console.log('active FBO items', supplies.rows);

    if (supplies.rows.length) {
      const enriched = await fboSupplyReserveService.enrichItemsWithReserved(
        supplies.rows.map((r) => ({
          id: r.item_id,
          productId: r.product_id,
          quantity: r.quantity,
        })),
        { profileId: p.profile_id, reserveEnabled: true }
      );
      console.log(
        'enrich',
        enriched.map((e) => ({
          id: e.id,
          qty: e.quantity,
          reserved: e.reserved,
          reservedFromStock: e.reservedFromStock,
          reservedFromIncoming: e.reservedFromIncoming,
        }))
      );
    }

    // profile FBO deduction wh
    const prof = await query(
      `SELECT id, fbo_deduction_warehouse_id FROM profiles WHERE id = $1`,
      [p.profile_id]
    );
    console.log('profile fbo wh', prof.rows[0]);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closePool());
