import { query, closePool } from '../../src/config/database.js';

const sku = process.argv[2] || 'KN1030K';
const from = process.argv[3] || '2026-10-20';
const to = process.argv[4] || '2026-10-28';

const product = await query(
  `SELECT id, sku, cost, additional_expenses,
          (SELECT min_price FROM product_marketplace_prices WHERE product_id = p.id AND marketplace = 'wb') AS wb_min,
          (SELECT calculator->>'logistics_cost_fbo' FROM product_mp_calculator_cache WHERE product_id = p.id AND marketplace = 'wb') AS log_cost,
          (SELECT calculator->>'logistics_base_fbo' FROM product_mp_calculator_cache WHERE product_id = p.id AND marketplace = 'wb') AS log_base,
          (SELECT calculator->>'volume_weight' FROM product_mp_calculator_cache WHERE product_id = p.id AND marketplace = 'wb') AS vol,
          (SELECT calculator->>'logistics_localization_index' FROM product_mp_calculator_cache WHERE product_id = p.id AND marketplace = 'wb') AS il
     FROM products p WHERE sku = $1 LIMIT 1`,
  [sku]
);

const lines = await query(
  `SELECT id, order_id, posting_number, barcode, operation_date, operation_type,
          retail_amount, commission_amount, logistics_amount, payout_amount,
          sku, product_id, quantity,
          NULLIF(TRIM(COALESCE(raw_json->>'shk_id','')), '') AS shk_id,
          COALESCE(raw_json->>'supplier_oper_name', raw_json->>'supplierOperName', operation_type) AS oper_name,
          raw_json->>'retail_price' AS retail_price,
          raw_json->>'delivery_rub' AS delivery_rub,
          raw_json->>'ppvz_for_pay' AS ppvz_for_pay
     FROM marketplace_fbs_report_lines
    WHERE profile_id = 1
      AND marketplace IN ('wb','wildberries')
      AND operation_date >= $2::date AND operation_date <= $3::date
      AND (
        UPPER(TRIM(COALESCE(sku,''))) = UPPER($1)
        OR product_id = $4
      )
    ORDER BY operation_date DESC, id DESC
    LIMIT 60`,
  [sku, from, to, product.rows[0]?.id || 0]
);

const barcodes = [...new Set(lines.rows.map((r) => r.barcode).filter(Boolean))];
let glued = [];
if (barcodes.length) {
  const g = await query(
    `SELECT order_id, posting_number, barcode, operation_date, operation_type,
            logistics_amount, retail_amount, payout_amount, sku,
            COALESCE(raw_json->>'supplier_oper_name', raw_json->>'supplierOperName', operation_type) AS oper_name,
            raw_json->>'delivery_rub' AS delivery_rub
       FROM marketplace_fbs_report_lines
      WHERE profile_id = 1
        AND marketplace IN ('wb','wildberries')
        AND barcode = ANY($1::text[])
        AND operation_date >= $2::date AND operation_date <= $3::date
        AND ABS(COALESCE(logistics_amount, 0)) > 0
      ORDER BY barcode, operation_date, id`,
    [barcodes, from, to]
  );
  glued = g.rows;
}

const sumLog = glued.reduce((s, r) => s + Math.abs(Number(r.logistics_amount) || 0), 0);

console.log(
  JSON.stringify(
    {
      product: product.rows[0] || null,
      lineCount: lines.rows.length,
      lines: lines.rows,
      deliveryLinesSameBarcode: glued,
      sumLogisticsSameBarcode: Math.round(sumLog * 100) / 100,
    },
    null,
    2
  )
);
await closePool();
