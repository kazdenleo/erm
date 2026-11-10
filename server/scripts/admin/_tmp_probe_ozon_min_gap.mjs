import { query, closePool } from '../../src/config/database.js';
import { calculateMinPrice } from '../../src/services/min-price-calculator.service.js';
import { resolveOrganizationTaxProfile } from '../../src/utils/organizationTaxRates.js';

const productId = 51;
const [prod] = (
  await query(
    `SELECT p.*, o.tax_system AS organization_tax_system, o.vat AS organization_vat
       FROM products p
       LEFT JOIN organizations o ON o.id = p.organization_id
      WHERE p.id = $1`,
    [productId]
  )
).rows;

const [cache] = (
  await query(
    `SELECT calculator FROM product_mp_calculator_cache WHERE product_id=$1 AND marketplace='ozon'`,
    [productId]
  )
).rows;

const taxProfile = resolveOrganizationTaxProfile({
  tax_system: prod.organization_tax_system,
  vat: prod.organization_vat,
});

const minProfit = Number(prod.min_profit_ozon) || 50;
const price = calculateMinPrice(
  Number(prod.cost) || 0,
  cache.calculator,
  'ozon',
  minProfit,
  {
    ...prod,
    organization: {
      tax_system: prod.organization_tax_system,
      vat: prod.organization_vat,
    },
  },
  null,
  null,
  taxProfile,
  'FBS',
  null
);

// Successful (not fully returned) AN1014M orders in Oct
const econ = await query(
  `WITH lines AS (
     SELECT order_id,
            SUM(CASE WHEN operation_type='OperationAgentDeliveredToCustomer' THEN retail_amount ELSE 0 END) AS sale_retail,
            SUM(CASE WHEN operation_type='OperationAgentStornoDeliveredToCustomer'
                     THEN ABS(COALESCE((raw_json->>'accruals_for_sale')::numeric,0)) ELSE 0 END) AS returned,
            SUM(commission_amount) AS commission,
            SUM(logistics_amount) AS logistics,
            SUM(other_deductions) AS other,
            SUM(acquiring_amount) AS acquiring,
            SUM(payout_amount) AS payout
       FROM marketplace_fbs_report_lines
      WHERE profile_id=1 AND marketplace='ozon' AND product_id=51
        AND operation_date >= '2026-10-01'
      GROUP BY order_id
   )
   SELECT
     count(*) FILTER (WHERE sale_retail > 0 AND returned = 0)::int AS kept_sales,
     count(*) FILTER (WHERE sale_retail > 0 AND returned > 0)::int AS returned_sales,
     round(avg(commission) FILTER (WHERE sale_retail > 0 AND returned = 0)::numeric,2) AS avg_comm_kept,
     round(avg(logistics) FILTER (WHERE sale_retail > 0 AND returned = 0)::numeric,2) AS avg_log_kept,
     round(avg(other) FILTER (WHERE sale_retail > 0 AND returned = 0)::numeric,2) AS avg_other_kept,
     round(avg(sale_retail - commission - logistics - other - 200.28 - 10) FILTER (WHERE sale_retail > 0 AND returned = 0)::numeric,2) AS approx_net_before_tax_kept,
     round(avg(logistics) FILTER (WHERE returned > 0)::numeric,2) AS avg_log_on_returns
   FROM lines`
);

const modeled = {
  price,
  minProfit,
  commissionPct: cache.calculator.commissions.FBS.percent,
  logisticsModeled:
    Number(cache.calculator.logistics_cost || 0) +
    Number(cache.calculator.commissions.FBS.delivery_amount || 0),
  brandPct: cache.calculator.brand_promotion_percent,
  acquiringPct: cache.calculator.acquiring,
  buyoutOzon: prod.buyout_rate_ozon,
};

console.log(JSON.stringify({ modeled, econ: econ.rows[0], taxProfile }, null, 2));
await closePool();
