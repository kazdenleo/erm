/**
 * One-off fixer: split incorrectly merged WB orders by order_id.
 *
 * Usage:
 *   node scripts/fix-wb-order-group.js 4887748810 4888130095
 *
 * It will set order_group_id to a unique value per provided order_id
 * so UI grouping won't merge them.
 */

import { query, closePool } from '../src/config/database.js';

async function main() {
  const ids = process.argv.slice(2).map((s) => String(s || '').trim()).filter(Boolean);
  if (ids.length === 0) {
    console.log('Provide WB order ids. Example: node scripts/fix-wb-order-group.js 4887748810 4888130095');
    process.exit(1);
  }

  const res = await query(
    `UPDATE orders
     SET order_group_id = CONCAT(COALESCE(NULLIF(TRIM(order_group_id), ''), 'wbfix'), '|split|', order_id),
         updated_at = CURRENT_TIMESTAMP
     WHERE (marketplace IN ('wb', 'wildberries'))
       AND order_id = ANY($1::text[])
     RETURNING id, marketplace, order_id, order_group_id`,
    [ids]
  );

  console.log(`[WB split] updated rows: ${res.rows?.length ?? 0}`);
  for (const r of res.rows || []) {
    console.log(`- id=${r.id} mp=${r.marketplace} order_id=${r.order_id} order_group_id=${r.order_group_id}`);
  }
}

main()
  .catch((e) => {
    console.error('[WB split] failed:', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await closePool();
    } catch (_) {}
  });

