import { query, closePool } from '../../src/config/database.js';

const r = await query(`
WITH sales AS (
  SELECT l.product_id, p.sku,
         COALESCE(p.volume, (c.calculator->>'volume_weight')::numeric) AS vol,
         (c.calculator->>'logistics_cost')::numeric AS model_log,
         (c.calculator->'commissions'->'FBS'->>'delivery_amount')::numeric AS model_deliv,
         (c.calculator->'commissions'->'FBS'->>'direct_flow_trans_amount_max')::numeric AS model_max,
         l.logistics_amount AS fact_log
    FROM marketplace_fbs_report_lines l
    JOIN products p ON p.id = l.product_id
    LEFT JOIN product_mp_calculator_cache c ON c.product_id = l.product_id AND c.marketplace='ozon'
   WHERE l.profile_id=1 AND l.marketplace='ozon'
     AND l.operation_type='OperationAgentDeliveredToCustomer'
     AND l.retail_amount > 0
     AND l.operation_date >= '2026-10-01'
)
SELECT sku,
       round(avg(vol)::numeric,2) AS vol,
       round(avg(model_log)::numeric,2) AS model_df,
       round(avg(COALESCE(model_deliv,0))::numeric,2) AS model_deliv,
       round(avg(model_log + COALESCE(model_deliv,0))::numeric,2) AS model_total,
       round(avg(model_max)::numeric,2) AS model_max,
       round(avg(fact_log)::numeric,2) AS fact_avg,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY fact_log)::numeric,2) AS fact_med,
       round(percentile_cont(0.75) WITHIN GROUP (ORDER BY fact_log)::numeric,2) AS fact_p75,
       count(*)::int AS n
  FROM sales
 WHERE model_log IS NOT NULL
 GROUP BY sku
 HAVING count(*) >= 2
 ORDER BY n DESC
 LIMIT 25
`);

const overall = await query(`
SELECT
  round(avg(l.logistics_amount - (
    COALESCE((c.calculator->>'logistics_cost')::numeric,0)
    + COALESCE((c.calculator->'commissions'->'FBS'->>'delivery_amount')::numeric,0)
  ))::numeric,2) AS avg_gap,
  round(percentile_cont(0.5) WITHIN GROUP (ORDER BY l.logistics_amount - (
    COALESCE((c.calculator->>'logistics_cost')::numeric,0)
    + COALESCE((c.calculator->'commissions'->'FBS'->>'delivery_amount')::numeric,0)
  ))::numeric,2) AS med_gap
FROM marketplace_fbs_report_lines l
JOIN product_mp_calculator_cache c ON c.product_id = l.product_id AND c.marketplace='ozon'
WHERE l.profile_id=1 AND l.marketplace='ozon'
  AND l.operation_type='OperationAgentDeliveredToCustomer'
  AND l.retail_amount > 0
  AND l.operation_date >= '2026-10-01'
`);

console.log(JSON.stringify({ bySku: r.rows, overall: overall.rows[0] }, null, 2));
await closePool();
