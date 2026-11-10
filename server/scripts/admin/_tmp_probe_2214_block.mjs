/**
 * Why receipt 466 can't complete; CIS / extras
 */
import { query, closePool } from '../../src/config/database.js';

async function main() {
  const rid = 466;
  const r = await query(`SELECT * FROM purchase_receipts WHERE id=$1`, [rid]);
  console.log('receipt', {
    id: r.rows[0]?.id,
    status: r.rows[0]?.status,
    purchase_id: r.rows[0]?.purchase_id,
    created_by_user_id: r.rows[0]?.created_by_user_id,
    extras_resolved: r.rows[0]?.extras_resolved,
  });

  const items = await query(
    `SELECT pri.product_id, p.sku, pri.scanned_quantity, pri.expected_quantity,
            pi.expected_quantity AS pe, pi.received_quantity AS pr,
            GREATEST(0, COALESCE(pi.expected_quantity,0)-COALESCE(pi.received_quantity,0)) AS remain
     FROM purchase_receipt_items pri
     JOIN products p ON p.id=pri.product_id
     LEFT JOIN purchase_items pi ON pi.purchase_id=466 OR (pi.purchase_id=(SELECT purchase_id FROM purchase_receipts WHERE id=466) AND pi.product_id=pri.product_id)
     WHERE pri.receipt_id=$1 AND pri.scanned_quantity>0
     ORDER BY pri.scanned_quantity DESC`,
    [rid]
  );
  // fix join - redo cleanly
  const items2 = await query(
    `SELECT pri.product_id, p.sku, pri.scanned_quantity,
            pi.expected_quantity AS purchase_expected,
            pi.received_quantity AS purchase_received,
            GREATEST(0, COALESCE(pi.expected_quantity,0)-COALESCE(pi.received_quantity,0)) AS remain_needed,
            GREATEST(0, pri.scanned_quantity - GREATEST(0, COALESCE(pi.expected_quantity,0)-COALESCE(pi.received_quantity,0))) AS overscan
     FROM purchase_receipt_items pri
     JOIN products p ON p.id=pri.product_id
     JOIN purchase_receipts r ON r.id=pri.receipt_id
     LEFT JOIN purchase_items pi ON pi.purchase_id=r.purchase_id AND pi.product_id=pri.product_id
     WHERE pri.receipt_id=$1 AND COALESCE(pri.scanned_quantity,0)>0
     ORDER BY overscan DESC, pri.scanned_quantity DESC`,
    [rid]
  );
  console.log('scanned lines', items2.rows);

  const over = items2.rows.filter((x) => x.overscan > 0);
  console.log(
    'overscan total',
    over.reduce((s, x) => s + Number(x.overscan), 0),
    'positions',
    over.length
  );

  // CIS tables?
  const cis = await query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema='public' AND table_name ILIKE '%cis%' OR table_name ILIKE '%честн%'`
  );
  console.log(
    'cis tables',
    (
      await query(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema='public' AND (table_name ILIKE '%cis%' OR table_name ILIKE '%chestny%')`
      )
    ).rows
  );

  // purchase open lines summary
  const open = await query(
    `SELECT p.sku, pi.expected_quantity, pi.received_quantity,
            GREATEST(0, pi.expected_quantity-COALESCE(pi.received_quantity,0)) AS need
     FROM purchase_items pi JOIN products p ON p.id=pi.product_id
     WHERE pi.purchase_id=514
       AND pi.expected_quantity > COALESCE(pi.received_quantity,0)
     ORDER BY need DESC`
  );
  console.log('still needed in purchase 514', open.rows);
}

main().catch(console.error).finally(() => closePool());
