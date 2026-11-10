import { query, closePool } from '../../src/config/database.js';
import { getKitComponents } from '../../src/services/kitStock.service.js';

const kit = await query(
  `SELECT id, sku, name, product_type,
          COALESCE(quantity,0)::int AS qty,
          COALESCE(reserved_quantity,0)::int AS reserved
   FROM products WHERE id = 293 OR sku ILIKE '%DTTG5156RL%' OR sku ILIKE 'TG-5156%'`
);
console.log('products', JSON.stringify(kit.rows, null, 2));

const comps = await getKitComponents(293);
console.log('kit 293 components', comps);

// How much of 314 reserved is kit vs direct vs order
const byKind = await query(
  `SELECT
     CASE
       WHEN sm.meta ? 'kit_product_id' THEN 'kit_component'
       WHEN sm.meta ? 'fbo_supply_item_id' THEN 'fbo_direct'
       WHEN sm.meta ? 'order_id' THEN 'order'
       ELSE 'other'
     END AS kind,
     COALESCE(SUM(sm.quantity_change),0)::int AS net,
     sm.warehouse_id
   FROM stock_movements sm
   WHERE sm.product_id = 314 AND sm.type IN ('reserve','unreserve')
   GROUP BY 1, sm.warehouse_id
   ORDER BY 1, sm.warehouse_id`
);
console.log('reserve breakdown 314', byKind.rows);

const enrich = await query(
  `SELECT s.id, s.placement_cluster, si.id AS item_id, si.quantity,
          p.sku,
          (
            SELECT COALESCE(SUM(sm.quantity_change),0)::int
            FROM stock_movements sm
            WHERE sm.type IN ('reserve','unreserve')
              AND sm.meta->>'fbo_supply_item_id' = si.id::text
              AND sm.product_id = 314
          ) AS net_on_314
   FROM fbo_supply_items si
   JOIN fbo_supplies s ON s.id = si.fbo_supply_id
   JOIN products p ON p.id = si.product_id
   WHERE s.id IN (197,199,201,202,203,204)
     AND (si.product_id IN (293,314) OR p.sku ILIKE '%5156%')
   ORDER BY s.id`
);
console.log('supply lines 5156 family', JSON.stringify(enrich.rows, null, 2));

await closePool();
