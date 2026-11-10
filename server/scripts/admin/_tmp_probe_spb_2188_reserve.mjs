/**
 * Диагностика: почему сбросился FBO-резерв по SN-2188 / SN-2189 (Санкт-Петербург).
 */
import { query } from '../../src/config/database.js';

const PIDS = [397, 519, 520]; // kit DTSN2188-89RL, SN-2188, SN-2189

async function main() {
  const products = await query(
    `SELECT id, sku, name, reserved_quantity FROM products WHERE id = ANY($1::bigint[]) ORDER BY id`,
    [PIDS]
  );
  console.log('=== PRODUCTS ===');
  console.log(JSON.stringify(products.rows, null, 2));

  const items = await query(
    `SELECT s.id AS supply_id, s.status, s.marketplace, s.name AS supply_name,
            s.marketplace_warehouse_name, s.marketplace_warehouse_id, s.placement_cluster,
            s.external_shipment_number, s.external_supply_id,
            s.deduction_warehouse_id, s.deduct_stock, s.updated_at, s.created_at, s.ready_at,
            i.id AS item_id, i.product_id, i.sku AS item_sku, i.quantity, i.collected_quantity,
            COALESCE(p.sku, i.sku) AS product_sku, COALESCE(p.name, i.name) AS product_name
     FROM fbo_supply_items i
     JOIN fbo_supplies s ON s.id = i.fbo_supply_id
     LEFT JOIN products p ON p.id = i.product_id
     WHERE i.product_id = ANY($1::bigint[])
     ORDER BY s.id DESC, i.id
     LIMIT 80`,
    [PIDS]
  );
  console.log('=== ALL SUPPLY ITEMS ===');
  console.log(JSON.stringify(items.rows, null, 2));

  const spb = (items.rows || []).filter((r) => {
    const blob = [
      r.marketplace_warehouse_name,
      r.placement_cluster,
      r.supply_name,
      r.external_shipment_number,
    ]
      .map((x) => String(x || '').toLowerCase())
      .join(' ');
    return (
      blob.includes('петерб') ||
      blob.includes('санкт') ||
      blob.includes('spb') ||
      blob.includes('питер') ||
      blob.includes('ленинград')
    );
  });
  console.log('=== SPB FILTERED ===');
  console.log(JSON.stringify(spb, null, 2));

  const focus = spb.length ? spb : items.rows || [];
  const itemIds = focus.map((r) => Number(r.item_id));
  const supplyIds = [...new Set(focus.map((r) => Number(r.supply_id)))];

  const nets = await query(
    `SELECT sm.meta->>'fbo_supply_item_id' AS supply_item_id,
            sm.meta->>'fbo_supply_id' AS supply_id,
            sm.product_id,
            sm.warehouse_id,
            SUM(CASE WHEN sm.type = 'reserve' THEN sm.quantity
                     WHEN sm.type = 'unreserve' THEN -sm.quantity
                     ELSE 0 END)::int AS net,
            COUNT(*)::int AS moves,
            MIN(sm.created_at) AS first_at,
            MAX(sm.created_at) AS last_at
     FROM stock_movements sm
     WHERE sm.type IN ('reserve', 'unreserve')
       AND (
         sm.meta->>'fbo_supply_item_id' = ANY($1::text[])
         OR sm.meta->>'fbo_supply_id' = ANY($2::text[])
       )
     GROUP BY 1, 2, 3, 4
     ORDER BY last_at DESC NULLS LAST`,
    [itemIds.map(String), supplyIds.map(String)]
  );
  console.log('=== NET RESERVE ===');
  console.log(JSON.stringify(nets.rows, null, 2));

  const recent = await query(
    `SELECT sm.id, sm.created_at, sm.type, sm.quantity, sm.product_id, sm.warehouse_id,
            sm.meta->>'fbo_supply_item_id' AS supply_item_id,
            sm.meta->>'fbo_supply_id' AS supply_id,
            sm.meta->>'manual_unreserve' AS manual_unreserve,
            sm.meta->>'fbo_rebalance_unreserve' AS fbo_rebalance_unreserve,
            sm.meta->>'fbo_bulk_rebalance' AS fbo_bulk_rebalance,
            sm.meta->>'reason' AS reason,
            sm.meta->>'source' AS source,
            LEFT(COALESCE(sm.meta::text, ''), 600) AS meta_snip
     FROM stock_movements sm
     WHERE sm.product_id = ANY($1::bigint[])
       AND sm.type IN ('reserve', 'unreserve')
       AND (
         sm.meta->>'fbo_supply_item_id' = ANY($2::text[])
         OR sm.meta->>'fbo_supply_id' = ANY($3::text[])
       )
     ORDER BY sm.created_at DESC
     LIMIT 120`,
    [PIDS, itemIds.map(String), supplyIds.map(String)]
  );
  console.log('=== RECENT MOVEMENTS ===');
  console.log(JSON.stringify(recent.rows, null, 2));

  // Also look for any unreserve today on these products globally
  const todayUn = await query(
    `SELECT sm.id, sm.created_at, sm.type, sm.quantity, sm.product_id, sm.warehouse_id,
            sm.meta->>'fbo_supply_item_id' AS supply_item_id,
            sm.meta->>'fbo_supply_id' AS supply_id,
            sm.meta->>'manual_unreserve' AS manual_unreserve,
            sm.meta->>'fbo_rebalance_unreserve' AS fbo_rebalance_unreserve,
            sm.meta->>'fbo_bulk_rebalance' AS fbo_bulk_rebalance,
            LEFT(COALESCE(sm.meta::text, ''), 500) AS meta_snip
     FROM stock_movements sm
     WHERE sm.product_id = ANY($1::bigint[])
       AND sm.type = 'unreserve'
       AND sm.created_at >= NOW() - INTERVAL '3 days'
     ORDER BY sm.created_at DESC
     LIMIT 80`,
    [PIDS]
  );
  console.log('=== UNRESERVE LAST 3 DAYS (ALL) ===');
  console.log(JSON.stringify(todayUn.rows, null, 2));

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
