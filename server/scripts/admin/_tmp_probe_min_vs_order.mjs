import { query, closePool } from '../../src/config/database.js';
import repositoryFactory from '../../src/config/repository-factory.js';
import pricesService from '../../src/services/prices.service.js';
import { calculateMinPrice, resolveMinPriceTaxProfile } from '../../src/services/min-price-calculator.service.js';
import { resolveMarketplaceMinProfit } from '../../src/utils/marketplaceMinProfit.js';
import integrationsService from '../../src/services/integrations.service.js';
import { parsePricePushSettings } from '../../src/utils/pricePushSettings.js';

const product = await repositoryFactory.getProductsRepository().findById(187);
const cached = await pricesService._getMpCalculatorCacheRow(187, 'wb');
const calc = cached?.calculator || {};
const profileId = product.profile_id ?? product.profileId;
const wbCfg = await integrationsService.getMarketplaceConfig('wildberries', { profileId });
const pref = await query('SELECT price_push_settings FROM profiles WHERE id = $1', [profileId]);
const rules = parsePricePushSettings(pref.rows?.[0]?.price_push_settings).minMarkupRules;
const productForProfit = rules?.length ? { ...product, profileMinMarkupRules: rules } : product;
const profit = resolveMarketplaceMinProfit(productForProfit, 'wb', 50);
const taxProfile = resolveMinPriceTaxProfile(product);
const enriched = await pricesService._enrichWbCalculatorReturnAmount(
  calc,
  Number(calc.volume_weight) || 0,
  { profileId }
);
const basePrice = Number(product.cost) + Number(product.additional_expenses || 0);
const minFbo = calculateMinPrice(
  basePrice,
  enriched,
  'wb',
  profit,
  product,
  wbCfg?.acquiring_percent ?? null,
  wbCfg?.gem_services_percent ?? null,
  taxProfile,
  'FBO',
  wbCfg?.spp_percent ?? null
);
const minFbs = calculateMinPrice(
  basePrice,
  enriched,
  'wb',
  profit,
  product,
  wbCfg?.acquiring_percent ?? null,
  wbCfg?.gem_services_percent ?? null,
  taxProfile,
  'FBS',
  wbCfg?.spp_percent ?? null
);

const stored = await query(
  `SELECT min_price, min_price_fbo, min_price_fbs, updated_at,
          calculation_details->'_inputs' AS inputs,
          calculation_details->>'logistics_cost_fbo' AS log_fbo,
          calculation_details->>'logistics_cost' AS log,
          calculation_details->'commissions'->'FBO' AS comm_fbo,
          calculation_details->'commissions'->'FBS' AS comm_fbs
     FROM product_marketplace_prices
    WHERE product_id = 187 AND marketplace = 'wb'`
);

const order = await query(
  `SELECT operation_type, retail_amount, commission_amount, logistics_amount,
          payout_amount, acquiring_amount, other_deductions,
          raw_json->>'retail_price' AS retail_price,
          raw_json->>'retail_amount' AS buyer_amount,
          raw_json->>'ppvz_sales_commission' AS ppvz_commission,
          raw_json->>'commission_percent' AS commission_percent
     FROM marketplace_fbs_report_lines
    WHERE profile_id = 1 AND order_id = '5880665576'
    ORDER BY id`
);

console.log(
  JSON.stringify(
    {
      basePrice,
      cost: product.cost,
      add: product.additional_expenses,
      profitTarget: profit,
      buyout: product.buyout_rate_wb ?? product.buyout_rate,
      tax: {
        system: product.organization_tax_system,
        vat: product.organization_vat,
        profile: taxProfile,
      },
      wbCfg: {
        acquiring: wbCfg?.acquiring_percent,
        gem: wbCfg?.gem_services_percent,
        spp: wbCfg?.spp_percent,
        il: wbCfg?.localization_index,
      },
      calc: {
        vol: calc.volume_weight,
        log_fbo: enriched.logistics_cost_fbo,
        log_fbs: enriched.logistics_cost_fbs,
        il: enriched.logistics_localization_index,
        fboPct: enriched.commissions?.FBO?.percent,
        fbsPct: enriched.commissions?.FBS?.percent,
        returnFbo: enriched.commissions?.FBO?.return_amount,
        returnFbs: enriched.commissions?.FBS?.return_amount,
      },
      liveMin: { fbo: minFbo, fbs: minFbs },
      stored: stored.rows[0],
      order5880665576: order.rows,
      // actual economics at sale 1877
      actual: {
        sale: 1877,
        payout: 1154.72,
        logistics: 411.4,
        commission: 675.72,
        acquiring: 46.56,
        cost: 921.73,
        add: 10,
        roughNetBeforeTax: 1154.72 - 921.73 - 10 - 411.4,
      },
    },
    null,
    2
  )
);
await closePool();
