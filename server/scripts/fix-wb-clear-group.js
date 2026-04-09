/**
 * One-off fixer: clear WB order_group_id for specific WB order_id(s).
 *
 * Usage:
 *   node scripts/fix-wb-clear-group.js 4887748810 4887748811
 */
import { query, closePool } from '../src/config/database.js';

async function main() {
  const ids = process.argv.slice(2).map((s) => String(s || '').trim()).filter(Boolean);
  if (ids.length === 0) {
    console.log('Provide WB order ids. Example: node scripts/fix-wb-clear-group.js 4887748810 4887748811');
    process.exit(1);
  }
  const res = await query(
    `UPDATE orders
     SET order_group_id = NULL,
         updated_at = CURRENT_TIMESTAMP
     WHERE marketplace IN ('wb', 'wildberries')
       AND order_id = ANY($1::text[])
     RETURNING id, marketplace, order_id, order_group_id`,
    [ids]
  );
  console.log(`[WB clear group] updated rows: ${res.rows?.length ?? 0}`);
  for (const r of res.rows || []) {
    console.log(`- id=${r.id} mp=${r.marketplace} order_id=${r.order_id} order_group_id=${r.order_group_id}`);
  }
}

main()
  .catch((e) => {
    console.error('[WB clear group] failed:', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await closePool();
    } catch (_) {}
  });

