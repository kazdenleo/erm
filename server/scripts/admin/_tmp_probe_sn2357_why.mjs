import 'dotenv/config';
import { query } from '../../src/config/database.js';

const cols = await query(
  `SELECT column_name FROM information_schema.columns
   WHERE table_name = 'stock_movements' ORDER BY 1`
);
console.log('sm_cols', cols.rows.map((r) => r.column_name));

const sample = await query(
  `SELECT * FROM stock_movements WHERE product_id = 567 ORDER BY id DESC LIMIT 1`
);
console.log('sample_keys', sample.rows[0] ? Object.keys(sample.rows[0]) : null);

const moves = await query(
  `SELECT id, type, warehouse_id, created_at, meta
   FROM stock_movements
   WHERE product_id = 567
     AND created_at >= NOW() - INTERVAL '21 days'
   ORDER BY created_at DESC
   LIMIT 60`
);
for (const r of moves.rows) {
  console.log(
    JSON.stringify({
      id: r.id,
      type: r.type,
      wh: r.warehouse_id,
      at: r.created_at,
      meta: r.meta,
      qty: r.quantity ?? r.delta ?? r.change_qty ?? r.amount,
    })
  );
}

const receipts = await query(
  `SELECT wr.id, wr.purchase_id, wr.status, wr.warehouse_id, wr.created_at, wr.completed_at, wr.updated_at
   FROM warehouse_receipts wr
   WHERE wr.purchase_id = 514
   ORDER BY wr.id`
).catch(async (e) => {
  console.log('wr_err', e.message);
  const t = await query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_name ILIKE '%receipt%' ORDER BY 1`
  );
  console.log('receipt_tables', t.rows);
  return { rows: [] };
});
console.log('receipts_514', receipts.rows);

const purch = await query(`SELECT * FROM purchases WHERE id = 514`);
console.log(
  'purchase_514',
  purch.rows[0]
    ? {
        id: purch.rows[0].id,
        status: purch.rows[0].status,
        warehouse_id: purch.rows[0].warehouse_id,
        updated_at: purch.rows[0].updated_at,
        created_at: purch.rows[0].created_at,
      }
    : null
);

process.exit(0);
