/**
 * Расчёт минимальной цены по данным калькулятора маркетплейса.
 * Дублирует логику клиента (Prices.jsx calculateMinPrice) для пересчёта на сервере.
 */

export function calculateMinPrice(basePrice, calculator, marketplace, minProfit, product = null, wbAcquiringPercent = null, wbGemServicesPercent = null) {
  const basePriceNum = Number(basePrice) || 0;
  const minProfitNum = (minProfit != null && minProfit !== '' && !isNaN(Number(minProfit))) ? Number(minProfit) : null;
  if (minProfitNum == null || minProfitNum < 0) return null;
  if (!calculator || !calculator.commissions) return null;

  const commissions = calculator.commissions;
  const commission = marketplace === 'wb'
    ? (commissions.FBS || { percent: 0, value: 0, delivery_amount: 0, return_amount: 0 })
    : (commissions.FBS || commissions.FBO || { percent: 0, value: 0, delivery_amount: 0, return_amount: 0 });

  let acquiring = 0;
  if (marketplace === 'wb') {
    acquiring = (wbAcquiringPercent != null && wbAcquiringPercent !== undefined) ? Number(wbAcquiringPercent) || 0 : 0;
  } else {
    acquiring = (calculator.acquiring != null && calculator.acquiring !== undefined) ? Number(calculator.acquiring) : 0;
  }

  let ymAgencyFixed = 0, ymPaymentTransferPercent = 0, ymPaymentTransferFixed = 0;
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
    processingCost = (calculator.processing_cost != null) ? Number(calculator.processing_cost) : 0;
  }

  let logisticsCost = 0;
  if (marketplace === 'wb') {
    if (calculator.logistics_base != null && calculator.logistics_liter != null) {
      const volume = (calculator.volume_weight != null) ? calculator.volume_weight : (Number(product?.volume) || 0);
      if (volume && volume > 1) {
        logisticsCost = Number(calculator.logistics_base) + Number(calculator.logistics_liter) * Math.ceil(volume - 1);
      } else {
        logisticsCost = Number(calculator.logistics_base);
      }
    } else {
      logisticsCost = (calculator.logistics_cost != null && calculator.logistics_cost !== '') ? Number(calculator.logistics_cost) : 0;
    }
  } else {
    logisticsCost = (calculator.logistics_cost != null) ? Number(calculator.logistics_cost) : 0;
    if (marketplace === 'ozon' && logisticsCost > 0) logisticsCost = Math.round(logisticsCost);
  }

  let deliveryToCustomer = (commission.delivery_amount != null) ? Number(commission.delivery_amount) : 0;
  let ymDeliveryPercent = 0;
  if (marketplace === 'ym' && calculator.ymTariffs) {
    const addRelative = (t) => (!t || (t.valueType || '').toLowerCase() !== 'relative') ? 0 : (Number(t.value) || 0) / 100;
    ymDeliveryPercent = addRelative(calculator.ymTariffs.DELIVERY_TO_CUSTOMER) + addRelative(calculator.ymTariffs.CROSSREGIONAL_DELIVERY) + addRelative(calculator.ymTariffs.EXPRESS_DELIVERY);
    deliveryToCustomer = 0;
  }

  let returnCost = 0, returnProcessingCost = 0, returnLossCost = 0;
  if (product && product.buyout_rate != null && product.buyout_rate !== '' && !isNaN(Number(product.buyout_rate))) {
    const buyoutRateInput = Number(product.buyout_rate);
    const returnRate = 1 - buyoutRateInput / 100;
    if (buyoutRateInput < 100 && returnRate > 0) {
      returnLossCost = basePriceNum * returnRate;
      const returnAmount = (commission.return_amount != null) ? Number(commission.return_amount) : 0;
      returnCost = returnAmount * returnRate;
      const rp = (commission.return_processing_amount != null) ? Number(commission.return_processing_amount) : 0;
      returnProcessingCost = rp * returnRate;
    }
  }

  const marketplaceCommissionPercent = (Number(commission.percent) || 0) / 100;
  const acquiringPercent = (Number(acquiring) || 0) / 100;
  let gemServicesPercent = 0;
  if (marketplace === 'wb' && wbGemServicesPercent != null) gemServicesPercent = (Number(wbGemServicesPercent) || 0) / 100;
  const brandPromotionPercent = (calculator.brand_promotion_percent != null && !isNaN(Number(calculator.brand_promotion_percent))) ? Number(calculator.brand_promotion_percent) / 100 : 0;

  const fixedExpenses = Number(processingCost) + Number(logisticsCost) + Number(deliveryToCustomer) + Number(returnCost) + Number(returnProcessingCost) + Number(returnLossCost) + (marketplace === 'ym' ? (ymAgencyFixed + ymPaymentTransferFixed) : 0);
  const taxRate = 0.15;
  const targetProfitBeforeTax = Number(minProfitNum) / (1 - taxRate);

  const calculateNetProfit = (price) => {
    const priceNum = Number(price) || 0;
    const commissionAmount = priceNum * marketplaceCommissionPercent;
    let acquiringAmount = priceNum * acquiringPercent;
    if (marketplace === 'ym') acquiringAmount = ymAgencyFixed + ymPaymentTransferFixed + priceNum * ymPaymentTransferPercent;
    else if (marketplace === 'ozon') acquiringAmount = Math.ceil(acquiringAmount);
    const deliveryAmountAtPrice = marketplace === 'ym' ? priceNum * ymDeliveryPercent : 0;
    const totalExpenses = basePriceNum + fixedExpenses + commissionAmount + acquiringAmount + deliveryAmountAtPrice + priceNum * brandPromotionPercent + priceNum * gemServicesPercent;
    const profitBeforeTax = priceNum - totalExpenses;
    const taxes = Math.max(0, profitBeforeTax * taxRate);
    return profitBeforeTax - taxes;
  };

  const denominator = 1 - marketplaceCommissionPercent - acquiringPercent - brandPromotionPercent - gemServicesPercent - (marketplace === 'ym' ? ymDeliveryPercent : 0);
  if (denominator <= 0) return null;

  let recommendedPrice = Math.round((basePriceNum + fixedExpenses + targetProfitBeforeTax) / denominator);
  let netProfit = calculateNetProfit(recommendedPrice);
  const maxIterations = 5000;
  let iterations = 0;
  while (netProfit < Number(minProfitNum) && iterations < maxIterations) {
    recommendedPrice += 1;
    netProfit = calculateNetProfit(recommendedPrice);
    iterations++;
    if (recommendedPrice > basePriceNum * 20) break;
  }

  let finalPrice = recommendedPrice;
  while (calculateNetProfit(finalPrice) < Number(minProfitNum)) {
    finalPrice += 1;
    if (finalPrice > basePriceNum * 20) break;
  }
  return finalPrice > 0 ? Math.round(finalPrice) : null;
}
