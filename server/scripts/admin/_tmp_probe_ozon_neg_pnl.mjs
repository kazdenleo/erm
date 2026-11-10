import { query, closePool } from '../../src/config/database.js';
import marketplaceFbsReportsService from '../../src/services/marketplaceFbsReports.service.js';

const orderIds = [
  '06541516-0959-1',
  '0182764347-0174-1',
  '0113554668-0325-1',
  '0240415729-0060-1',
];

const lines = await query(
  `SELECT order_id, posting_number, operation_date, operation_type, quantity,
          retail_amount, commission_amount, logistics_amount, payout_amount,
          acquiring_amount, other_deductions, sku, product_id,
          raw_json->>'accruals_for_sale' AS accruals_for_sale,
          raw_json->>'sale_commission' AS sale_commission,
          raw_json->>'amount' AS amount,
          raw_json->'posting'->>'delivery_schema' AS schema,
          left(raw_json::text, 350) AS raw_head
     FROM marketplace_fbs_report_lines
    WHERE profile_id = 1 AND marketplace = 'ozon'
      AND (
        order_id = ANY($1::text[])
        OR posting_number = ANY($1::text[])
      )
    ORDER BY order_id, operation_date, id`,
  [orderIds]
);

const byOrder = await marketplaceFbsReportsService.getFbsByOrder({
  profileId: 1,
  dateFrom: '2026-10-01',
  dateTo: '2026-10-28',
  marketplace: 'ozon',
  limit: 500,
});
const want = new Set(orderIds);
const rows = (byOrder.items || []).filter(
  (r) => want.has(String(r.orderId || '')) || want.has(String(r.postingNumber || ''))
);

// Sample product min profits
const products = await query(
  `SELECT id, sku, cost, additional_expenses, min_profit_ozon, min_price,
          (SELECT min_price FROM product_marketplace_prices p WHERE p.product_id = products.id AND marketplace='ozon') AS ozon_min,
          (SELECT min_price_fbs FROM product_marketplace_prices p WHERE p.product_id = products.id AND marketplace='ozon') AS ozon_min_fbs
     FROM products
    WHERE id IN (
      SELECT DISTINCT product_id FROM marketplace_fbs_report_lines
       WHERE profile_id=1 AND marketplace='ozon' AND product_id IS NOT NULL
         AND (order_id = ANY($1::text[]) OR posting_number = ANY($1::text[]))
    )`,
  [orderIds]
);

// Aggregate: how many zero-retail orders vs sales in period
const agg = await query(
  `SELECT
     count(*) FILTER (WHERE quantity > 0 AND retail_amount > 0)::int AS sale_rows,
     count(*) FILTER (WHERE ABS(COALESCE(retail_amount,0))=0 AND ABS(COALESCE(payout_amount,0))>0)::int AS fee_or_storno_rows,
     round(sum(CASE WHEN operation_type='OperationAgentDeliveredToCustomer' THEN retail_amount ELSE 0 END)::numeric,2) AS sale_retail,
     round(sum(CASE WHEN operation_type='OperationAgentDeliveredToCustomer' THEN commission_amount ELSE 0 END)::numeric,2) AS sale_commission,
     round(avg(CASE WHEN operation_type='OperationAgentDeliveredToCustomer' AND retail_amount>0
               THEN commission_amount/retail_amount*100 END)::numeric,2) AS avg_comm_pct
   FROM marketplace_fbs_report_lines
   WHERE profile_id=1 AND marketplace='ozon'
     AND operation_date >= '2026-10-01' AND operation_date <= '2026-10-28'`
);

console.log(
  JSON.stringify(
    {
      products: products.rows,
      agg: agg.rows[0],
      analyticsRows: rows.map((r) => ({
        orderId: r.orderId,
        qty: r.quantity,
        retail: r.retailAmount,
        commission: r.commissionAmount,
        logistics: r.logisticsAmount,
        other: r.otherDeductions,
        acquiring: r.acquiringAmount,
        payout: r.payoutAmount,
        cost: r.costAmount,
        add: r.additionalExpensesAmount,
        revenue: r.revenueAmount,
        tax: r.taxAmount,
        net: r.netIncome,
        sku: r.sku || r.erpSku,
        name: r.productName,
      })),
      rawLines: lines.rows,
    },
    null,
    2
  )
);
await closePool();
