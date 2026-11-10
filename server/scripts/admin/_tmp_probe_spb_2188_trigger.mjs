/** Что триггернуло снятие в 06:19: смотрим stock-movements POST на 520 и nets helper. */
import { query } from '../../src/config/database.js';
import { NET_RESERVED_MOVEMENT_ROW_CASE_SQL } from '../../src/constants/netReservedStockSql.js';

async function main() {
  // movements around the trigger
  const trig = await query(
    `SELECT id, created_at, type, quantity_change, product_id, warehouse_id, reason,
            LEFT(meta::text, 800) AS meta_snip
     FROM stock_movements
     WHERE product_id IN (519, 520, 397)
       AND created_at BETWEEN '2026-10-30 06:18:00' AND '2026-10-30 06:20:00'
     ORDER BY created_at, id`
  );
  console.log('AROUND TRIGGER', JSON.stringify(trig.rows, null, 2));

  // Simulate orphan query for component 520
  const orphan520 = await query(
    `SELECT DISTINCT sm.meta->>'fbo_supply_item_id' AS item_id,
            sm.meta->>'fbo_supply_id' AS supply_id,
            si.product_id AS si_product_id
     FROM stock_movements sm
     LEFT JOIN fbo_supply_items si ON si.id = (sm.meta->>'fbo_supply_item_id')::bigint
     WHERE sm.product_id = 520
       AND (si.id IS NULL OR si.product_id = 520)
       AND sm.type IN ('reserve', 'unreserve')
       AND sm.meta ? 'fbo_supply_item_id'
       AND sm.meta->>'fbo_supply_item_id' ~ '^[0-9]+$'`
  );
  console.log('ORPHAN_QUERY_520', JSON.stringify(orphan520.rows, null, 2));

  // Without product_id filter (buggy old)
  const orphan520buggy = await query(
    `SELECT DISTINCT sm.meta->>'fbo_supply_item_id' AS item_id,
            sm.meta->>'fbo_supply_id' AS supply_id,
            si.product_id AS si_product_id
     FROM stock_movements sm
     LEFT JOIN fbo_supply_items si ON si.id = (sm.meta->>'fbo_supply_item_id')::bigint
     WHERE sm.product_id = 520
       AND sm.type IN ('reserve', 'unreserve')
       AND sm.meta ? 'fbo_supply_item_id'
       AND sm.meta->>'fbo_supply_item_id' ~ '^[0-9]+$'
     LIMIT 30`
  );
  console.log('ORPHAN_QUERY_520_NO_FILTER sample', JSON.stringify(orphan520buggy.rows.slice(0, 20), null, 2));

  // Kit orphan query
  const orphanKit = await query(
    `SELECT DISTINCT sm.meta->>'fbo_supply_item_id' AS item_id,
            sm.meta->>'fbo_supply_id' AS supply_id
     FROM stock_movements sm
     WHERE sm.meta->>'kit_product_id' = '397'
       AND sm.type IN ('reserve', 'unreserve')
       AND sm.meta ? 'fbo_supply_item_id'
       AND sm.meta->>'fbo_supply_item_id' ~ '^[0-9]+$'`
  );
  console.log('ORPHAN_KIT_397 count', orphanKit.rows.length);
  console.log('ORPHAN_KIT_397', JSON.stringify(orphanKit.rows, null, 2));

  // Active queue for 397 and 520
  const q397 = await query(
    `SELECT i.id AS supply_item_id, i.product_id, s.id AS fbo_supply_id, s.status
     FROM fbo_supply_items i
     JOIN fbo_supplies s ON s.id = i.fbo_supply_id
     WHERE i.product_id = 397
       AND s.status = ANY($1::text[])`,
    [['new', 'collecting', 'packing', 'ready_for_supply']]
  );
  console.log('QUEUE_397', JSON.stringify(q397.rows, null, 2));

  const q520 = await query(
    `SELECT i.id AS supply_item_id, i.product_id, s.id AS fbo_supply_id, s.status
     FROM fbo_supply_items i
     JOIN fbo_supplies s ON s.id = i.fbo_supply_id
     WHERE i.product_id = 520
       AND s.status = ANY($1::text[])`,
    [['new', 'collecting', 'packing', 'ready_for_supply']]
  );
  console.log('QUEUE_520', JSON.stringify(q520.rows, null, 2));

  // Nets for item 11816 after the wipe
  const net = await query(
    `SELECT product_id, warehouse_id,
            GREATEST(0, COALESCE(SUM(${NET_RESERVED_MOVEMENT_ROW_CASE_SQL}), 0))::int AS net
     FROM stock_movements
     WHERE meta->>'fbo_supply_item_id' = '11816'
       AND type IN ('reserve', 'unreserve')
     GROUP BY 1,2`
  );
  console.log('NET_11816_NOW', JSON.stringify(net.rows, null, 2));

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
