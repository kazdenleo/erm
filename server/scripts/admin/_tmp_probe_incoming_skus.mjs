import { query, closePool } from '../../src/config/database.js';

const skus = ['SM-5005', 'SN-2170'];
const prods = await query(
  `SELECT id, sku, name, profile_id, COALESCE(incoming_quantity,0)::int AS inc
   FROM products WHERE UPPER(TRIM(sku)) = ANY($1::text[])`,
  [skus.map((s) => s.toUpperCase())]
);
console.log('products', prods.rows);
const ids = prods.rows.map((r) => Number(r.id));
if (!ids.length) {
  await closePool();
  process.exit(0);
}

const purchases = await query(
  `SELECT p.id AS purchase_id, p.status, p.warehouse_id, w.is_fbo_stock, p.profile_id,
          pi.product_id, pr.sku,
          pi.expected_quantity, pi.received_quantity,
          GREATEST(0, COALESCE(pi.expected_quantity,0)-COALESCE(pi.received_quantity,0))::int AS pending
   FROM purchase_items pi
   JOIN purchases p ON p.id = pi.purchase_id
   JOIN products pr ON pr.id = pi.product_id
   LEFT JOIN warehouses w ON w.id = p.warehouse_id
   WHERE pi.product_id = ANY($1::bigint[])
     AND p.status = 'open'
   ORDER BY pr.sku, p.id`,
  [ids]
);
console.log('open purchases pending', purchases.rows);

const kits = await query(
  `SELECT kc.kit_product_id, pk.sku AS kit_sku, kc.component_product_id, pc.sku AS comp_sku,
          kc.quantity::int AS per_kit
   FROM kit_components kc
   JOIN products pc ON pc.id = kc.component_product_id
   JOIN products pk ON pk.id = kc.kit_product_id
   WHERE kc.component_product_id = ANY($1::bigint[])`,
  [ids]
);
console.log('kits using these components', kits.rows);
const kitIds = [...new Set(kits.rows.map((r) => Number(r.kit_product_id)))];

const plainLines = await query(
  `SELECT si.id AS item_id, si.fbo_supply_id, s.status, s.external_shipment_number,
          s.deduct_stock, s.ready_at, si.product_id, pr.sku, si.quantity::int AS qty
   FROM fbo_supply_items si
   JOIN fbo_supplies s ON s.id = si.fbo_supply_id
   JOIN products pr ON pr.id = si.product_id
   WHERE si.product_id = ANY($1::bigint[])
     AND s.status = ANY(ARRAY['new','packed','ready_for_supply']::text[])
   ORDER BY pr.sku, s.ready_at NULLS LAST, s.id`,
  [ids]
);
console.log('active fbo lines (direct SKU)', plainLines.rows);

if (kitIds.length) {
  const kitLines = await query(
    `SELECT si.id AS item_id, si.fbo_supply_id, s.status, s.external_shipment_number,
            s.deduct_stock, s.ready_at, si.product_id, pr.sku AS kit_sku, si.quantity::int AS qty
     FROM fbo_supply_items si
     JOIN fbo_supplies s ON s.id = si.fbo_supply_id
     JOIN products pr ON pr.id = si.product_id
     WHERE si.product_id = ANY($1::bigint[])
       AND s.status = ANY(ARRAY['new','packed','ready_for_supply']::text[])
     ORDER BY pr.sku, s.ready_at NULLS LAST, s.id`,
    [kitIds]
  );
  console.log('active fbo kit lines', kitLines.rows);
}

const profileId = prods.rows[0]?.profile_id;
if (profileId) {
  const { default: fboSupplyReserveService } = await import(
    '../../src/services/fboSupplyReserve.service.js'
  );
  const fboWh = await query(
    `SELECT id FROM warehouses
     WHERE profile_id = $1 AND is_fbo_stock = TRUE AND type = 'warehouse' LIMIT 1`,
    [profileId]
  );
  const whId = fboWh.rows[0]?.id;
  console.log('fbo wh', whId);

  // All active supplies for this profile (simulate calc with empty exclude vs with none)
  const allActive = await query(
    `SELECT id FROM fbo_supplies
     WHERE profile_id = $1 AND status = ANY(ARRAY['new','packed','ready_for_supply']::text[])`,
    [profileId]
  );
  const allIds = allActive.rows.map((r) => Number(r.id));
  console.log('active supply count', allIds.length);

  const freeNone = await fboSupplyReserveService.getAvailableStockAndIncomingForPurchaseCalc(ids, {
    profileId,
    warehouseId: whId,
    excludeSupplyIds: [],
  });
  console.log(
    'free if calc includes NO supplies (all others claim)',
    [...freeNone.entries()].map(([k, v]) => ({ productId: k, ...v }))
  );

  const freeAll = await fboSupplyReserveService.getAvailableStockAndIncomingForPurchaseCalc(ids, {
    profileId,
    warehouseId: whId,
    excludeSupplyIds: allIds,
  });
  console.log(
    'free if calc includes ALL supplies (nobody else claims)',
    [...freeAll.entries()].map(([k, v]) => ({ productId: k, ...v }))
  );
}

process.exit(0);
