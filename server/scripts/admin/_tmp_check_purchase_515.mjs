/**
 * Сверка закупки: purchase_items vs приёмки.
 * Usage: node scripts/admin/_tmp_check_purchase_515.mjs [purchaseId]
 */
import { query, closePool } from '../../src/config/database.js';

const pid = Number(process.argv[2] || 515);

try {
  const head = await query(
    `SELECT id, status, supplier_id, warehouse_id FROM purchases WHERE id = $1`,
    [pid]
  );
  console.log('purchase', head.rows[0] || null);

  const agg = await query(
    `SELECT COUNT(*)::int AS n,
            COALESCE(SUM(expected_quantity), 0)::int AS exp,
            COALESCE(SUM(COALESCE(received_quantity, 0)), 0)::int AS rec
     FROM purchase_items WHERE purchase_id = $1`,
    [pid]
  );
  console.log('items_agg', agg.rows[0]);

  const lines = await query(
    `SELECT pi.product_id, pr.sku, pi.expected_quantity, pi.received_quantity
     FROM purchase_items pi
     JOIN products pr ON pr.id = pi.product_id
     WHERE pi.purchase_id = $1
     ORDER BY pi.id`,
    [pid]
  );
  console.log('lines', JSON.stringify(lines.rows, null, 2));

  const receipts = await query(
    `SELECT r.id, r.status, r.started_at, r.completed_at,
            (SELECT COUNT(*)::int FROM purchase_receipt_items ri WHERE ri.receipt_id = r.id) AS items,
            (SELECT COALESCE(SUM(ri.scanned_quantity), 0)::int
             FROM purchase_receipt_items ri WHERE ri.receipt_id = r.id) AS scanned
     FROM purchase_receipts r
     WHERE r.purchase_id = $1
     ORDER BY r.id`,
    [pid]
  );
  console.log('receipts', JSON.stringify(receipts.rows, null, 2));

  const scannedAgg = await query(
    `SELECT COALESCE(SUM(ri.scanned_quantity), 0)::int AS scanned_completed
     FROM purchase_receipt_items ri
     JOIN purchase_receipts r ON r.id = ri.receipt_id
     WHERE r.purchase_id = $1 AND r.status = 'completed'`,
    [pid]
  );
  console.log('scanned_completed_total', scannedAgg.rows[0]);

  const scannedAll = await query(
    `SELECT COALESCE(SUM(ri.scanned_quantity), 0)::int AS scanned_all_statuses
     FROM purchase_receipt_items ri
     JOIN purchase_receipts r ON r.id = ri.receipt_id
     WHERE r.purchase_id = $1 AND r.status IN ('completed', 'scanning')`,
    [pid]
  );
  console.log('scanned_completed_or_scanning', scannedAll.rows[0]);

  const byProd = await query(
    `SELECT r.id AS receipt_id, r.status, pr.sku, ri.scanned_quantity,
            pi.expected_quantity, pi.received_quantity,
            CASE WHEN pi.id IS NULL THEN true ELSE false END AS extra_sku
     FROM purchase_receipt_items ri
     JOIN purchase_receipts r ON r.id = ri.receipt_id
     JOIN products pr ON pr.id = ri.product_id
     LEFT JOIN purchase_items pi
       ON pi.purchase_id = r.purchase_id AND pi.product_id = ri.product_id
     WHERE r.purchase_id = $1
     ORDER BY r.id, pr.sku`,
    [pid]
  );
  console.log('receipt_vs_items', JSON.stringify(byProd.rows, null, 2));

  const mismatch = await query(
    `SELECT pr.sku,
            pi.expected_quantity,
            pi.received_quantity,
            COALESCE(s.scanned, 0)::int AS scanned_completed
     FROM purchase_items pi
     JOIN products pr ON pr.id = pi.product_id
     LEFT JOIN (
       SELECT ri.product_id, SUM(ri.scanned_quantity)::int AS scanned
       FROM purchase_receipt_items ri
       JOIN purchase_receipts r ON r.id = ri.receipt_id
       WHERE r.purchase_id = $1 AND r.status = 'completed'
       GROUP BY ri.product_id
     ) s ON s.product_id = pi.product_id
     WHERE pi.purchase_id = $1
       AND COALESCE(s.scanned, 0) <> COALESCE(pi.received_quantity, 0)
     ORDER BY pr.sku`,
    [pid]
  );
  console.log('received_vs_scanned_mismatch', JSON.stringify(mismatch.rows, null, 2));
} finally {
  await closePool();
}
