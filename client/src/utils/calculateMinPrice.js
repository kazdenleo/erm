/**
 * Расчёт минимальной цены — синхронно с server/src/services/min-price-calculator.service.js.
 */

import { enrichCalculatorVolumeFromProduct, resolveEffectiveVolumeLiters } from './productVolume.js';
import { computeTaxesAndNetProfit, resolveOrganizationTaxProfile } from './organizationTaxRates.js';
import { resolveMarketplaceBuyoutRate } from './marketplaceBuyoutRate.js';
import { resolveMarketplaceMinProfit } from './marketplaceMinProfit.js';
import { enrichOzonCalculatorFromProduct } from './ozonBrandPromotion.js';

export const MIN_USABLE_COMMISSION_PERCENT = 0.01;

export function extractMinPriceCommissionPercent(calculator, marketplace, scheme = null) {
  const commissions = calculator?.commissions;
  if (!commissions || typeof commissions !== 'object') return null;
  const mp = String(marketplace || '').toLowerCase();
  const want = String(scheme || '').toUpperCase();
  let raw;
  if (want === 'FBS') {
    raw = commissions.FBS?.percent ?? commissions.FBO?.percent;
  } else if (want === 'FBO' || want === 'FBY' || want === 'FBW') {
    raw = commissions.FBO?.percent ?? commissions.FBS?.percent;
  } else if (mp === 'wb' || mp === 'wildberries') {
    raw = commissions.FBO?.percent ?? commissions.FBS?.percent;
  } else {
    raw = commissions.FBS?.percent ?? commissions.FBO?.percent;
  }
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function hasUsableCommissionPercent(calculator, marketplace, scheme = null) {
  const p = extractMinPriceCommissionPercent(calculator, marketplace, scheme);
  return p != null && p >= MIN_USABLE_COMMISSION_PERCENT;
}

export function normalizePriceScheme(scheme, marketplace) {
  const s = String(scheme || '').toUpperCase();
  if (s === 'FBS') return 'FBS';
  if (s === 'FBO' || s === 'FBY' || s === 'FBW') return 'FBO';
  const mp = String(marketplace || '').toLowerCase();
  return mp === 'wb' || mp === 'wildberries' ? 'FBO' : 'FBS';
}

function safeExpenseNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function finiteOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function wbLogisticsCostFromCalculator(calculator, product, priceScheme) {
  const scheme = String(priceScheme || '').toUpperCase() === 'FBS' ? 'fbs' : 'fbo';
  const base =
    finiteOrNull(calculator?.[`logistics_base_${scheme}`]) ??
    finiteOrNull(calculator?.logistics_base);
  const liter =
    finiteOrNull(calculator?.[`logistics_liter_${scheme}`]) ??
    finiteOrNull(calculator?.logistics_liter) ??
    0;
  const precomputed =
    finiteOrNull(calculator?.[`logistics_cost_${scheme}`]) ??
    finiteOrNull(calculator?.logistics_cost);
  const volume = resolveEffectiveVolumeLiters(calculator, product, 'wb') || 0;
  if (base != null) {
    if (volume > 1) return base + liter * Math.ceil(volume - 1);
    if (volume > 0) return base;
    if (precomputed != null && precomputed > 0) return precomputed;
    return base;
  }
  return precomputed || 0;
}

/**
 * @param {string|null} [scheme] — 'FBS' | 'FBO' (по умолчанию: WB→FBO, остальные→FBS)
 */
export function calculateMinPrice(
  basePrice,
  calculator,
  marketplace,
  minProfit,
  product = null,
  wbAcquiringPercent = null,
  wbGemServicesPercent = null,
  taxProfile = null,
  scheme = null
) {
  const basePriceNum = Number(basePrice) || 0;
  const minProfitNum = (minProfit != null && minProfit !== '' && !isNaN(Number(minProfit))) ? Number(minProfit) : null;
  if (minProfitNum == null || minProfitNum < 0) return null;
  if (!calculator || !calculator.commissions) return null;

  const priceScheme = normalizePriceScheme(scheme, marketplace);

  if (!hasUsableCommissionPercent(calculator, marketplace, priceScheme)) {
    return null;
  }

  const commissions = calculator.commissions;
  let commission;
  if (marketplace === 'wb') {
    const wbBase = priceScheme === 'FBS'
      ? (commissions.FBS || commissions.FBO)
      : (commissions.FBO || commissions.FBS);
    commission = { ...wbBase, delivery_amount: 0 };
  } else if (priceScheme === 'FBO') {
    commission = commissions.FBO || commissions.FBS;
  } else {
    commission = commissions.FBS || commissions.FBO;
  }
  if (!commission || Number(commission.percent) < MIN_USABLE_COMMISSION_PERCENT) {
    return null;
  }

  let acquiring = 0;
  if (marketplace === 'wb') {
    acquiring = (wbAcquiringPercent != null && wbAcquiringPercent !== undefined) ? Number(wbAcquiringPercent) || 0 : 0;
  } else {
    acquiring = (calculator.acquiring != null && calculator.acquiring !== undefined) ? Number(calculator.acquiring) : 0;
  }

  let ymAgencyFixed = 0;
  let ymPaymentTransferPercent = 0;
  let ymPaymentTransferFixed = 0;
  if (marketplace === 'ym' && calculator.ymTariffs) {
    const agency = calculator.ymTariffs.AGENCY_COMMISSION;
    const payment = calculator.ymTariffs.PAYMENT_TRANSFER;
    const agencyVT = (agency?.valueType || '').toLowerCase();
    const agencyVal = Number(agency?.value) ?? Number(agency?.amount) ?? 0;
    const paymentVT = (payment?.valueType || '').toLowerCase();
    const paymentVal = Number(payment?.value) ?? Number(payment?.amount) ?? 0;
    ymAgencyFixed = agencyVT === 'absolute' ? agencyVal : 0;
    if (paymentVT === 'relative') {
      ymPaymentTransferPercent = paymentVal / 100;
      acquiring = paymentVal;
    } else {
      ymPaymentTransferFixed = paymentVal;
    }
  }

  let processingCost = 0;
  if (marketplace === 'ozon' || marketplace === 'ym') {
    if (priceScheme === 'FBO') {
      processingCost = 0;
    } else {
      processingCost = (calculator.processing_cost != null) ? Number(calculator.processing_cost) : 0;
    }
  }

  let logisticsCost = 0;
  if (marketplace === 'wb') {
    logisticsCost = wbLogisticsCostFromCalculator(calculator, product, priceScheme);
  } else if (marketplace === 'ozon' && priceScheme === 'FBO') {
    const fboLog =
      commission.direct_flow_trans_amount != null
        ? Number(commission.direct_flow_trans_amount)
        : (calculator.logistics_cost_fbo != null ? Number(calculator.logistics_cost_fbo) : 0);
    logisticsCost = Number.isFinite(fboLog) ? fboLog : 0;
    if (logisticsCost > 0) logisticsCost = Math.round(logisticsCost);
  } else {
    logisticsCost = (calculator.logistics_cost != null) ? Number(calculator.logistics_cost) : 0;
    if (marketplace === 'ozon' && logisticsCost > 0) logisticsCost = Math.round(logisticsCost);
  }

  let deliveryToCustomer = safeExpenseNum(commission.delivery_amount);
  let ymDeliveryPercent = 0;
  if (marketplace === 'ym' && calculator.ymTariffs) {
    const addRelative = (t) => (!t || (t.valueType || '').toLowerCase() !== 'relative') ? 0 : (Number(t.value) || 0) / 100;
    ymDeliveryPercent = addRelative(calculator.ymTariffs.DELIVERY_TO_CUSTOMER) + addRelative(calculator.ymTariffs.CROSSREGIONAL_DELIVERY) + addRelative(calculator.ymTariffs.EXPRESS_DELIVERY);
    deliveryToCustomer = 0;
  }

  let returnCost = 0;
  let returnProcessingCost = 0;
  let returnLossCost = 0;
  const buyoutRateInput = resolveMarketplaceBuyoutRate(product, marketplace);
  if (buyoutRateInput != null) {
    const returnRate = 1 - buyoutRateInput / 100;
    if (buyoutRateInput < 100 && returnRate > 0) {
      returnLossCost = basePriceNum * returnRate;
      const returnAmount = safeExpenseNum(commission.return_amount);
      returnCost = returnAmount * returnRate;
      const rp = safeExpenseNum(commission.return_processing_amount);
      returnProcessingCost = rp * returnRate;
    }
  }

  const marketplaceCommissionPercent = (extractMinPriceCommissionPercent(calculator, marketplace, priceScheme) || 0) / 100;
  if (marketplaceCommissionPercent < MIN_USABLE_COMMISSION_PERCENT / 100) return null;
  const acquiringPercent = (Number(acquiring) || 0) / 100;
  let gemServicesPercent = 0;
  if (marketplace === 'wb' && wbGemServicesPercent != null) gemServicesPercent = (Number(wbGemServicesPercent) || 0) / 100;
  const brandPromotionPercent = (calculator.brand_promotion_percent != null && !isNaN(Number(calculator.brand_promotion_percent))) ? Number(calculator.brand_promotion_percent) / 100 : 0;
  const adsPromotionPercent = (calculator.ads_promotion_percent != null && !isNaN(Number(calculator.ads_promotion_percent))) ? Number(calculator.ads_promotion_percent) / 100 : 0;

  const profile = resolveMinPriceTaxProfile(product, taxProfile);

  const fixedExpenses =
    safeExpenseNum(processingCost) +
    safeExpenseNum(logisticsCost) +
    safeExpenseNum(deliveryToCustomer) +
    safeExpenseNum(returnCost) +
    safeExpenseNum(returnProcessingCost) +
    safeExpenseNum(returnLossCost) +
    (marketplace === 'ym' ? safeExpenseNum(ymAgencyFixed) + safeExpenseNum(ymPaymentTransferFixed) : 0);

  const variableRate =
    marketplaceCommissionPercent +
    acquiringPercent +
    brandPromotionPercent +
    adsPromotionPercent +
    gemServicesPercent +
    (marketplace === 'ym' ? ymDeliveryPercent : 0);

  const calculateNetProfit = (price) => {
    const priceNum = Number(price) || 0;
    const commissionAmount = priceNum * marketplaceCommissionPercent;
    let acquiringAmount = priceNum * acquiringPercent;
    if (marketplace === 'ym') acquiringAmount = ymAgencyFixed + ymPaymentTransferFixed + priceNum * ymPaymentTransferPercent;
    else if (marketplace === 'ozon') acquiringAmount = Math.round(acquiringAmount * 100) / 100;
    const deliveryAmountAtPrice = marketplace === 'ym' ? priceNum * ymDeliveryPercent : 0;
    const mpExpensesWithoutBase =
      fixedExpenses +
      commissionAmount +
      acquiringAmount +
      deliveryAmountAtPrice +
      priceNum * brandPromotionPercent +
      priceNum * adsPromotionPercent +
      priceNum * gemServicesPercent;
    const { netProfit } = computeTaxesAndNetProfit({
      price: priceNum,
      totalExpenses: basePriceNum + mpExpensesWithoutBase,
      taxProfile: profile,
    });
    return netProfit;
  };

  const denominator = 1 - variableRate;
  if (denominator <= 0) return null;

  const targetNet = Number(minProfitNum);
  const vatR = Number(profile.vatRate) || 0;
  const incR = Number(profile.incomeTaxRate) || 0;
  const fixedTotal = basePriceNum + fixedExpenses;
  let seedDenom;
  let seedNumerator;
  if (profile.incomeTaxOnRevenue) {
    seedDenom = 1 - variableRate - vatR - incR;
    seedNumerator = fixedTotal + targetNet;
  } else {
    seedDenom = 1 - variableRate - vatR;
    seedNumerator = fixedTotal + (incR < 1 ? targetNet / (1 - incR) : targetNet);
  }
  if (!(seedDenom > 0.01)) seedDenom = denominator;

  let recommendedPrice = Math.max(1, Math.round(seedNumerator / seedDenom));
  let netProfit = calculateNetProfit(recommendedPrice);
  const maxIterations = 5000;
  let iterations = 0;
  while (netProfit < targetNet && iterations < maxIterations) {
    recommendedPrice += 1;
    netProfit = calculateNetProfit(recommendedPrice);
    iterations++;
    if (recommendedPrice > basePriceNum * 20 + 1000) break;
  }

  while (recommendedPrice > 1 && calculateNetProfit(recommendedPrice - 1) >= targetNet) {
    recommendedPrice -= 1;
  }

  let finalPrice = recommendedPrice;
  while (calculateNetProfit(finalPrice) < targetNet) {
    finalPrice += 1;
    if (finalPrice > basePriceNum * 20 + 1000) break;
  }
  return finalPrice > 0 ? Math.round(finalPrice) : null;
}

export function resolveMinPriceTaxProfile(product, taxProfile = null) {
  if (taxProfile && typeof taxProfile === 'object') {
    if (
      taxProfile.vatRate != null ||
      taxProfile.incomeTaxRate != null ||
      taxProfile.taxSystemCode != null
    ) {
      return taxProfile;
    }
    return resolveOrganizationTaxProfile(taxProfile);
  }
  if (
    product?.organization_tax_system != null ||
    product?.organization_vat != null ||
    product?.organizationTaxSystem != null ||
    product?.organizationVat != null
  ) {
    return resolveOrganizationTaxProfile({
      tax_system: product.organization_tax_system ?? product.organizationTaxSystem,
      vat: product.organization_vat ?? product.organizationVat,
    });
  }
  if (product?.organization && typeof product.organization === 'object') {
    return resolveOrganizationTaxProfile(product.organization);
  }
  return resolveOrganizationTaxProfile(null);
}

export function pickStoredCalculator(product, marketplace, scheme = null) {
  if (!product) return null;
  const mp = String(marketplace || '').toLowerCase();
  const mpCap = mp === 'ozon' ? 'Ozon' : mp === 'wb' ? 'Wb' : mp === 'ym' ? 'Ym' : '';
  if (!mpCap) return null;
  const schemeNorm = String(scheme || '').toUpperCase();
  if (schemeNorm === 'FBS') {
    return product[`storedCalculationDetails${mpCap}Fbs`] || product[`storedCalculationDetails${mpCap}`] || null;
  }
  if (schemeNorm === 'FBO' || schemeNorm === 'FBY' || schemeNorm === 'FBW') {
    return product[`storedCalculationDetails${mpCap}Fbo`] || product[`storedCalculationDetails${mpCap}`] || null;
  }
  return product[`storedCalculationDetails${mpCap}`] || null;
}

/**
 * Живая мин. цена по сохранённым деталям калькулятора (как в модалке).
 */
export function liveMinPriceForProduct(product, marketplace, scheme, opts = {}) {
  const mp = String(marketplace || '').toLowerCase();
  let calculator = pickStoredCalculator(product, mp, scheme);
  if (!calculator || typeof calculator !== 'object') return null;

  calculator = enrichCalculatorVolumeFromProduct(calculator, product, mp);
  if (mp === 'ozon') {
    calculator = enrichOzonCalculatorFromProduct(calculator, product);
    if (opts.ozonAcquiringPercent != null && opts.ozonAcquiringPercent !== '') {
      calculator = { ...calculator, acquiring: Number(opts.ozonAcquiringPercent) || 0 };
    }
  }

  const cost = Number(product?.cost ?? product?.price ?? product?.base_price ?? 0) || 0;
  const add = Number(product?.additionalExpenses ?? product?.additional_expenses ?? 0) || 0;
  const base = cost + add;
  if (base <= 0) return null;

  const minProfit = resolveMarketplaceMinProfit(product, mp, null);
  const wbAcq = opts.wbAcquiringPercent != null
    ? opts.wbAcquiringPercent
    : (calculator.acquiring != null ? Number(calculator.acquiring) : null);
  const wbGem = opts.wbGemServicesPercent != null
    ? opts.wbGemServicesPercent
    : (calculator.gem_services_percent != null ? Number(calculator.gem_services_percent) : null);
  return calculateMinPrice(
    base,
    calculator,
    mp,
    minProfit,
    product,
    wbAcq,
    wbGem,
    opts.taxProfile,
    scheme
  );
}

export function storedMinPriceForProduct(product, marketplace, scheme = null) {
  if (!product) return null;
  const mp = String(marketplace || '').toLowerCase();
  const schemeNorm = String(scheme || '').toUpperCase();
  const num = (v) => {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  if (mp === 'ozon') {
    if (schemeNorm === 'FBO') return num(product.storedMinPriceOzonFbo);
    if (schemeNorm === 'FBS') return num(product.storedMinPriceOzonFbs) ?? num(product.storedMinPriceOzon ?? product.stored_min_price_ozon);
    return num(product.storedMinPriceOzon ?? product.stored_min_price_ozon);
  }
  if (mp === 'wb') {
    if (schemeNorm === 'FBS') return num(product.storedMinPriceWbFbs);
    if (schemeNorm === 'FBO') return num(product.storedMinPriceWbFbo) ?? num(product.storedMinPriceWb ?? product.stored_min_price_wb);
    return num(product.storedMinPriceWb ?? product.stored_min_price_wb);
  }
  if (mp === 'ym') {
    if (schemeNorm === 'FBO') return num(product.storedMinPriceYmFbo);
    if (schemeNorm === 'FBS') return num(product.storedMinPriceYmFbs) ?? num(product.storedMinPriceYm ?? product.stored_min_price_ym);
    return num(product.storedMinPriceYm ?? product.stored_min_price_ym);
  }
  return null;
}
