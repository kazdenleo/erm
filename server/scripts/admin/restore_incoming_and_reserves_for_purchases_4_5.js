/**
 * Admin one-off: restore stock_movements history for purchases #4 and #5
 * after a hard reset of stock_movements.
 *
 * What it does:
 * - Clears stock_movements (again) and rebuilds incoming movements from purchase_items of purchases 4 & 5
 * - Recalculates products.incoming_quantity accordingly (from 0 upward)
 * - Applies reserves for linked source_orders (only if order is in_procurement and supply is available)
 *
 * Usage:
 *   node scripts/admin/restore_incoming_and_reserves_for_purchases_4_5.js
 */

import { transaction } from '../../src/config/database.js';
import { query, closePool } from '../../src/config/database.js';
import ordersService from '../../src/services/orders.service.js';

function parseSourceOrders(raw) {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const j = JSON.parse(raw);
      return Array.isArray(j) ? j : [];
    } catch {
      return [];
    }
  }
  return [];
}

async function main() {
  const keep = [4, 5];

  const sourceOrders = [];

  await transaction(async (client) => {
    // rebuild from clean slate
    await client.query('TRUNCATE TABLE stock_movements RESTART IDENTITY CASCADE');

    await client.query(
      `UPDATE products
       SET incoming_quantity = 0,
           reserved_quantity = 0,
           updated_at = CURRENT_TIMESTAMP`
    );

    // also clear per-warehouse fact (just in case)
    try {
      await client.query(`UPDATE product_warehouse_stock SET quantity = 0`);
    } catch {
      // ignore if table not present
    }

    for (const purchaseId of keep) {
      const rows = await client.query(
        `SELECT product_id, expected_quantity, received_quantity, source_orders
         FROM purchase_items
         WHERE purchase_id = $1
         ORDER BY id ASC`,
        [purchaseId]
      );

      for (const r of rows.rows || []) {
        const productId = Number(r.product_id);
        const expected = r.expected_quantity != null ? Number(r.expected_quantity) : 0;
        const received = r.received_quantity != null ? Number(r.received_quantity) : 0;
        const rem = Math.max(0, expected - received);
        if (!productId || rem <= 0) continue;

        await client.query('SELECT id FROM products WHERE id = $1 FOR UPDATE', [productId]);
        const cur = await client.query('SELECT COALESCE(incoming_quantity, 0) AS inc FROM products WHERE id = $1', [productId]);
        const inc = cur.rows?.[0]?.inc != null ? Number(cur.rows[0].inc) : 0;
        const newInc = inc + rem;

        await client.query(
          `UPDATE products
           SET incoming_quantity = $1,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $2`,
          [newInc, productId]
        );

        await client.query(
          `INSERT INTO stock_movements (product_id, type, quantity_change, balance_after, reason, meta)
           VALUES ($1, 'incoming', $2, $3, $4, $5::jsonb)`,
          [
            productId,
            rem,
            newInc,
            `Закупка №${purchaseId} — ожидание`,
            JSON.stringify({ purchase_id: purchaseId, restored_after_reset: true }),
          ]
        );

        const list = parseSourceOrders(r.source_orders);
        for (const o of list) {
          if (!o || !o.marketplace || o.orderId == null) continue;
          sourceOrders.push({ marketplace: String(o.marketplace), orderId: String(o.orderId) });
        }
      }
    }
  });

  // After tx: apply reserves for linked orders (idempotent / partial / guarded by availability)
  const uniq = new Map();
  for (const o of sourceOrders) {
    const k = `${String(o.marketplace || '').toLowerCase()}|${String(o.orderId ?? '')}`;
    if (!k.endsWith('|')) uniq.set(k, o);
  }
  let ensured = 0;
  for (const o of uniq.values()) {
    try {
      await ordersService.ensureReserveForOrderIfInProcurement(o.marketplace, o.orderId);
      ensured++;
    } catch {
      // ignore
    }
  }

  // ВАЖНО: пересборку резервов тут НЕ запускаем.
  // По требованию, "На складе/ожидается → резерв" должен появляться без технических строк "пересборка".

  const mv = await query('SELECT COUNT(*)::int AS c FROM stock_movements');
  console.log(`[Admin] Done. Restored incoming from purchases 4&5, ensured reserves for ${ensured} linked orders. stock_movements=${mv.rows?.[0]?.c ?? 0}`);
}

main()
  .catch((e) => {
    console.error('[Admin] Failed:', e?.message || e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });

