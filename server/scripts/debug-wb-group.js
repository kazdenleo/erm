/**
 * Debug helper: print orders by WB order_group_id prefix.
 *
 * Usage:
 *   node scripts/debug-wb-group.js d05c094a8b374aebb965fc93cf6765ad
 */
import { query, closePool } from '../src/config/database.js';

async function main() {
  const gid = String(process.argv[2] || '').trim();
  if (!gid) {
    console.log('Usage: node scripts/debug-wb-group.js <order_group_id>');
    process.exit(1);
  }
  const r = await query(
    `SELECT id, marketplace, order_id, order_group_id, offer_id, product_name, created_at, status
     FROM orders
     WHERE marketplace IN ('wb', 'wildberries')
       AND (order_group_id = $1 OR order_group_id LIKE $1 || '%')
     ORDER BY created_at ASC, id ASC
     LIMIT 200`,
    [gid]
  );
  console.log(JSON.stringify(r.rows || [], null, 2));
}

main()
  .catch((e) => {
    console.error('[debug-wb-group] failed:', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await closePool();
    } catch (_) {}
  });

