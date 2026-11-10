import { query, closePool } from '../../src/config/database.js';

const tables = await query(
  `SELECT table_name FROM information_schema.tables
    WHERE table_schema='public'
      AND (table_name ILIKE '%setting%' OR table_name ILIKE '%commission%'
           OR table_name ILIKE '%calculator%' OR table_name ILIKE '%tarif%'
           OR table_name ILIKE '%organization%')
    ORDER BY 1`
);

const prices = await query(
  `SELECT p.id, p.sku, p.cost, p.additional_expenses, p.min_profit, p.min_profit_ozon,
          p.buyout_rate, p.buyout_rate_ozon,
          pmp.min_price, pmp.min_price_fbs, pmp.min_price_fbo,
          pmp.price, pmp.price_before_discount
     FROM products p
     LEFT JOIN product_marketplace_prices pmp ON pmp.product_id = p.id AND pmp.marketplace = 'ozon'
    WHERE p.sku IN ('AN1014M','CN1293','CN1328K','AN1170','AN1217')`
);

const pmpCols = await query(
  `SELECT column_name FROM information_schema.columns
    WHERE table_name='product_marketplace_prices' ORDER BY 1`
);

// Find calculator snapshot for AN1014M
const calcTables = tables.rows.map((r) => r.table_name);
let calcSample = null;
for (const t of ['product_marketplace_calculators', 'marketplace_calculators', 'ozon_product_commissions', 'product_commissions']) {
  if (!calcTables.includes(t)) continue;
  const r = await query(`SELECT * FROM ${t} WHERE product_id = 51 LIMIT 3`).catch(() => null);
  if (r) calcSample = { table: t, rows: r.rows };
}

// Maybe commissions live in products JSON or cache table
const anyCache = await query(
  `SELECT table_name FROM information_schema.tables
    WHERE table_schema='public' AND table_name ILIKE '%cache%'`
);

const reality = await query(
  `SELECT
     round(avg(commission_amount / NULLIF(retail_amount,0) * 100)::numeric, 2) AS avg_comm_pct,
     round(percentile_cont(0.5) WITHIN GROUP (ORDER BY commission_amount / NULLIF(retail_amount,0) * 100)::numeric, 2) AS med_comm_pct,
     round(avg(logistics_amount)::numeric, 2) AS avg_logistics,
     round(percentile_cont(0.5) WITHIN GROUP (ORDER BY logistics_amount)::numeric, 2) AS med_logistics,
     count(*)::int AS n
   FROM marketplace_fbs_report_lines
   WHERE profile_id = 1 AND marketplace = 'ozon'
     AND operation_type = 'OperationAgentDeliveredToCustomer'
     AND retail_amount > 0
     AND operation_date >= '2026-10-01'`
);

// Compare sale-only economics for AN1014M at min without storno
const anSales = await query(
  `SELECT order_id, retail_amount, commission_amount, logistics_amount, payout_amount,
          round((commission_amount/NULLIF(retail_amount,0)*100)::numeric,2) AS comm_pct
     FROM marketplace_fbs_report_lines
    WHERE profile_id=1 AND marketplace='ozon' AND product_id=51
      AND operation_type='OperationAgentDeliveredToCustomer'
      AND operation_date >= '2026-10-01'
    ORDER BY operation_date DESC LIMIT 15`
);

// org tax / default min profit
const orgs = await query(
  `SELECT id, name, tax_system, vat, min_profit_ozon, min_profit FROM organizations LIMIT 5`
).catch(async (e) => {
  const cols = await query(
    `SELECT column_name FROM information_schema.columns WHERE table_name='organizations' ORDER BY 1`
  );
  return { err: String(e.message || e), cols: cols.rows };
});

console.log(
  JSON.stringify(
    {
      tables: tables.rows,
      pmpCols: pmpCols.rows.map((r) => r.column_name),
      prices: prices.rows,
      calcSample,
      caches: anyCache.rows,
      reality: reality.rows[0],
      anSales: anSales.rows,
      orgs,
    },
    null,
    2
  )
);
await closePool();
