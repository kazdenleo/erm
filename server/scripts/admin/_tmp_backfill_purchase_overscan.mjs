/**
 * Подтянуть purchase_items.received_quantity до факта скана из завершённых приёмок
 * (перескан сверх плана раньше не писался в received).
 */
import { query, closePool } from '../../src/config/database.js';

const dry = process.argv.includes('--dry');

try {
  const before = await query(
    `SELECT COUNT(*)::int AS n
     FROM purchase_items pi
     JOIN (
       SELECT r.purchase_id, ri.product_id, SUM(ri.scanned_quantity)::int AS scanned
       FROM purchase_receipt_items ri
       JOIN purchase_receipts r ON r.id = ri.receipt_id
       WHERE r.status = 'completed'
       GROUP BY r.purchase_id, ri.product_id
     ) s ON s.purchase_id = pi.purchase_id AND s.product_id = pi.product_id
     WHERE s.scanned > COALESCE(pi.received_quantity, 0)`
  );
  console.log('rows to update', before.rows[0]?.n, dry ? '(dry-run)' : '');

  const sample = await query(
    `SELECT pi.purchase_id, pr.sku, pi.expected_quantity, pi.received_quantity, s.scanned
     FROM purchase_items pi
     JOIN products pr ON pr.id = pi.product_id
     JOIN (
       SELECT r.purchase_id, ri.product_id, SUM(ri.scanned_quantity)::int AS scanned
       FROM purchase_receipt_items ri
       JOIN purchase_receipts r ON r.id = ri.receipt_id
       WHERE r.status = 'completed'
       GROUP BY r.purchase_id, ri.product_id
     ) s ON s.purchase_id = pi.purchase_id AND s.product_id = pi.product_id
     WHERE s.scanned > COALESCE(pi.received_quantity, 0)
     ORDER BY pi.purchase_id DESC
     LIMIT 20`
  );
  console.log('sample', JSON.stringify(sample.rows, null, 2));

  if (!dry) {
    const upd = await query(
      `UPDATE purchase_items pi
       SET received_quantity = s.scanned,
           updated_at = CURRENT_TIMESTAMP
       FROM (
         SELECT r.purchase_id, ri.product_id, SUM(ri.scanned_quantity)::int AS scanned
         FROM purchase_receipt_items ri
         JOIN purchase_receipts r ON r.id = ri.receipt_id
         WHERE r.status = 'completed'
         GROUP BY r.purchase_id, ri.product_id
       ) s
       WHERE pi.purchase_id = s.purchase_id
         AND pi.product_id = s.product_id
         AND s.scanned > COALESCE(pi.received_quantity, 0)
       RETURNING pi.purchase_id, pi.product_id, pi.received_quantity`
    );
    console.log('updated', upd.rowCount);
  }
} finally {
  await closePool();
}
