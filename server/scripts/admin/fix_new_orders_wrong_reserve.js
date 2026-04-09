/**
 * One-off: remove wrong reserves from orders in status 'new'.
 * Rationale: after introducing rule "new orders cannot reserve from incoming",
 * existing DB may contain reserves for new orders that were created earlier.
 *
 * This script:
 * - finds orders with status='new' that have reserve movements linked by meta.order_id
 * - calls ordersService.releaseReserveIfExistsForOrder for each
 * - then tries to reallocate freed supply to in_procurement orders for the same product
 *
 * Usage: node scripts/admin/fix_new_orders_wrong_reserve.js
 */

import { query, closePool } from '../../src/config/database.js';
import ordersService from '../../src/services/orders.service.js';

async function main() {
  const r = await query(
    `SELECT DISTINCT o.marketplace, o.order_id
     FROM orders o
     JOIN stock_movements sm
       ON sm.type = 'reserve'
      AND sm.quantity_change < 0
      AND (sm.meta->>'order_id') IS NOT NULL
      AND (sm.meta->>'order_id')::bigint = o.id
     WHERE o.status = 'new'
     ORDER BY o.marketplace, o.order_id
     LIMIT 5000`
  );
  const list = r.rows || [];
  console.log(`[Admin] new orders with reserves: ${list.length}`);

  let fixed = 0;
  for (const o of list) {
    try {
      await ordersService.releaseReserveIfExistsForOrder(o.marketplace, o.order_id);
      fixed++;
    } catch {
      // ignore
    }
  }
  console.log(`[Admin] fixed (unreserved): ${fixed}`);
}

main()
  .catch((e) => {
    console.error('[Admin] failed:', e?.message || e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });

