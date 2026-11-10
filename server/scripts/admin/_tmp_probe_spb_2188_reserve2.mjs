/**
 * Углублённо: поставка 204 (СПб) комплект DTSN2188-89RL и компоненты SN-2188/89.
 */
import { query } from '../../src/config/database.js';

async function main() {
  const supplyId = 204;
  const itemId = 11816;
  const pids = [397, 519, 520];

  const nets = await query(
    `SELECT sm.meta->>'fbo_supply_item_id' AS supply_item_id,
            sm.meta->>'fbo_supply_id' AS supply_id,
            sm.product_id, p.sku,
            sm.warehouse_id,
            SUM(-sm.quantity_change)::int AS net_reserve_units,
            COUNT(*)::int AS moves,
            MIN(sm.created_at) AS first_at,
            MAX(sm.created_at) AS last_at
     FROM stock_movements sm
     LEFT JOIN products p ON p.id = sm.product_id
     WHERE sm.type IN ('reserve','unreserve')
       AND (
         sm.meta->>'fbo_supply_item_id' = $1
         OR sm.meta->>'fbo_supply_id' = $2
       )
     GROUP BY 1,2,3,4,5
     ORDER BY last_at DESC NULLS LAST`,
    [String(itemId), String(supplyId)]
  );
  console.log('NETS_SUPPLY204', JSON.stringify(nets.rows, null, 2));

  const moves = await query(
    `SELECT sm.id, sm.created_at, sm.type, sm.quantity_change, sm.product_id, p.sku,
            sm.warehouse_id,
            sm.meta->>'fbo_supply_item_id' AS supply_item_id,
            sm.meta->>'fbo_supply_id' AS supply_id,
            sm.meta->>'manual_unreserve' AS manual_unreserve,
            sm.meta->>'fbo_rebalance_unreserve' AS fbo_rebalance_unreserve,
            sm.meta->>'fbo_bulk_rebalance' AS fbo_bulk_rebalance,
            sm.meta->>'kit_reserve_scope' AS kit_reserve_scope,
            sm.meta->>'kit_product_id' AS kit_product_id,
            sm.reason,
            LEFT(sm.meta::text, 700) AS meta_snip
     FROM stock_movements sm
     LEFT JOIN products p ON p.id = sm.product_id
     WHERE sm.type IN ('reserve','unreserve')
       AND (
         sm.meta->>'fbo_supply_item_id' = $1
         OR sm.meta->>'fbo_supply_id' = $2
         OR (
           sm.product_id = ANY($3::bigint[])
           AND sm.created_at >= NOW() - INTERVAL '5 days'
           AND (sm.meta ? 'fbo_supply_item_id' OR sm.meta ? 'kit_product_id'
                OR COALESCE(sm.meta->>'manual_unreserve','') IN ('true','t'))
         )
       )
     ORDER BY sm.created_at DESC
     LIMIT 200`,
    [String(itemId), String(supplyId), pids]
  );
  console.log('MOVES', JSON.stringify(moves.rows, null, 2));

  const active = await query(
    `SELECT s.id, s.status, s.placement_cluster, s.ready_at, i.id AS item_id,
            i.quantity, i.collected_quantity, i.product_id, p.sku
     FROM fbo_supply_items i
     JOIN fbo_supplies s ON s.id = i.fbo_supply_id
     LEFT JOIN products p ON p.id = i.product_id
     WHERE i.product_id = ANY($1::bigint[])
       AND s.status IN ('new','collecting','packing','ready_for_supply')
     ORDER BY s.ready_at NULLS LAST, s.id`,
    [pids]
  );
  console.log('ACTIVE QUEUE', JSON.stringify(active.rows, null, 2));

  // Net by product overall (journal)
  const productNet = await query(
    `SELECT sm.product_id, p.sku, sm.warehouse_id,
            SUM(-sm.quantity_change)::int AS net_reserve
     FROM stock_movements sm
     JOIN products p ON p.id = sm.product_id
     WHERE sm.product_id = ANY($1::bigint[])
       AND sm.type IN ('reserve','unreserve')
     GROUP BY 1,2,3
     HAVING SUM(-sm.quantity_change) <> 0
     ORDER BY 1,3`,
    [pids]
  );
  console.log('PRODUCT_NET', JSON.stringify(productNet.rows, null, 2));

  // recent unreserve for components with kit meta
  const kitUn = await query(
    `SELECT sm.id, sm.created_at, sm.type, sm.quantity_change, sm.product_id, p.sku,
            sm.meta->>'fbo_supply_item_id' AS supply_item_id,
            sm.meta->>'fbo_supply_id' AS supply_id,
            sm.meta->>'kit_product_id' AS kit_product_id,
            sm.meta->>'fbo_rebalance_unreserve' AS fbo_rebalance_unreserve,
            sm.reason,
            LEFT(sm.meta::text, 500) AS meta_snip
     FROM stock_movements sm
     JOIN products p ON p.id = sm.product_id
     WHERE sm.product_id IN (519, 520)
       AND sm.type IN ('reserve','unreserve')
       AND sm.created_at >= NOW() - INTERVAL '14 days'
     ORDER BY sm.created_at DESC
     LIMIT 100`,
    []
  );
  console.log('COMPONENT_MOVES_14D', JSON.stringify(kitUn.rows, null, 2));

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
