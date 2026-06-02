#!/usr/bin/env node
import pricesService from '../../src/services/prices.service.js';
import { calculateMinPrice } from '../../src/services/min-price-calculator.service.js';
import repositoryFactory from '../../src/config/repository-factory.js';
import integrationsService from '../../src/services/integrations.service.js';

const sku = process.argv[2] || 'MK-5014';
const repo = repositoryFactory.getProductsRepository();
const p = await repo.findBySku(sku);
if (!p) {
  console.log('product not found:', sku);
  process.exit(1);
}
const scope = { organizationId: p.organization_id ?? p.organizationId };
const wbCfg = await integrationsService.getMarketplaceConfig('wildberries', scope);
const acq = wbCfg?.acquiring_percent != null ? Number(wbCfg.acquiring_percent) : null;
const gem = wbCfg?.gem_services_percent != null ? Number(wbCfg.gem_services_percent) : null;

console.log({
  id: p.id,
  sku_wb: p.sku_wb,
  mp_wb_vendor_code: p.mp_wb_vendor_code,
  org: scope.organizationId,
  cost: p.cost,
  additional_expenses: p.additional_expenses,
  min_price_field: p.min_price,
  volume: p.volume,
  buyout_rate: p.buyout_rate,
  acquiring_percent: acq,
  gem_services_percent: gem
});

const r = await pricesService.recalculateAndSaveForProduct(p.id);
console.log('recalc errors:', r.errors);

const skuWb = p.sku_wb || p.sku;
const wbResult = await pricesService.getWBPrices(skuWb, null, null, p.user_category_id, { integrationScope: scope });
const data = wbResult?.data ?? wbResult;
console.log('getWBPrices:', {
  found: data?.found,
  error: data?.error,
  fbsPercent: data?.calculator?.commissions?.FBS?.percent,
  logistics_cost: data?.calculator?.logistics_cost,
  volume_weight: data?.calculator?.volume_weight
});

if (data?.calculator) {
  const base = (Number(p.cost) || 0) + (Number(p.additional_expenses ?? p.additionalExpenses) || 0);
  const minProfit = p.min_price != null && !isNaN(Number(p.min_price)) ? Number(p.min_price) : 50;
  const price = calculateMinPrice(base, data.calculator, 'wb', minProfit, p, acq, gem);
  console.log('calculateMinPrice:', { base, minProfit, price });
  const comm = data.calculator.commissions?.FBS?.percent || 0;
  const denom = 1 - comm / 100 - (acq || 0) / 100 - (gem || 0) / 100;
  console.log('denominator approx:', denom);
}

process.exit(0);
