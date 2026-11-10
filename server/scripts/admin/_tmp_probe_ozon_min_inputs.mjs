import { query, closePool } from '../../src/config/database.js';

const settings = await query(
  `SELECT key, value FROM settings
    WHERE key ILIKE '%ozon%' OR key ILIKE '%min_profit%' OR key ILIKE '%profit%'
       OR key ILIKE '%commission%' OR key ILIKE '%spp%'
    ORDER BY key`
);

const cols = await query(
  `SELECT column_name FROM information_schema.columns
    WHERE table_name = 'product_marketplace_prices' ORDER BY ordinal_position`
);

const prices = await query(
  `SELECT p.sku, p.cost, p.additional_expenses, p.min_profit, p.min_profit_ozon,
          pmp.*
     FROM products p
     JOIN product_marketplace_prices pmp ON pmp.product_id = p.id AND pmp.marketplace = 'ozon'
    WHERE p.sku IN ('AN1014M','CN1293','CN1328K','AN1170')`
);

// What commission % does calculator use for these products?
const cache = await query(
  `SELECT product_id, marketplace, scheme, commission_percent, logistics_amount, acquiring_percent, payload
     FROM marketplace_commission_cache
    WHERE marketplace = 'ozon'
      AND product_id IN (SELECT id FROM products WHERE sku IN ('AN1014M','CN1293','CN1328K'))
    LIMIT 20`
).catch((e) => ({ rows: [], err: String(e.message || e) }));

const tableExists = await query(
  `SELECT table_name FROM information_schema.tables
    WHERE table_name ILIKE '%commission%' OR table_name ILIKE '%ozon%tarif%'
    ORDER BY 1`
);

// Reality check: delivered sales only economics at min price band
const reality = await query(
  `SELECT
     round(avg(commission_amount / NULLIF(retail_amount,0) * 100)::numeric, 2) AS avg_comm_pct,
     round(avg(logistics_amount)::numeric, 2) AS avg_logistics,
     round(percentile_cont(0.5) WITHIN GROUP (ORDER BY commission_amount / NULLIF(retail_amount,0) * 100)::numeric, 2) AS med_comm_pct,
     round(percentile_cont(0.5) WITHIN GROUP (ORDER BY logistics_amount)::numeric, 2) AS med_logistics,
     count(*)::int AS n
   FROM marketplace_fbs_report_lines
   WHERE profile_id = 1 AND marketplace = 'ozon'
     AND operation_type = 'OperationAgentDeliveredToCustomer'
     AND retail_amount > 0
     AND operation_date >= '2026-10-01'`
);

const returns = await query(
  `SELECT operation_type, count(*)::int AS n,
          round(sum(retail_amount)::numeric,2) AS retail,
          round(sum(commission_amount)::numeric,2) AS commission,
          round(sum(logistics_amount)::numeric,2) AS logistics,
          round(sum(payout_amount)::numeric,2) AS payout
     FROM marketplace_fbs_report_lines
    WHERE profile_id = 1 AND marketplace = 'ozon'
      AND operation_date >= '2026-10-01'
      AND (
        operation_type ILIKE '%storno%'
        OR operation_type ILIKE '%return%'
        OR operation_type IN ('POSTING','PackageCost','PackingFee','Acquiring','BrandCommission')
      )
    GROUP BY 1 ORDER BY n DESC`
);

console.log(
  JSON.stringify(
    {
      settings: settings.rows,
      pmp_columns: cols.rows.map((r) => r.column_name),
      prices: prices.rows,
      cache,
      tables: tableExists.rows,
      reality: reality.rows[0],
      returns: returns.rows,
    },
    null,
    2
  )
);
await closePool();
