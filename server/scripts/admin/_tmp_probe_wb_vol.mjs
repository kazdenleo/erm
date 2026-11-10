import { query, closePool } from '../../src/config/database.js';
import pricesService from '../../src/services/prices.service.js';
import { calculateMinPrice } from '../../src/services/min-price-calculator.service.js';
import { resolveEffectiveVolumeLiters } from '../../src/utils/productVolume.js';
import { wbTariffWarehouseLabel, computeWbLogisticsCost } from '../../src/utils/wbTariffs.js';
import integrationsService from '../../src/services/integrations.service.js';
import repositoryFactory from '../../src/config/repository-factory.js';

const product = await repositoryFactory.getProductsRepository().findById(187);
const cached = await pricesService._getMpCalculatorCacheRow(187, 'wb');
const calc = cached?.calculator || {};
const vol = resolveEffectiveVolumeLiters(calc, product, 'wb');
const profileId = product.profile_id ?? product.profileId ?? null;
const box = await pricesService._resolveWbBoxTariffRow({ profileId }, calc);
const fbo = computeWbLogisticsCost(box, vol || 0, 'fbo', 1);
const fbo15 = computeWbLogisticsCost(box, 15, 'fbo', 1);
const enriched = await pricesService._enrichWbCalculatorReturnAmount(calc, Number(calc.volume_weight) || 0, { profileId });
const wbCfg = await integrationsService.getMarketplaceConfig('wildberries', { profileId });
const priceArgs = [
  Number(product.cost) + Number(product.additional_expenses || 0),
  enriched,
  'wb',
  138,
  product,
  wbCfg?.acquiring_percent ?? null,
  wbCfg?.gem_services_percent ?? null,
  null,
  'FBO',
  wbCfg?.spp_percent ?? null,
];
priceArgs[1] = enriched;
const price = calculateMinPrice(...priceArgs);
priceArgs[1] = { ...enriched, logistics_localization_index: 1 };
const priceIfIndex1 = calculateMinPrice(...priceArgs);
console.log(JSON.stringify({
  profileId,
  localizationIndex: wbCfg?.localization_index ?? null,
  warehouse: wbTariffWarehouseLabel(box),
  fboBase: box?.boxDeliveryBase,
  fboLiter: box?.boxDeliveryLiter,
  mpBase: box?.boxDeliveryMarketplaceBase,
  mpLiter: box?.boxDeliveryMarketplaceLiter,
  resolvedVolume: vol,
  cacheVolume: calc.volume_weight,
  fboAtResolved: fbo,
  fboAt15: fbo15,
  enrichedCost: enriched.logistics_cost_fbo,
  enrichedBase: enriched.logistics_base_fbo,
  enrichedLiter: enriched.logistics_liter_fbo,
  minPriceNow: price,
  minPriceIfIndex1: priceIfIndex1,
  productDims: { l: product.length, w: product.width, h: product.height },
  hasWbAttrs: !!product.wb_attributes,
  hasDraft: !!product.wb_draft,
}, null, 2));
await closePool();
