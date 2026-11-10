import { query, closePool } from '../../src/config/database.js';

const orderIds = process.argv.slice(2);
const ids =
  orderIds.length > 0
    ? orderIds
    : ['6006711609', '5880665576', '6075230315'];

const lines = await query(
  `SELECT order_id, posting_number, operation_date, operation_type, quantity,
          retail_amount, commission_amount, logistics_amount, payout_amount,
          acquiring_amount, other_deductions, sku, product_name, barcode,
          COALESCE(raw_json->>'supplier_oper_name', raw_json->>'supplierOperName', operation_type) AS oper_name,
          raw_json->>'delivery_rub' AS delivery_rub,
          raw_json->>'ppvz_for_pay' AS ppvz_for_pay,
          raw_json->>'retail_price' AS retail_price,
          raw_json->>'srid' AS srid
     FROM marketplace_fbs_report_lines
    WHERE profile_id = 1
      AND marketplace IN ('wb','wildberries')
      AND order_id = ANY($1::text[])
    ORDER BY order_id, operation_date, id`,
  [ids]
);

// Any sale ever for these order_ids (outside period too)
const salesEver = await query(
  `SELECT order_id, operation_date, operation_type, retail_amount, logistics_amount, payout_amount, sku
     FROM marketplace_fbs_report_lines
    WHERE profile_id = 1
      AND marketplace IN ('wb','wildberries')
      AND order_id = ANY($1::text[])
      AND operation_type = 'Продажа'
    ORDER BY order_id, operation_date`,
  [ids]
);

const byOrder = {};
for (const r of lines.rows) {
  const k = r.order_id;
  if (!byOrder[k]) byOrder[k] = [];
  byOrder[k].push(r);
}

console.log(
  JSON.stringify(
    {
      orders: byOrder,
      salesEver: salesEver.rows,
    },
    null,
    2
  )
);
await closePool();
