import { query } from '../../src/config/database.js';

const ORDER_IDS = ['5150213511', '5149079204'];

async function main() {
  const o = await query(
    `SELECT id, order_id, marketplace, product_id, status
     FROM orders WHERE order_id = ANY($1::text[])`,
    [ORDER_IDS]
  );
  console.log('orders:', o.rows);

  for (const r of o.rows) {
    const sm = await query(
      `SELECT sm.product_id, p.sku, sm.type, sm.quantity, sm.created_at
       FROM stock_movements sm
       JOIN products p ON p.id = sm.product_id
       WHERE sm.meta->>'order_id' = $1
         AND sm.type IN ('reserve', 'unreserve')
       ORDER BY sm.created_at`,
      [String(r.id)]
    );
    const nets = {};
    for (const m of sm.rows) {
      const k = `${m.product_id} (${m.sku})`;
      nets[k] = (nets[k] || 0) + (m.type === 'reserve' ? 1 : -1) * Number(m.quantity);
    }
    console.log(`\norder ${r.order_id} (db ${r.id}) net reserve:`, nets);

    const pids = [...new Set(sm.rows.map((x) => x.product_id))];
    if (pids.length) {
      const st = await query(
        `SELECT p.id, p.sku, p.quantity AS legacy_qty,
          COALESCE((SELECT SUM(quantity) FROM product_warehouse_stock pws WHERE pws.product_id = p.id), 0) AS pws_sum
         FROM products p WHERE p.id = ANY($1::int[])`,
        [pids]
      );
      console.log('stock:', st.rows);
    }
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
