import { query, closePool } from '../../src/config/database.js';

const prodCols = await query(
  `SELECT column_name FROM information_schema.columns
    WHERE table_name='products' AND (
      column_name ILIKE '%profit%' OR column_name ILIKE '%buyout%'
      OR column_name ILIKE '%min%' OR column_name ILIKE '%cost%'
      OR column_name ILIKE '%expense%'
    ) ORDER BY 1`
);

const prices = await query(
  `SELECT p.id, p.sku, p.cost, p.additional_expenses,
          p.min_profit_ozon, p.min_profit_wb, p.min_profit_ym,
          p.buyout_rate_ozon, p.buyout_rate_wb, p.buyout_rate,
          pmp.min_price, pmp.min_price_fbs, pmp.min_price_fbo
     FROM products p
     LEFT JOIN product_marketplace_prices pmp ON pmp.product_id = p.id AND pmp.marketplace = 'ozon'
    WHERE p.sku IN ('AN1014M','CN1293','CN1328K','AN1170','AN1217')`
);

const tables = await query(
  `SELECT table_name FROM information_schema.tables
    WHERE table_schema='public'
      AND (table_name ILIKE '%calculat%' OR table_name ILIKE '%commission%'
           OR table_name ILIKE '%ozon%')
    ORDER BY 1`
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

const anSales = await query(
  `SELECT order_id, operation_date::date AS d, retail_amount, commission_amount, logistics_amount, payout_amount,
          round((commission_amount/NULLIF(retail_amount,0)*100)::numeric,2) AS comm_pct,
          left(raw_json::text, 500) AS raw
     FROM marketplace_fbs_report_lines
    WHERE profile_id=1 AND marketplace='ozon' AND product_id=51
      AND operation_type='OperationAgentDeliveredToCustomer'
      AND operation_date >= '2026-10-01'
    ORDER BY operation_date DESC LIMIT 5`
);

// Where is calculator data stored?
let calc = null;
const tnames = tables.rows.map((r) => r.table_name);
for (const t of tnames) {
  const cols = await query(
    `SELECT column_name FROM information_schema.columns WHERE table_name=$1 ORDER BY 1`,
    [t]
  );
  const names = cols.rows.map((c) => c.column_name);
  if (!names.includes('product_id') && !names.includes('sku')) continue;
  if (!(names.includes('calculator') || names.includes('commissions') || names.includes('payload') || names.includes('data'))) continue;
  const r = await query(`SELECT * FROM ${t} WHERE product_id = 51 LIMIT 1`).catch(() => null);
  if (r?.rows?.length) {
    calc = { table: t, cols: names, row: r.rows[0] };
    break;
  }
}

// Also try marketplace_product_data / ozon_items
const more = [];
for (const t of tnames.slice(0, 40)) {
  const c = await query(
    `SELECT column_name FROM information_schema.columns WHERE table_name=$1`,
    [t]
  );
  more.push({ t, cols: c.rows.map((x) => x.column_name).filter((n) => /commission|percent|logistic|calculator|fbs|fbo/i.test(n)) });
}

const orgs = await query(`SELECT * FROM organizations LIMIT 3`).catch((e) => ({ err: String(e.message || e) }));

console.log(
  JSON.stringify(
    {
      prodCols: prodCols.rows,
      prices: prices.rows,
      tables: tnames,
      reality: reality.rows[0],
      anSales: anSales.rows.map((r) => ({ ...r, raw: r.raw })),
      calc,
      interestingCols: more.filter((m) => m.cols.length),
      orgs,
    },
    null,
    2
  )
);
await closePool();
