import { writeFileSync } from 'fs';
import { query, closePool } from '../../src/config/database.js';

const out = [];
const log = (...a) => out.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));

try {
  const prod = await query(
    `SELECT id, sku, name, quantity, incoming_quantity, COALESCE(cost,0)::float AS cost
     FROM products WHERE UPPER(TRIM(sku)) = 'TG-5457' OR sku ILIKE 'TG-5457'`
  );
  log('product', prod.rows);
  const pid = Number(prod.rows?.[0]?.id);
  if (!pid) throw new Error('product not found');

  const items = await query(
    `SELECT pi.purchase_id, p.status AS purchase_status, p.warehouse_id, p.created_at, p.updated_at,
            pi.expected_quantity, pi.received_quantity,
            GREATEST(0, COALESCE(pi.expected_quantity,0)-COALESCE(pi.received_quantity,0))::int AS pending
     FROM purchase_items pi
     JOIN purchases p ON p.id = pi.purchase_id
     WHERE pi.product_id = $1
     ORDER BY pi.purchase_id DESC
     LIMIT 15`,
    [pid]
  );
  log('purchase_items', items.rows);

  const receipts = await query(
    `SELECT r.id, r.purchase_id, r.status, r.completed_at, r.created_at, r.updated_at,
            r.extras_resolved, r.created_by_user_id,
            ri.scanned_quantity, ri.scan_meta, ri.updated_at AS item_updated
     FROM purchase_receipt_items ri
     JOIN purchase_receipts r ON r.id = ri.receipt_id
     WHERE ri.product_id = $1
     ORDER BY r.id DESC
     LIMIT 20`,
    [pid]
  );
  log('receipt_items', receipts.rows);

  const moves = await query(
    `SELECT id, type, quantity_change, warehouse_id, reason, meta, created_at
     FROM stock_movements
     WHERE product_id = $1
       AND (
         type IN ('receipt','incoming','adjustment')
         OR meta->>'purchase_receipt_id' IS NOT NULL
         OR reason ILIKE '%приёмк%'
         OR reason ILIKE '%приемк%'
       )
     ORDER BY id DESC
     LIMIT 30`,
    [pid]
  );
  log('movements', moves.rows);

  const stock = await query(
    `SELECT warehouse_id, quantity FROM product_warehouse_stock WHERE product_id = $1 ORDER BY warehouse_id`,
    [pid]
  );
  log('warehouse_stock', stock.rows);

  // Last completed receipt with TG-5457 — all items summary + stock moves for that receipt
  const lastRid = Number(receipts.rows?.[0]?.id);
  if (lastRid) {
    const rMoves = await query(
      `SELECT id, product_id, type, quantity_change, reason, meta, created_at
       FROM stock_movements
       WHERE meta->>'purchase_receipt_id' = $1
       ORDER BY id`,
      [String(lastRid)]
    );
    log('moves for last receipt', lastRid, rMoves.rows.filter((m) => Number(m.product_id) === pid || String(m.meta?.sku || '').toUpperCase() === 'TG-5457'));
    log('all TG moves in receipt', rMoves.rows.filter((m) => Number(m.product_id) === pid));

    const ri = await query(
      `SELECT ri.product_id, pr.sku, ri.scanned_quantity,
              pi.expected_quantity, pi.received_quantity
       FROM purchase_receipt_items ri
       JOIN products pr ON pr.id = ri.product_id
       LEFT JOIN purchase_receipts r ON r.id = ri.receipt_id
       LEFT JOIN purchase_items pi ON pi.purchase_id = r.purchase_id AND pi.product_id = ri.product_id
       WHERE ri.receipt_id = $1 AND ri.product_id = $2`,
      [lastRid, pid]
    );
    log('last receipt line detail', ri.rows);
  }
} catch (e) {
  log('ERROR', e?.stack || e.message);
} finally {
  writeFileSync('scripts/admin/_tmp_probe_tg5457.out.json', out.join('\n'), 'utf8');
  console.log(out.join('\n'));
  await closePool();
}
