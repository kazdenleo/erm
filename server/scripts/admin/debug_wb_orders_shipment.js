/**
 * Диагностика заказов WB и списания при закрытии поставки.
 * Usage: node scripts/admin/debug_wb_orders_shipment.js 5143153826 5146823721
 */
import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { query, closePool } from '../../src/config/database.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHIPMENTS_PATH = path.join(__dirname, '../../data/shipments.json');

async function main() {
  const orderIds = process.argv.slice(2).filter(Boolean);
  if (orderIds.length === 0) {
    console.error('Укажите order_id WB');
    process.exitCode = 1;
    return;
  }

  for (const oid of orderIds) {
    const o = await query(
      `SELECT id, order_id, marketplace, status, profile_id, product_id, quantity,
              order_group_id, assembled_at, updated_at
       FROM orders
       WHERE order_id::text = $1`,
      [oid]
    );
    console.log('\n=== ORDER', oid, '===');
    console.log(JSON.stringify(o.rows, null, 2));

    for (const row of o.rows) {
      const dbId = row.id;
      const sm = await query(
        `SELECT id, type, quantity_change, balance_after, reserved_after, reason, created_at, meta
         FROM stock_movements
         WHERE (meta->>'order_id')::bigint = $1
            OR reason LIKE $2
         ORDER BY created_at DESC
         LIMIT 30`,
        [dbId, `%${oid}%`]
      );
      console.log('stock_movements for orders.id=', dbId, ':', sm.rows.length);
      for (const m of sm.rows) {
        console.log(
          ' ',
          m.created_at,
          m.type,
          m.quantity_change,
          m.reason?.slice(0, 100),
          JSON.stringify(m.meta)
        );
      }
    }
  }

  let shipments = [];
  try {
    const raw = await readFile(SHIPMENTS_PATH, 'utf8');
    shipments = JSON.parse(raw)?.shipments || JSON.parse(raw) || [];
  } catch (e) {
    console.warn('shipments.json:', e.message);
  }

  const hits = shipments.filter((s) =>
    (s.orderIds || []).some((id) => orderIds.includes(String(id)))
  );
  console.log('\n=== SHIPMENTS containing orders ===');
  for (const s of hits) {
    console.log(
      JSON.stringify(
        {
          id: s.id,
          name: s.name,
          closed: s.closed,
          closedAt: s.closedAt,
          marketplace: s.marketplace,
          orderIds: s.orderIds,
          wbLastSyncError: s.wbLastSyncError
        },
        null,
        2
      )
    );
  }

  const recentClosed = shipments
    .filter((s) => s.closed)
    .sort((a, b) => String(b.closedAt || '').localeCompare(String(a.closedAt || '')))
    .slice(0, 8);
  console.log('\n=== RECENT CLOSED SHIPMENTS ===');
  for (const s of recentClosed) {
    console.log(s.id, s.name, s.closedAt, 'orders:', (s.orderIds || []).length);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closePool());
