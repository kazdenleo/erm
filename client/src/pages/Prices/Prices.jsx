/**
 * Prices Page
 * Страница управления ценами товаров на маркетплейсах
 */

import React, { useState, useEffect } from 'react';
import { useProducts } from '../../hooks/useProducts';
import { useWarehouses } from '../../hooks/useWarehouses';
import { pricesApi } from '../../services/prices.api.js';
import { categoryMappingsApi } from '../../services/categoryMappings.api.js';
import { integrationsApi } from '../../services/integrations.api.js';
import { Button } from '../../components/common/Button/Button';
import { Modal } from '../../components/common/Modal/Modal';
import { PriceDetailsModal } from '../../components/PriceDetailsModal/PriceDetailsModal';
import './Prices.css';

// Нормализация ответа API: сервер возвращает { ok, data: result }, axios даёт response.data = этот объект
function getPriceResult(r) {
  if (r == null) return r;
  if (typeof r === 'object' && 'data' in r && r.data != null) return r.data;
  return r;
}

// Функция расчета минимальной цены на основе комиссий. Только фактические данные, без значений по умолчанию.
function calculateMinPrice(basePrice, calculator, marketplace, minProfit, product = null, wbAcquiringPercent = null, wbGemServicesPercent = null) {
  const basePriceNum = Number(basePrice) || 0;
  // Минимальная прибыль — только из карточки товара; без значения расчёт не выполняем
  const minProfitNum = (minProfit != null && minProfit !== '' && !isNaN(Number(minProfit))) ? Number(minProfit) : null;
  if (minProfitNum == null || minProfitNum < 0) {
    return null;
  }

  // Только фактический расчёт по данным API
  if (!calculator || !calculator.commissions) {
    return null;
  }

  const commissions = calculator.commissions;
  // Расчёт минимальной цены для продажи по схеме FBS. Для WB используем только комиссию FBS (Маркетплейс), не FBO.
  const commission = marketplace === 'wb'
    ? (commissions.FBS || { percent: 0, value: 0, delivery_amount: 0, return_amount: 0 })
    : (commissions.FBS || commissions.FBO || { percent: 0, value: 0, delivery_amount: 0, return_amount: 0 });
  
  // ВАЖНО: Для WB логируем, какая комиссия используется
  if (marketplace === 'wb') {
    console.log(`[calculateMinPrice] ========== WB COMMISSION SELECTION ==========`);
    console.log(`[calculateMinPrice] Available commissions:`, {
      hasFBS: !!commissions.FBS,
      fbsPercent: commissions.FBS?.percent,
      hasFBO: !!commissions.FBO,
      fboPercent: commissions.FBO?.percent,
      selectedCommission: commission.percent,
      allCommissions: commissions
    });
    
    // Предупреждение, если используется FBO вместо FBS
    if (commissions.FBO && !commissions.FBS) {
      console.error(`[calculateMinPrice] ⚠ ERROR: FBS commission missing, but FBO exists! This should not happen.`);
    }
    if (commissions.FBS && commissions.FBO && commissions.FBS.percent !== commissions.FBO.percent) {
      console.log(`[calculateMinPrice] ✓ FBS (${commissions.FBS.percent}%) and FBO (${commissions.FBO.percent}%) differ - using FBS for WB`);
    }
    if (commission.percent === 0) {
      console.error(`[calculateMinPrice] ✗ ERROR: Selected commission percent is 0! This will cause incorrect calculation.`);
    }
    console.log(`[calculateMinPrice] ============================================`);
  }
  
  // Основные расходы (преобразуем в числа, без fallback - только из API)
  // Для Wildberries используем процент эквайринга из настроек
  let acquiring = 0;
  if (marketplace === 'wb') {
    if (wbAcquiringPercent !== null && wbAcquiringPercent !== undefined) {
      // Для WB: используем процент эквайринга из настроек (уже в процентах, например 2.5)
      // Это будет использовано как процент для умножения на цену товара
      acquiring = Number(wbAcquiringPercent) || 0;
      console.log(`[calculateMinPrice] ✓ WB acquiring percent from settings: ${acquiring}%`);
    } else {
      // Если настройки не загрузились или не установлены, используем 0
      acquiring = 0;
      console.warn(`[calculateMinPrice] ⚠ WB acquiring percent not loaded from settings, using 0%`);
    }
  } else {
    acquiring = calculator.acquiring !== undefined && calculator.acquiring !== null
      ? Number(calculator.acquiring)
      : 0;
  }
  // Для YM эквайринг = приём (AGENCY) + перевод (PAYMENT_TRANSFER): фикс. части в fixedExpenses, % в знаменателе
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

  // Обработка заказа: используем значение из API
  console.log(`[calculateMinPrice] ========== PROCESSING COST DEBUG ==========`);
  console.log(`[calculateMinPrice] Full calculator object:`, JSON.stringify(calculator, null, 2));
  console.log(`[calculateMinPrice] calculator.processing_cost:`, calculator.processing_cost);
  console.log(`[calculateMinPrice] calculator.processing_cost type:`, typeof calculator.processing_cost);
  console.log(`[calculateMinPrice] calculator.commissions:`, calculator.commissions);
  console.log(`[calculateMinPrice] calculator.commissions.FBS:`, calculator.commissions?.FBS);
  console.log(`[calculateMinPrice] calculator.commissions.FBS?.first_mile_amount:`, calculator.commissions?.FBS?.first_mile_amount);
  
  // Обработка заказа: Ozon — fbs_first_mile_max_amount; YM — SORTING; WB — нет
  let processingCost = 0;
  if (marketplace === 'ozon') {
    processingCost = calculator.processing_cost !== undefined && calculator.processing_cost !== null
      ? Number(calculator.processing_cost)
      : 0;
    console.log(`[calculateMinPrice] Ozon processing cost (from API): ${processingCost}`);
  } else if (marketplace === 'ym') {
    processingCost = calculator.processing_cost !== undefined && calculator.processing_cost !== null
      ? Number(calculator.processing_cost)
      : 0;
    console.log(`[calculateMinPrice] YM processing cost (SORTING): ${processingCost}`);
  }
  // WB: услуги "Обработка заказа" нет
  
  // Логистика: для WB пересчитываем из logistics_base + logistics_liter (как в PriceDetailsModal), иначе из API
  let logisticsCost = 0;
  if (marketplace === 'wb' && calculator.logistics_base !== undefined && calculator.logistics_liter !== undefined) {
    const volume = calculator.volume_weight !== undefined && calculator.volume_weight !== null
      ? calculator.volume_weight
      : (Number(product?.volume) || 0);
    if (volume && volume > 1) {
      const additionalLiters = Math.ceil(volume - 1);
      logisticsCost = calculator.logistics_base + calculator.logistics_liter * additionalLiters;
    } else {
      logisticsCost = calculator.logistics_base;
    }
  } else {
    // Ozon, YM: logistics_cost из API (YM — MIDDLE_MILE)
    logisticsCost = calculator.logistics_cost !== undefined && calculator.logistics_cost !== null
      ? Number(calculator.logistics_cost)
      : 0;
    if (marketplace === 'ozon' && logisticsCost > 0) {
      const logisticsCostBefore = logisticsCost;
      logisticsCost = Math.round(logisticsCost);
      console.log(`[calculateMinPrice] Ozon logistics cost rounded: ${logisticsCostBefore} → ${logisticsCost}`);
    }
  }
  
  // Доставка до клиента: для YM пересчёт по valueType (relative = % от цены)
  let deliveryToCustomer = commission.delivery_amount !== undefined && commission.delivery_amount !== null
    ? Number(commission.delivery_amount)
    : 0;
  let ymDeliveryPercent = 0;
  if (marketplace === 'ym' && calculator.ymTariffs) {
    const d = calculator.ymTariffs.DELIVERY_TO_CUSTOMER;
    const cr = calculator.ymTariffs.CROSSREGIONAL_DELIVERY;
    const ex = calculator.ymTariffs.EXPRESS_DELIVERY;
    const addRelative = (t) => {
      if (!t || (t.valueType || '').toLowerCase() !== 'relative') return 0;
      return (Number(t.value) || 0) / 100;
    };
    ymDeliveryPercent = addRelative(d) + addRelative(cr) + addRelative(ex);
    deliveryToCustomer = 0;
  }

  // Расчет возвратов (на основе процента выкупа товара)
  // Важно: рассчитываем на единицу товара, а не на общее количество
  let returnCost = 0;
  let returnProcessingCost = 0;
  let returnLossCost = 0; // Потеря себестоимости возвращенных товаров
  
  // Возвраты: только если в карточке указан процент выкупа (buyout_rate)
  if (product && product.buyout_rate != null && product.buyout_rate !== '' && !isNaN(Number(product.buyout_rate))) {
    const buyoutRateInput = Number(product.buyout_rate);
    const buyoutRate = buyoutRateInput / 100;
    const returnRate = 1 - buyoutRate;

    if (buyoutRateInput < 100 && returnRate > 0) {
      returnLossCost = basePriceNum * returnRate;

      let returnAmount = 0;
      if (commission.return_amount !== undefined && commission.return_amount !== null) {
        returnAmount = Number(commission.return_amount);
      }
      returnCost = returnAmount * returnRate;

      const returnProcessingFromApi = (commission.return_processing_amount !== undefined && commission.return_processing_amount !== null)
        ? Number(commission.return_processing_amount)
        : 0;
      returnProcessingCost = returnProcessingFromApi * returnRate;

      console.log(`[calculateMinPrice] ${marketplace} return costs (only from API/product):`, {
        return_amount: commission.return_amount,
        returnAmount_used: returnAmount,
        returnRate: (returnRate * 100).toFixed(2) + '%',
        returnCost: returnCost.toFixed(2),
        returnProcessingCost: returnProcessingCost.toFixed(2),
        returnLossCost: returnLossCost.toFixed(2)
      });
    }
  }
  
  // Процент комиссии маркетплейса (преобразуем в число)
  const marketplaceCommissionPercent = (Number(commission.percent) || 0) / 100;
  // Процент эквайринга (преобразуем в число)
  const acquiringPercent = (Number(acquiring) || 0) / 100;
  
  // Процент услуг Джем (только для WB, вычисляется от суммы товара)
  let gemServicesPercent = 0;
  if (marketplace === 'wb' && wbGemServicesPercent !== null && wbGemServicesPercent !== undefined) {
    gemServicesPercent = (Number(wbGemServicesPercent) || 0) / 100;
    console.log(`[calculateMinPrice] ✓ WB gem services percent from settings: ${wbGemServicesPercent}% (${gemServicesPercent})`);
  }
  
  // Комиссия за продвижение бренда — только из API/настроек, без подстановки по умолчанию
  const brandPromotionPercent = (calculator.brand_promotion_percent != null && !isNaN(Number(calculator.brand_promotion_percent)))
    ? Number(calculator.brand_promotion_percent) / 100
    : 0;
  
  // Фиксированные расходы: для YM доставка (%) и приём платежа (0.12 ₽) учитываются в формуле/итерации
  const fixedExpenses = Number(processingCost) + Number(logisticsCost) + Number(deliveryToCustomer) + Number(returnCost) + Number(returnProcessingCost) + Number(returnLossCost) + (marketplace === 'ym' ? (ymAgencyFixed + ymPaymentTransferFixed) : 0);

  const targetProfitAfterTax = Number(minProfitNum);
  const taxRate = 0.15;

  const calculateNetProfit = (price) => {
    const priceNum = Number(price) || 0;
    const commissionAmount = priceNum * marketplaceCommissionPercent;
    let acquiringAmount = priceNum * acquiringPercent;
    if (marketplace === 'ym') {
      acquiringAmount = ymAgencyFixed + ymPaymentTransferFixed + priceNum * ymPaymentTransferPercent;
    } else if (marketplace === 'ozon') {
      const acquiringAmountBefore = acquiringAmount;
      acquiringAmount = Math.ceil(acquiringAmount);
      if (acquiringAmountBefore !== acquiringAmount) {
        console.log(`[calculateNetProfit] Ozon acquiring amount rounded: ${acquiringAmountBefore.toFixed(2)} → ${acquiringAmount}`);
      }
    }
    const brandPromotionAmount = priceNum * brandPromotionPercent;
    const gemServicesAmount = priceNum * gemServicesPercent;
    const deliveryAmountAtPrice = marketplace === 'ym' ? priceNum * ymDeliveryPercent : 0;
    const totalExpenses = Number(basePriceNum) + Number(fixedExpenses) + Number(commissionAmount) + Number(acquiringAmount) + Number(deliveryAmountAtPrice) + Number(brandPromotionAmount) + Number(gemServicesAmount);
    const profitBeforeTax = priceNum - totalExpenses;
    const taxes = Math.max(0, profitBeforeTax * taxRate); // Налоги только с положительной прибылью
    const netProfit = profitBeforeTax - taxes;
    return Number(netProfit);
  };
  
  const denominator = 1 - marketplaceCommissionPercent - acquiringPercent - brandPromotionPercent - gemServicesPercent - (marketplace === 'ym' ? ymDeliveryPercent : 0);
  if (denominator <= 0) {
    console.warn('[calculateMinPrice] Invalid denominator (commission/acquiring/delivery data)');
    return null;
  }
  const targetProfitBeforeTax = targetProfitAfterTax / (1 - taxRate);
  let recommendedPrice = Math.round((basePriceNum + fixedExpenses + targetProfitBeforeTax) / denominator);
  
  // Итеративно увеличиваем цену по 1₽ до достижения целевой чистой прибыли.
  // Это гарантирует корректный результат при округлениях (Ozon: ceil эквайринга и т.д.)
  let netProfit = calculateNetProfit(recommendedPrice);
  let iterations = 0;
  const maxIterations = 5000; // защита от бесконечного цикла
  
  while (netProfit < targetProfitAfterTax && iterations < maxIterations) {
    recommendedPrice += 1;
    netProfit = calculateNetProfit(recommendedPrice);
    iterations++;
    
    if (recommendedPrice > basePriceNum * 20) {
      console.warn('[calculateMinPrice] Price too high, stopping iterations');
      break;
    }
  }
  
  // Финальная проверка расчета (убеждаемся, что все значения - числа)
  const recommendedPriceNum = Number(recommendedPrice) || 0;
  const finalCommissionAmount = Number(recommendedPriceNum * marketplaceCommissionPercent);
  // Для Ozon: округляем эквайринг в большую сторону до целого числа
  let finalAcquiringAmount = Number(recommendedPriceNum * acquiringPercent);
  if (marketplace === 'ozon') {
    const acquiringAmountBefore = finalAcquiringAmount;
    finalAcquiringAmount = Math.ceil(finalAcquiringAmount);
    console.log(`[calculateMinPrice] Ozon final acquiring amount rounded: ${acquiringAmountBefore.toFixed(2)} → ${finalAcquiringAmount}`);
  }
  const finalBrandPromotionAmount = Number(recommendedPriceNum * brandPromotionPercent);
  // Услуги Джем (только для WB, вычисляется от суммы товара)
  const finalGemServicesAmount = Number(recommendedPriceNum * gemServicesPercent);
  const finalTotalExpenses = Number(basePriceNum) + Number(fixedExpenses) + Number(finalCommissionAmount) + Number(finalAcquiringAmount) + Number(finalBrandPromotionAmount) + Number(finalGemServicesAmount);
  const finalProfitBeforeTax = Number(recommendedPriceNum) - Number(finalTotalExpenses);
  const finalTaxes = Math.max(0, Number(finalProfitBeforeTax) * taxRate);
  const finalNetProfit = Number(finalProfitBeforeTax) - Number(finalTaxes);
  
  const buyoutRateForLog = (product && product.buyout_rate != null && product.buyout_rate !== '') ? Number(product.buyout_rate) : null;
  const returnRatePercent = buyoutRateForLog != null ? ((1 - buyoutRateForLog / 100) * 100).toFixed(2) : '—';

  console.log(`[calculateMinPrice] Final calculation for ${marketplace}:`, {
    recommendedPrice: recommendedPriceNum,
    basePrice: basePriceNum,
    buyoutRate: buyoutRateForLog,
    returnRate: returnRatePercent + '%',
    returnLossCost: Number(returnLossCost).toFixed(2),
    returnCost: Number(returnCost).toFixed(2),
    returnProcessingCost: Number(returnProcessingCost).toFixed(2),
    totalReturnCosts: (Number(returnLossCost) + Number(returnCost) + Number(returnProcessingCost)).toFixed(2),
    processingCost: Number(processingCost).toFixed(2),
    logisticsCost: Number(logisticsCost).toFixed(2),
    fixedExpenses: Number(fixedExpenses).toFixed(2),
    commissionPercent: (Number(marketplaceCommissionPercent) * 100).toFixed(2) + '%',
    commissionAmount: Number(finalCommissionAmount).toFixed(2),
    acquiringPercent: (Number(acquiringPercent) * 100).toFixed(2) + '%',
    acquiringAmount: Number(finalAcquiringAmount).toFixed(2),
    brandPromotionAmount: Number(finalBrandPromotionAmount).toFixed(2),
    gemServicesAmount: Number(finalGemServicesAmount).toFixed(2),
    totalExpenses: Number(finalTotalExpenses).toFixed(2),
    profitBeforeTax: Number(finalProfitBeforeTax).toFixed(2),
    taxes: Number(finalTaxes).toFixed(2),
    netProfit: Number(finalNetProfit).toFixed(2),
    targetNetProfit: targetProfitAfterTax,
    iterations
  });
  
  // Финальная гарантия: итеративно добавляем 1₽, пока чистая прибыль < целевой
  let finalPrice = Number(recommendedPriceNum) || 0;
  let finalNetProfitCheck = calculateNetProfit(finalPrice);
  
  while (finalNetProfitCheck < targetProfitAfterTax) {
    finalPrice += 1;
    finalNetProfitCheck = calculateNetProfit(finalPrice);
    if (finalPrice > basePriceNum * 20) {
      console.warn(`[calculateMinPrice] Price adjustment stopped: price too high (${finalPrice})`);
      break;
    }
  }
  
  return finalPrice > 0 ? Math.round(finalPrice) : null;
}

export function Prices() {
  const { products, loading, error, loadProducts } = useProducts();
  const { warehouses } = useWarehouses();
  const [calculatedPrices, setCalculatedPrices] = useState({});
  const [loadingPrices, setLoadingPrices] = useState({});
  const [calculatorData, setCalculatorData] = useState({});
  const [priceErrors, setPriceErrors] = useState({}); // Ошибки расчета цен
  const [priceModal, setPriceModal] = useState({ isOpen: false, product: null, marketplace: null, price: null, calculatorData: null });
  const [wbAcquiringPercent, setWbAcquiringPercent] = useState(null); // Процент эквайринга для WB из настроек
  const [wbGemServicesPercent, setWbGemServicesPercent] = useState(null); // Процент услуг Джем для WB из настроек
  const [recalcAllLoading, setRecalcAllLoading] = useState(false); // Загрузка пересчёта всех цен
  const [recalcAllMessage, setRecalcAllMessage] = useState(null); // Сообщение после запуска фонового пересчёта
  const [recalcOneProductId, setRecalcOneProductId] = useState(null); // ID товара, для которого идёт пересчёт
  const [activeSection, setActiveSection] = useState('prices'); // 'prices' | 'promotions'
  const [activePromoMarketplace, setActivePromoMarketplace] = useState('ozon'); // 'ozon' | 'wb' | 'ym'
  const [ozonActions, setOzonActions] = useState([]);
  const [ozonActionsLoading, setOzonActionsLoading] = useState(false);
  const [ozonActionsError, setOzonActionsError] = useState(null);
  const [wbActions, setWbActions] = useState([]);
  const [wbActionsLoading, setWbActionsLoading] = useState(false);
  const [wbActionsError, setWbActionsError] = useState(null);
  const [actionModal, setActionModal] = useState({ isOpen: false, action: null });
  const [actionModalTab, setActionModalTab] = useState('participating');
  const [actionProducts, setActionProducts] = useState([]);
  const [actionCandidates, setActionCandidates] = useState([]);
  const [actionProductsLoading, setActionProductsLoading] = useState(false);
  const [actionCandidatesLoading, setActionCandidatesLoading] = useState(false);
  const [actionProductsError, setActionProductsError] = useState(null);
  const [actionCandidatesError, setActionCandidatesError] = useState(null);
  const [wbActionModal, setWbActionModal] = useState({ isOpen: false, promotion: null });
  const [wbActionDetails, setWbActionDetails] = useState(null);
  const [wbActionDetailsLoading, setWbActionDetailsLoading] = useState(false);
  const [wbActionDetailsError, setWbActionDetailsError] = useState(null);
  const [wbActionModalTab, setWbActionModalTab] = useState('details'); // 'details' | 'participating' | 'candidates'
  const [wbNomenclaturesIn, setWbNomenclaturesIn] = useState([]);
  const [wbNomenclaturesOut, setWbNomenclaturesOut] = useState([]);
  const [wbNomenclaturesInLoading, setWbNomenclaturesInLoading] = useState(false);
  const [wbNomenclaturesOutLoading, setWbNomenclaturesOutLoading] = useState(false);
  const [wbNomenclaturesInError, setWbNomenclaturesInError] = useState(null);
  const [wbNomenclaturesOutError, setWbNomenclaturesOutError] = useState(null);
  const [wbNomenclaturesInNotApplicable, setWbNomenclaturesInNotApplicable] = useState(false);
  const [wbNomenclaturesOutNotApplicable, setWbNomenclaturesOutNotApplicable] = useState(false);

  // Получаем wbWarehouseName из основного склада (type = 'warehouse' с указанным wbWarehouseName)
  const mainWarehouse = warehouses.find(w => w.type === 'warehouse' && w.wbWarehouseName);
  const wbWarehouseName = mainWarehouse?.wbWarehouseName || null;

  // Загрузка настроек интеграции Wildberries (эквайринг, услуги Джем) — один раз при монтировании
  useEffect(() => {
    let cancelled = false;
    const loadWBSettings = async () => {
      try {
        const response = await integrationsApi.getMarketplace('wildberries');
        if (cancelled) return;
        const config = response?.data || response || {};
        const acquiringPercent = config.acquiring_percent;
        if (acquiringPercent !== undefined && acquiringPercent !== null && acquiringPercent !== '') {
          const percentValue = Number(acquiringPercent);
          if (!isNaN(percentValue) && isFinite(percentValue)) {
            setWbAcquiringPercent(percentValue);
          } else {
            setWbAcquiringPercent(null);
          }
        } else {
          setWbAcquiringPercent(null);
        }
        const gemServicesPercent = config.gem_services_percent;
        if (gemServicesPercent !== undefined && gemServicesPercent !== null && gemServicesPercent !== '') {
          const percentValue = Number(gemServicesPercent);
          if (!isNaN(percentValue) && isFinite(percentValue)) {
            setWbGemServicesPercent(percentValue);
          } else {
            setWbGemServicesPercent(null);
          }
        } else {
          setWbGemServicesPercent(null);
        }
      } catch (err) {
        if (!cancelled) {
          console.error('[Prices] Error loading WB settings:', err);
          setWbAcquiringPercent(null);
          setWbGemServicesPercent(null);
        }
      }
    };
    loadWBSettings();
    return () => { cancelled = true; };
  }, []);

  // При открытии модалки акции — загружаем участвующие и доступные товары
  useEffect(() => {
    if (!actionModal.isOpen || !actionModal.action?.id) {
      return;
    }
    const actionId = actionModal.action.id;
    setActionProducts([]);
    setActionCandidates([]);
    setActionProductsError(null);
    setActionCandidatesError(null);

    let cancelled = false;
    (async () => {
      setActionProductsLoading(true);
      try {
        const res = await pricesApi.getOzonActionProducts(actionId);
        if (cancelled) return;
        const data = res?.data ?? res;
        setActionProducts(Array.isArray(data) ? data : []);
        if (res?.error) setActionProductsError(res.error);
      } catch (err) {
        if (!cancelled) {
          setActionProductsError(err.response?.data?.error || err.message || 'Ошибка загрузки');
          setActionProducts([]);
        }
      } finally {
        if (!cancelled) setActionProductsLoading(false);
      }
    })();

    setActionCandidatesLoading(true);
    (async () => {
      try {
        const res = await pricesApi.getOzonActionCandidates(actionId);
        if (cancelled) return;
        const data = res?.data ?? res;
        setActionCandidates(Array.isArray(data) ? data : []);
        if (res?.error) setActionCandidatesError(res.error);
      } catch (err) {
        if (!cancelled) {
          setActionCandidatesError(err.response?.data?.error || err.message || 'Ошибка загрузки');
          setActionCandidates([]);
        }
      } finally {
        if (!cancelled) setActionCandidatesLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [actionModal.isOpen, actionModal.action?.id]);

  // Загрузка акций Ozon при открытии вкладки «Акции» → Ozon
  useEffect(() => {
    if (activeSection !== 'promotions' || activePromoMarketplace !== 'ozon') return;
    let cancelled = false;
    const load = async () => {
      setOzonActionsLoading(true);
      setOzonActionsError(null);
      try {
        const res = await pricesApi.getOzonActions();
        const data = res?.data ?? res;
        if (cancelled) return;
        setOzonActions(Array.isArray(data) ? data : []);
        if (!Array.isArray(data) && res?.error) setOzonActionsError(res.error);
      } catch (err) {
        if (!cancelled) {
          setOzonActionsError(err.response?.data?.error || err.message || 'Ошибка загрузки акций');
          setOzonActions([]);
        }
      } finally {
        if (!cancelled) setOzonActionsLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [activeSection, activePromoMarketplace]);

  // При открытии модалки акции WB — загружаем детали и номенклатуры (участвующие / доступные)
  useEffect(() => {
    if (!wbActionModal.isOpen || !wbActionModal.promotion?.id) {
      setWbActionDetails(null);
      setWbNomenclaturesIn([]);
      setWbNomenclaturesOut([]);
      setWbActionModalTab('details');
      return;
    }
    const promotionId = wbActionModal.promotion.id;
    let cancelled = false;
    setWbActionDetails(null);
    setWbActionDetailsError(null);
    setWbActionDetailsLoading(true);
    setWbNomenclaturesIn([]);
    setWbNomenclaturesOut([]);
    setWbNomenclaturesInError(null);
    setWbNomenclaturesOutError(null);
    setWbNomenclaturesInNotApplicable(false);
    setWbNomenclaturesOutNotApplicable(false);

    (async () => {
      try {
        const res = await pricesApi.getWBPromotionDetails(promotionId);
        if (cancelled) return;
        const data = res?.data ?? res;
        setWbActionDetails(data || null);
        if (res?.error) setWbActionDetailsError(res.error);
      } catch (err) {
        if (!cancelled) {
          setWbActionDetailsError(err.response?.data?.error || err.message || 'Ошибка загрузки деталей акции');
          setWbActionDetails(null);
        }
      } finally {
        if (!cancelled) setWbActionDetailsLoading(false);
      }
    })();

    setWbNomenclaturesInLoading(true);
    (async () => {
      try {
        const res = await pricesApi.getWBPromotionNomenclatures(promotionId, true, 1000, 0);
        if (cancelled) return;
        const data = res?.data ?? res;
        setWbNomenclaturesIn(Array.isArray(data) ? data : []);
        setWbNomenclaturesInNotApplicable(res?.notApplicable === true);
        if (res?.error) setWbNomenclaturesInError(res.error);
      } catch (err) {
        if (!cancelled) {
          setWbNomenclaturesInError(err.response?.data?.error || err.message || 'Ошибка загрузки');
          setWbNomenclaturesIn([]);
        }
      } finally {
        if (!cancelled) setWbNomenclaturesInLoading(false);
      }
    })();

    setWbNomenclaturesOutLoading(true);
    (async () => {
      try {
        const res = await pricesApi.getWBPromotionNomenclatures(promotionId, false, 1000, 0);
        if (cancelled) return;
        const data = res?.data ?? res;
        setWbNomenclaturesOut(Array.isArray(data) ? data : []);
        setWbNomenclaturesOutNotApplicable(res?.notApplicable === true);
        if (res?.error) setWbNomenclaturesOutError(res.error);
      } catch (err) {
        if (!cancelled) {
          setWbNomenclaturesOutError(err.response?.data?.error || err.message || 'Ошибка загрузки');
          setWbNomenclaturesOut([]);
        }
      } finally {
        if (!cancelled) setWbNomenclaturesOutLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [wbActionModal.isOpen, wbActionModal.promotion?.id]);

  // Загрузка акций WB при открытии вкладки «Акции» → Wildberries
  useEffect(() => {
    if (activeSection !== 'promotions' || activePromoMarketplace !== 'wb') return;
    let cancelled = false;
    const load = async () => {
      setWbActionsLoading(true);
      setWbActionsError(null);
      try {
        const res = await pricesApi.getWBActions();
        const data = res?.data ?? res;
        if (cancelled) return;
        setWbActions(Array.isArray(data) ? data : []);
        if (!Array.isArray(data) && res?.error) setWbActionsError(res.error);
      } catch (err) {
        if (!cancelled) {
          setWbActionsError(err.response?.data?.error || err.message || 'Ошибка загрузки акций WB');
          setWbActions([]);
        }
      } finally {
        if (!cancelled) setWbActionsLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [activeSection, activePromoMarketplace]);

  // Подставляем сохранённые минимальные цены из БД в state при загрузке/обновлении списка товаров
  useEffect(() => {
    if (products.length === 0) return;
    const fromStored = {};
    products.forEach(p => {
      const key = String(p.id ?? p.sku ?? '');
      if (!key) return;
      // Учитываем и camelCase (ответ API), и snake_case (на случай другого формата)
      const ozonRaw = p.storedMinPriceOzon ?? p.stored_min_price_ozon;
      const wbRaw = p.storedMinPriceWb ?? p.stored_min_price_wb;
      const ymRaw = p.storedMinPriceYm ?? p.stored_min_price_ym;
      const ozon = ozonRaw != null && !isNaN(Number(ozonRaw)) ? Number(ozonRaw) : null;
      const wb = wbRaw != null && !isNaN(Number(wbRaw)) ? Number(wbRaw) : null;
      const ym = ymRaw != null && !isNaN(Number(ymRaw)) ? Number(ymRaw) : null;
      if (ozon != null || wb != null || ym != null) {
        fromStored[key] = { ozon, wb, ym, _estimated: { ozon: false, wb: false, ym: false } };
      }
    });
    setCalculatedPrices(prev => ({ ...prev, ...fromStored }));
  }, [products]);

  /** Полный расчёт минимальных цен по API для всех товаров. Возвращает массив { productId, ozon?, wb?, ym? } для сохранения в БД. */
  const runFullPriceCalculation = async () => {
    if (products.length === 0) return [];
    const pricesListForSave = [];
    const calculatePricesForProducts = async () => {
      const newCalculatedPrices = {};
      const newLoadingPrices = {};

      for (const product of products) {
        if (!product) continue;
        // База для расчёта минимальной цены = себестоимость + доп.расходы.
        // Если себестоимость не указана, используем цену товара/базовую цену и всё равно добавляем доп.расходы.
        const costBaseNum = Number(product.cost ?? product.price ?? product.base_price ?? 0) || 0;
        const additionalExpensesNum = Number(product.additionalExpenses ?? product.additional_expenses ?? 0) || 0;
        const basePriceNum = costBaseNum + additionalExpensesNum;
        if (basePriceNum <= 0) {
          continue;
        }

        const productKey = String(product.id ?? product.sku ?? '');
        if (!productKey) continue;

        newLoadingPrices[productKey] = true;

        try {
          let categoryMappings = [];
          if (product.id) {
            try {
              console.log(`[Prices] Loading category mappings for product ${product.id} (${product.sku || product.name || 'N/A'})`);
              console.log(`[Prices] Product ID type: ${typeof product.id}, value: ${product.id}`);
              const mappingsResponse = await categoryMappingsApi.getByProduct(product.id);
              console.log(`[Prices] Raw mappings response:`, mappingsResponse);
              console.log(`[Prices] Response status: ${mappingsResponse?.status || 'N/A'}, has data: ${!!mappingsResponse?.data}`);
              
              // Обрабатываем разные форматы ответа API
              let data = null;
              
              // axios оборачивает ответ в data, поэтому сначала проверяем mappingsResponse.data
              if (mappingsResponse?.data !== undefined) {
                data = mappingsResponse.data;
              } else {
                data = mappingsResponse;
              }
              
              console.log(`[Prices] Extracted data:`, {
                dataType: typeof data,
                isArray: Array.isArray(data),
                hasOk: !!data?.ok,
                hasData: !!data?.data,
                dataIsArray: Array.isArray(data?.data),
                keys: data && typeof data === 'object' ? Object.keys(data) : []
              });
              
              // Извлекаем массив маппингов
              if (Array.isArray(data)) {
                // Прямой массив
                categoryMappings = data;
                console.log(`[Prices] Using direct array, length: ${data.length}`);
              } else if (data?.ok && Array.isArray(data.data)) {
                // Формат { ok: true, data: [...] }
                categoryMappings = data.data;
                console.log(`[Prices] Using data.data array, length: ${data.data.length}`);
              } else if (data?.data && Array.isArray(data.data)) {
                // Формат { data: [...] }
                categoryMappings = data.data;
                console.log(`[Prices] Using nested data.data array, length: ${data.data.length}`);
              } else if (data && typeof data === 'object') {
                // Если это объект с массивом внутри, ищем первый массив
                const foundArray = Object.values(data).find(v => Array.isArray(v));
                categoryMappings = foundArray || [];
                console.log(`[Prices] Using found array from object values, length: ${categoryMappings.length}`);
              } else {
                categoryMappings = [];
                console.warn(`[Prices] ⚠ Could not extract array from response, using empty array`);
              }
              
              if (categoryMappings.length === 0) {
                console.warn(`[Prices] ⚠ No category mappings found for product ${product.id} (${product.sku || 'N/A'})`);
                console.warn(`[Prices] Response structure:`, {
                  hasData: !!mappingsResponse?.data,
                  dataType: typeof mappingsResponse?.data,
                  dataIsArray: Array.isArray(mappingsResponse?.data),
                  fullResponse: mappingsResponse
                });
              } else {
                console.log(`[Prices] ✓ Loaded ${categoryMappings.length} category mappings for product ${product.id}:`, categoryMappings);
              }
            } catch (err) {
              console.error(`[Prices] ✗ Error getting category mappings for product ${product.id}:`, err);
              console.error(`[Prices] Error details:`, {
                status: err.response?.status,
                statusText: err.response?.statusText,
                message: err.message,
                data: err.response?.data,
                url: err.config?.url
              });
              // Не прерываем расчет цен, если маппинги не загрузились
            }
          } else {
            console.warn(`[Prices] ⚠ Product ${product.sku || 'N/A'} has no ID, cannot load category mappings`);
          }

          const prices = {};
          const calculatorDataForProduct = {};

          const skuOzon = product.sku_ozon || product.ozon_sku || (product.product_skus && product.product_skus.ozon);
          const skuWb = product.sku_wb || product.wb_sku || (product.product_skus && product.product_skus.wb);
          // Для YM: SKU маркета или артикул товара — калькулятор работает по параметрам, не по артикулу
          const skuYm = product.sku_ym || product.ym_sku || (product.product_skus && product.product_skus.ym) || product.sku;

          // Расчет цены для Ozon
          if (skuOzon) {
            try {
              const mapping = categoryMappings.find(m => m.marketplace === 'ozon');
              const categoryId = mapping?.category_id || null;
              
              const rawOzon = await pricesApi.getOzonPrice(skuOzon);
              const ozonResult = getPriceResult(rawOzon);
              
              if (ozonResult?.found && ozonResult?.calculator) {
                const calculator = ozonResult.calculator;
                calculatorDataForProduct.ozon = calculator;
                if (ozonResult.error || ozonResult.missingData) {
                  const errorMsg = ozonResult.error || `Недостаточно данных: ${(ozonResult.missingData || []).join(', ')}`;
                  setPriceErrors(prev => ({ ...prev, [productKey]: { ...prev[productKey], ozon: errorMsg } }));
                  prices.ozon = null;
                } else {
                  const minProfit = (product.minPrice != null && product.minPrice !== '' && !isNaN(Number(product.minPrice)))
                    ? Number(product.minPrice) : null;
                  prices.ozon = minProfit != null ? calculateMinPrice(basePriceNum, calculator, 'ozon', minProfit, product) : null;
                }
              } else if (ozonResult?.error) {
                prices.ozon = null;
              } else {
                prices.ozon = null;
              }
            } catch (err) {
              console.error(`[Prices] Error calculating Ozon price for ${skuOzon}:`, err);
              prices.ozon = null;
              const msg = err.response?.data?.message || err.message || 'Ошибка запроса к API';
              setPriceErrors(prev => ({ ...prev, [productKey]: { ...prev[productKey], ozon: msg } }));
            }
          }

          // Расчет цены для WB
          if (skuWb) {
            try {
              const mapping = categoryMappings.find(m => m.marketplace === 'wb' || m.marketplace === 'wildberries');
              let categoryId = mapping?.category_id ?? null;
              
              // Fallback: если маппинг не найден, пробуем использовать category_id из товара
              // (для WB category_id должен быть subjectID из wb_commissions)
              if (!categoryId && product.category_id) {
                console.log(`[Prices] No WB mapping found, trying product.category_id as fallback: ${product.category_id}`);
                categoryId = product.category_id;
              }
              
              console.log(`[Prices] WB price calculation for ${skuWb}:`, {
                productId: product.id,
                productSku: product.sku,
                skuWb: skuWb,
                hasMapping: !!mapping,
                categoryId: categoryId,
                productCategoryId: product.category_id,
                allMappings: categoryMappings
              });
              
              if (!categoryId && !product.user_category_id) {
                console.warn(`[Prices] ⚠ WARNING: No category_id and no user_category_id for WB product ${skuWb}`);
                setPriceErrors(prev => ({
                  ...prev,
                  [productKey]: {
                    ...prev[productKey],
                    wb: `Категория не указана для товара ${product.sku || product.name || skuWb}. Пожалуйста, настройте маппинг категории WB для этого товара в разделе "Категории".`
                  }
                }));
              }
              
              const rawWb = await pricesApi.getWBPrice(
                skuWb,
                categoryId,
                wbWarehouseName,
                !categoryId && product.user_category_id ? product.user_category_id : null
              );
              const wbResult = getPriceResult(rawWb);
              
              if (wbResult?.found && wbResult?.calculator) {
                const calculator = wbResult.calculator;
                calculatorDataForProduct.wb = calculator;
                const minProfit = (product.minPrice != null && product.minPrice !== '' && !isNaN(Number(product.minPrice)))
                  ? Number(product.minPrice) : null;
                prices.wb = minProfit != null ? calculateMinPrice(basePriceNum, calculator, 'wb', minProfit, product, wbAcquiringPercent, wbGemServicesPercent) : null;
                
                // Очищаем ошибку при успешном расчёте (в т.ч. когда WB-категория взята из user_category.marketplace_mappings)
                setPriceErrors(prev => {
                  const newErrors = { ...prev };
                  if (newErrors[productKey]?.wb) {
                    delete newErrors[productKey].wb;
                    if (Object.keys(newErrors[productKey]).length === 0) {
                      delete newErrors[productKey];
                    }
                  }
                  return newErrors;
                });
              } else if (wbResult?.error) {
                prices.wb = null;
                calculatorDataForProduct.wb = { error: wbResult.error };
                // Обновляем ошибку, если сервер вернул более конкретную ошибку
                setPriceErrors(prev => ({
                  ...prev,
                  [productKey]: {
                    ...prev[productKey],
                    wb: wbResult.error
                  }
                }));
              } else {
                prices.wb = null;
              }
            } catch (err) {
              console.error(`[Prices] Error calculating WB price for ${skuWb}:`, err);
              prices.wb = null;
              const msg = err.response?.data?.message || err.response?.data?.error || err.message || 'Ошибка запроса к API WB';
              setPriceErrors(prev => ({ ...prev, [productKey]: { ...prev[productKey], wb: msg } }));
              calculatorDataForProduct.wb = { error: msg };
            }
          }

          // Расчет цены для YM
          if (skuYm) {
            try {
              const ymMapping = categoryMappings.find(m => m.marketplace === 'ym' || m.marketplace === 'yandex');
              const ymCategoryId = ymMapping?.category_id ?? null;
              const rawYm = await pricesApi.getYMPrice(
                skuYm,
                ymCategoryId,
                !ymCategoryId && product.user_category_id ? product.user_category_id : null
              );
              const ymResult = getPriceResult(rawYm);
              if (ymResult?.found && ymResult?.calculator) {
                const calculator = ymResult.calculator;
                calculatorDataForProduct.ym = calculator;
                const minProfit = (product.minPrice != null && product.minPrice !== '' && !isNaN(Number(product.minPrice)))
                  ? Number(product.minPrice) : null;
                prices.ym = minProfit != null ? calculateMinPrice(basePriceNum, calculator, 'ym', minProfit, product) : null;
              } else if (ymResult?.error) {
                prices.ym = null;
                calculatorDataForProduct.ym = { error: ymResult.error };
                setPriceErrors(prev => ({
                  ...prev,
                  [productKey]: { ...prev[productKey], ym: ymResult.error }
                }));
              } else {
                prices.ym = null;
              }
            } catch (err) {
              console.error(`[Prices] Error calculating YM price for ${skuYm}:`, err);
              prices.ym = null;
              const msg = err.response?.data?.message || err.message || 'Ошибка запроса к API';
              setPriceErrors(prev => ({ ...prev, [productKey]: { ...prev[productKey], ym: msg } }));
            }
          }

          // Только фактический расчёт по API; ориентировочных цен больше нет
          const estimated = { ozon: false, wb: false, ym: false };

          if (Object.keys(prices).length > 0) {
            newCalculatedPrices[productKey] = { ...prices, _estimated: estimated };
            setCalculatorData(prev => ({
              ...prev,
              [productKey]: calculatorDataForProduct
            }));
            const productId = product.id ?? product.sku;
            if (productId != null) {
              const hasDetails = (obj) => obj && typeof obj === 'object' && !obj.error && (obj.commissions != null || obj.logistics_cost != null);
              pricesListForSave.push({
                productId,
                ozon: prices.ozon ?? undefined,
                wb: prices.wb ?? undefined,
                ym: prices.ym ?? undefined,
                ozonDetails: hasDetails(calculatorDataForProduct.ozon) ? calculatorDataForProduct.ozon : undefined,
                wbDetails: hasDetails(calculatorDataForProduct.wb) ? calculatorDataForProduct.wb : undefined,
                ymDetails: hasDetails(calculatorDataForProduct.ym) ? calculatorDataForProduct.ym : undefined
              });
            }
          }
        } catch (err) {
          console.error(`[Prices] Error calculating prices for product ${productKey}:`, err);
        } finally {
          delete newLoadingPrices[productKey];
        }
      }

      console.log(`[Prices] Calculation complete. Calculated prices for ${Object.keys(newCalculatedPrices).length} products`);
      setCalculatedPrices(newCalculatedPrices);
      setLoadingPrices({});
      return pricesListForSave;
    };
    return await calculatePricesForProducts();
  };

  /** Пересчитать минимальные цены только для одного товара — тот же поток, что и «Пересчитать и сохранить все»: расчёт по API и saveBulk. */
  const handleRecalcOne = async (productId) => {
    if (!productId) return;
    const product = products.find((p) => p.id == productId || String(p?.id) === String(productId));
    if (!product) {
      setRecalcAllMessage('Товар не найден в списке. Обновите страницу.');
      setTimeout(() => setRecalcAllMessage(null), 3000);
      return;
    }
    const productKey = String(product.id ?? product.sku ?? '');
    if (!productKey) return;

    try {
      setRecalcOneProductId(productId);
      setRecalcAllMessage(null);

      const costBaseNum = Number(product.cost ?? product.price ?? product.base_price ?? 0) || 0;
      const additionalExpensesNum = Number(product.additionalExpenses ?? product.additional_expenses ?? 0) || 0;
      const basePriceNum = costBaseNum + additionalExpensesNum;
      if (basePriceNum <= 0) {
        setRecalcAllMessage('У товара не указана себестоимость. Укажите себестоимость для расчёта минимальных цен.');
        setTimeout(() => setRecalcAllMessage(null), 4000);
        return;
      }

      let categoryMappings = [];
      if (product.id) {
        try {
          const mappingsResponse = await categoryMappingsApi.getByProduct(product.id);
          const data = mappingsResponse?.data !== undefined ? mappingsResponse.data : mappingsResponse;
          if (Array.isArray(data)) categoryMappings = data;
          else if (data?.ok && Array.isArray(data.data)) categoryMappings = data.data;
          else if (data?.data && Array.isArray(data.data)) categoryMappings = data.data;
          else {
            const found = data && typeof data === 'object' ? Object.values(data).find((v) => Array.isArray(v)) : null;
            categoryMappings = found || [];
          }
        } catch (_) {
          // продолжаем без маппингов
        }
      }

      const prices = {};
      const calculatorDataForProduct = {};
      const skuOzon = product.sku_ozon || product.ozon_sku || (product.product_skus && product.product_skus.ozon);
      const skuWb = product.sku_wb || product.wb_sku || (product.product_skus && product.product_skus.wb);
      const skuYm = product.sku_ym || product.ym_sku || (product.product_skus && product.product_skus.ym) || product.sku;
      const minProfit = (product.minPrice != null && product.minPrice !== '' && !isNaN(Number(product.minPrice))) ? Number(product.minPrice) : null;

      if (skuOzon) {
        try {
          const rawOzon = await pricesApi.getOzonPrice(skuOzon);
          const ozonResult = getPriceResult(rawOzon);
          if (ozonResult?.found && ozonResult?.calculator && !ozonResult.error && !ozonResult.missingData) {
            calculatorDataForProduct.ozon = ozonResult.calculator;
            prices.ozon = minProfit != null ? calculateMinPrice(basePriceNum, ozonResult.calculator, 'ozon', minProfit, product) : null;
          }
        } catch (err) {
          setPriceErrors((prev) => ({ ...prev, [productKey]: { ...prev[productKey], ozon: err.response?.data?.message || err.message } }));
        }
      }

      if (skuWb) {
        try {
          const mapping = categoryMappings.find((m) => m.marketplace === 'wb' || m.marketplace === 'wildberries');
          let categoryId = mapping?.category_id ?? null;
          if (!categoryId && product.category_id) categoryId = product.category_id;
          if (!categoryId && !product.user_category_id) {
            setPriceErrors((prev) => ({
              ...prev,
              [productKey]: {
                ...prev[productKey],
                wb: 'Категория WB не указана. Настройте маппинг категории в разделе «Категории».'
              }
            }));
          } else {
            const rawWb = await pricesApi.getWBPrice(
              skuWb,
              categoryId,
              wbWarehouseName,
              !categoryId && product.user_category_id ? product.user_category_id : null
            );
            const wbResult = getPriceResult(rawWb);
            if (wbResult?.found && wbResult?.calculator) {
              calculatorDataForProduct.wb = wbResult.calculator;
              prices.wb = minProfit != null ? calculateMinPrice(basePriceNum, wbResult.calculator, 'wb', minProfit, product, wbAcquiringPercent, wbGemServicesPercent) : null;
              setPriceErrors((prev) => {
                const next = { ...prev, [productKey]: { ...(prev[productKey] || {}) } };
                delete next[productKey].wb;
                if (Object.keys(next[productKey]).length === 0) delete next[productKey];
                return next;
              });
            } else if (wbResult?.error) {
              setPriceErrors((prev) => ({ ...prev, [productKey]: { ...prev[productKey], wb: wbResult.error } }));
            }
          }
        } catch (err) {
          setPriceErrors((prev) => ({ ...prev, [productKey]: { ...prev[productKey], wb: err.response?.data?.message || err.response?.data?.error || err.message } }));
        }
      }

      if (skuYm) {
        try {
          const ymMapping = categoryMappings.find((m) => m.marketplace === 'ym' || m.marketplace === 'yandex');
          const ymCategoryId = ymMapping?.category_id ?? null;
          const rawYm = await pricesApi.getYMPrice(skuYm, ymCategoryId, !ymCategoryId && product.user_category_id ? product.user_category_id : null);
          const ymResult = getPriceResult(rawYm);
          if (ymResult?.found && ymResult?.calculator) {
            calculatorDataForProduct.ym = ymResult.calculator;
            prices.ym = minProfit != null ? calculateMinPrice(basePriceNum, ymResult.calculator, 'ym', minProfit, product) : null;
          } else if (ymResult?.error) {
            setPriceErrors((prev) => ({ ...prev, [productKey]: { ...prev[productKey], ym: ymResult.error } }));
          }
        } catch (err) {
          setPriceErrors((prev) => ({ ...prev, [productKey]: { ...prev[productKey], ym: err.response?.data?.message || err.message } }));
        }
      }

      const hasDetails = (obj) => obj && typeof obj === 'object' && !obj.error && (obj.commissions != null || obj.logistics_cost != null);
      const saveItem = {
        productId: product.id ?? product.sku,
        ozon: prices.ozon ?? undefined,
        wb: prices.wb ?? undefined,
        ym: prices.ym ?? undefined,
        ozonDetails: hasDetails(calculatorDataForProduct.ozon) ? calculatorDataForProduct.ozon : undefined,
        wbDetails: hasDetails(calculatorDataForProduct.wb) ? calculatorDataForProduct.wb : undefined,
        ymDetails: hasDetails(calculatorDataForProduct.ym) ? calculatorDataForProduct.ym : undefined
      };
      await pricesApi.saveBulk([saveItem]);

      setCalculatedPrices((prev) => ({ ...prev, [productKey]: { ...prices, _estimated: { ozon: false, wb: false, ym: false } } }));
      setCalculatorData((prev) => ({ ...prev, [productKey]: calculatorDataForProduct }));

      await loadProducts();
      setRecalcAllMessage('Цены для товара пересчитаны и сохранены.');
      setTimeout(() => setRecalcAllMessage(null), 3000);
    } catch (err) {
      console.error('[Prices] recalc one failed:', err);
      setRecalcAllMessage('Ошибка пересчёта: ' + (err.response?.data?.message || err.message));
    } finally {
      setRecalcOneProductId(null);
    }
  };

  /** Пересчитать цены по API для всех товаров, сохранить в БД и обновить список. */
  const handleRecalcAndSave = async () => {
    try {
      setRecalcAllLoading(true);
      setRecalcAllMessage(null);
      setCalculatedPrices({});
      setLoadingPrices({});
      const pricesList = await runFullPriceCalculation();
      if (pricesList.length > 0) {
        await pricesApi.saveBulk(pricesList);
        await loadProducts();
        setRecalcAllMessage(`Сохранено минимальных цен для ${pricesList.length} товаров.`);
      } else {
        setRecalcAllMessage('Нет рассчитанных цен для сохранения. Проверьте себестоимость и маппинги категорий.');
      }
      setTimeout(() => setRecalcAllMessage(null), 10000);
    } catch (err) {
      console.error('[Prices] recalc and save failed:', err);
      const status = err.response?.status;
      const msg = status === 404
        ? 'Эндпоинт сохранения цен не найден (404). Перезапустите сервер (backend) и попробуйте снова.'
        : (err.response?.data?.message || err.message);
      setRecalcAllMessage('Ошибка: ' + msg);
    } finally {
      setRecalcAllLoading(false);
    }
  };

  if (loading) {
    return <div className="loading">Загрузка цен...</div>;
  }

  if (error) {
    return <div className="error">Ошибка: {error}</div>;
  }

  return (
    <div className="card">
      <h1 className="title">💰 Цены</h1>
      <p className="subtitle">Управление ценами товаров на маркетплейсах</p>

      {/* Вкладки: Цены | Акции */}
      <div style={{ display: 'flex', gap: '4px', marginBottom: '20px', borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
        <button
          type="button"
          onClick={() => setActiveSection('prices')}
          style={{
            padding: '10px 16px',
            background: activeSection === 'prices' ? 'rgba(0,91,255,0.2)' : 'transparent',
            border: 'none',
            borderBottom: activeSection === 'prices' ? '2px solid #005bff' : '2px solid transparent',
            color: activeSection === 'prices' ? '#fff' : 'var(--muted)',
            cursor: 'pointer',
            fontSize: '14px',
            fontWeight: 500
          }}
        >
          Цены
        </button>
        <button
          type="button"
          onClick={() => setActiveSection('promotions')}
          style={{
            padding: '10px 16px',
            background: activeSection === 'promotions' ? 'rgba(0,91,255,0.2)' : 'transparent',
            border: 'none',
            borderBottom: activeSection === 'promotions' ? '2px solid #005bff' : '2px solid transparent',
            color: activeSection === 'promotions' ? '#fff' : 'var(--muted)',
            cursor: 'pointer',
            fontSize: '14px',
            fontWeight: 500
          }}
        >
          Акции
        </button>
      </div>

      {activeSection === 'promotions' && (
        <>
          {/* Вкладки маркетплейсов внутри Акций */}
          <div style={{ display: 'flex', gap: '4px', marginBottom: '16px' }}>
            {[
              { key: 'ozon', label: 'Ozon' },
              { key: 'wb', label: 'Wildberries' },
              { key: 'ym', label: 'Яндекс.Маркет' }
            ].map(({ key, label }) => (
              <button
                key={key}
                type="button"
                onClick={() => setActivePromoMarketplace(key)}
                style={{
                  padding: '8px 14px',
                  background: activePromoMarketplace === key ? 'rgba(255,255,255,0.1)' : 'transparent',
                  border: '1px solid rgba(255,255,255,0.2)',
                  borderRadius: '6px',
                  color: activePromoMarketplace === key ? '#fff' : 'var(--muted)',
                  cursor: 'pointer',
                  fontSize: '13px'
                }}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Контент вкладки Ozon */}
          {activePromoMarketplace === 'ozon' && (
            <div className="prices-table-container" style={{ marginTop: '16px' }}>
              {ozonActionsLoading ? (
                <p style={{ color: 'var(--muted)' }}>Загрузка акций...</p>
              ) : ozonActionsError ? (
                <p style={{ color: 'var(--danger, #ef4444)' }}>⚠️ {ozonActionsError}</p>
              ) : ozonActions.length === 0 ? (
                <p style={{ color: 'var(--muted)' }}>Акций нет</p>
              ) : (
                <table className="prices-table table">
                  <thead>
                    <tr>
                      <th>ID</th>
                      <th>Название</th>
                      <th>Тип</th>
                      <th>Начало</th>
                      <th>Окончание</th>
                      <th>Участвует товаров</th>
                      <th title="Количество товаров, которые могут участвовать в акции">Могут участвовать</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ozonActions.map((a) => (
                      <tr
                        key={a.id}
                        onClick={() => setActionModal({ isOpen: true, action: a })}
                        style={{ cursor: 'pointer' }}
                        title="Нажмите, чтобы открыть товары акции"
                      >
                        <td style={{ fontSize: '13px', color: 'var(--muted)' }}>{a.id}</td>
                        <td>{a.title || '—'}</td>
                        <td>{a.action_type || a.discount_type || '—'}</td>
                        <td style={{ fontSize: '13px' }}>
                          {a.date_start ? new Date(a.date_start).toLocaleDateString('ru-RU') : '—'}
                        </td>
                        <td style={{ fontSize: '13px' }}>
                          {a.date_end ? new Date(a.date_end).toLocaleDateString('ru-RU') : '—'}
                        </td>
                        <td style={{ textAlign: 'center' }}>{a.participating_products_count ?? a.potential_products_count ?? 0}</td>
                        <td style={{ textAlign: 'center' }}>{a.potential_products_count ?? 0}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {activePromoMarketplace === 'wb' && (
            <div className="prices-table-container" style={{ marginTop: '16px' }}>
              {wbActionsLoading ? (
                <p style={{ color: 'var(--muted)' }}>Загрузка акций WB...</p>
              ) : wbActionsError ? (
                <p style={{ color: 'var(--danger, #ef4444)' }}>⚠️ {wbActionsError}</p>
              ) : wbActions.length === 0 ? (
                <p style={{ color: 'var(--muted)' }}>Акций WB нет</p>
              ) : (
                <table className="prices-table table">
                  <thead>
                    <tr>
                      <th>ID</th>
                      <th>Название</th>
                      <th>Тип</th>
                      <th>Начало</th>
                      <th>Окончание</th>
                      <th title="Товаров в акции">В акции</th>
                      <th title="Товаров не в акции (могут участвовать)">Не в акции</th>
                      <th>% участия</th>
                    </tr>
                  </thead>
                  <tbody>
                    {wbActions.map((a) => (
                      <tr
                        key={a.id}
                        style={{ cursor: 'pointer' }}
                        onClick={() => setWbActionModal({ isOpen: true, promotion: a })}
                        title="Нажмите, чтобы открыть детали акции"
                      >
                        <td style={{ fontSize: '13px', color: 'var(--muted)' }}>{a.id}</td>
                        <td>{a.name || '—'}</td>
                        <td>{a.type || '—'}</td>
                        <td style={{ fontSize: '13px' }}>
                          {a.startDateTime ? new Date(a.startDateTime).toLocaleDateString('ru-RU') : '—'}
                        </td>
                        <td style={{ fontSize: '13px' }}>
                          {a.endDateTime ? new Date(a.endDateTime).toLocaleDateString('ru-RU') : '—'}
                        </td>
                        <td style={{ textAlign: 'center' }}>{a.inPromoActionTotal ?? a.inPromoActionLeftovers ?? '—'}</td>
                        <td style={{ textAlign: 'center' }}>{a.notInPromoActionTotal ?? a.notInPromoActionLeftovers ?? '—'}</td>
                        <td style={{ textAlign: 'center' }}>{a.participationPercentage != null ? `${a.participationPercentage}%` : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
          {activePromoMarketplace === 'ym' && (
            <p style={{ color: 'var(--muted)', marginTop: '24px' }}>Раздел акций Яндекс.Маркета — в разработке</p>
          )}
        </>
      )}

      {activeSection === 'prices' && (
      <>
      <div style={{marginBottom: '20px', padding: '10px', background: 'rgba(255,255,255,0.05)', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.1)'}}>
        <p style={{margin: 0, color: 'var(--muted)', fontSize: '14px'}}>
          💡 <strong>Подсказка:</strong> Наведите курсор на цену товара в таблице ниже, чтобы увидеть подробную информацию о товаре.
        </p>
      </div>
      {products.length > 0 && !products.some(p => (p.storedMinPriceOzon ?? p.stored_min_price_ozon) != null || (p.storedMinPriceWb ?? p.stored_min_price_wb) != null || (p.storedMinPriceYm ?? p.stored_min_price_ym) != null) && (
        <div style={{marginBottom: '16px', padding: '12px 16px', background: 'rgba(251, 191, 36, 0.12)', borderRadius: '8px', border: '1px solid rgba(251, 191, 36, 0.35)', color: '#d97706', fontSize: '14px'}}>
          📊 <strong>Сохранённые цены не загружены.</strong> Нажмите «Пересчитать все минимальные цены» ниже — после завершения обновите страницу, и цены будут отображаться при каждом обновлении.
        </div>
      )}

      <div style={{marginTop: '20px', width: '100%'}}>
        {products.length === 0 ? (
          <div className="empty-state">
            <p>Нет товаров для отображения</p>
            <p style={{fontSize: '13px', marginTop: '8px'}}>Добавьте товары в разделе "Товары"</p>
          </div>
        ) : (
          <div className="prices-table-container">
            <table className="prices-table table">
              <thead>
                <tr>
                  <th>Артикул</th>
                  <th style={{width: '25%'}}>Товар</th>
                  <th style={{textAlign: 'right'}}>Себестоимость</th>
                  <th style={{textAlign: 'center', background: 'rgba(0,91,255,0.1)'}}>Ozon</th>
                  <th style={{textAlign: 'center', background: 'rgba(203,17,171,0.1)'}}>WB</th>
                  <th style={{textAlign: 'center', background: 'rgba(255,204,0,0.1)'}}>Яндекс.Маркет</th>
                  <th style={{width: '100px', textAlign: 'center'}}>Действия</th>
                </tr>
              </thead>
              <tbody>
                {products.filter(Boolean).map(product => {
                  // basePrice используется для расчета минимальной цены (себестоимость товара)
                  // Берем себестоимость из product.cost (или price/base_price), и добавляем доп.расходы (additionalExpenses)
                  const costBaseNum = Number(product.cost ?? product.price ?? product.base_price ?? 0) || 0;
                  const additionalExpensesNum = Number(product.additionalExpenses ?? product.additional_expenses ?? 0) || 0;
                  const basePrice = costBaseNum + additionalExpensesNum;
                  const productCost = costBaseNum > 0 ? costBaseNum : null; // Отображаем отдельно, без суммы
                  const productKey = String(product.id ?? product.sku ?? '');
                  const raw = calculatedPrices[productKey] || {};
                  const storedOzon = product.storedMinPriceOzon ?? product.stored_min_price_ozon;
                  const storedWb = product.storedMinPriceWb ?? product.stored_min_price_wb;
                  const storedYm = product.storedMinPriceYm ?? product.stored_min_price_ym;
                  const prices = {
                    ozon: raw.ozon ?? storedOzon ?? null,
                    wb: raw.wb ?? storedWb ?? null,
                    ym: raw.ym ?? storedYm ?? null
                  };
                  const estimated = raw._estimated || {};
                  const isLoading = loadingPrices[productKey];
                  
                  const skuOzon = product.sku_ozon || product.ozon_sku || (product.product_skus && product.product_skus.ozon);
                  const skuWb = product.sku_wb || product.wb_sku || (product.product_skus && product.product_skus.wb);
                  const skuYm = product.sku_ym || product.ym_sku || (product.product_skus && product.product_skus.ym);
                  
                  return (
                    <tr key={product.id}>
                      <td style={{fontSize: '13px', color: 'var(--muted)', whiteSpace: 'nowrap'}}>
                        {product.sku || '—'}
                      </td>
                      <td style={{overflow: 'hidden', textOverflow: 'ellipsis'}}>
                        <div>{product.name || 'Без названия'}</div>
                        {product.volume && (
                          <div style={{fontSize: '11px', color: 'var(--muted)', marginTop: '2px'}}>
                            Объем: {parseFloat(product.volume).toFixed(2)} л
                          </div>
                        )}
                      </td>
                      <td style={{textAlign: 'right', fontWeight: 600, whiteSpace: 'nowrap'}}>
                        <div>
                          <div>
                            {productCost !== null ? (
                              <span style={{color: '#10b981'}}>{parseFloat(productCost).toFixed(2)} ₽</span>
                            ) : (
                              <span style={{color: 'var(--muted)', fontSize: '12px'}}>—</span>
                            )}
                          </div>
                          <div style={{fontSize: '11px', color: 'var(--muted)', marginTop: '2px', fontWeight: 400}}>
                            {additionalExpensesNum > 0 ? (
                              <span>{additionalExpensesNum.toFixed(2)} ₽ доп.</span>
                            ) : (
                              <span>— доп.</span>
                            )}
                          </div>
                        </div>
                      </td>
                      <td style={{textAlign: 'center', whiteSpace: 'nowrap'}}>
                        {isLoading ? (
                          <span style={{color: 'var(--muted)', fontSize: '12px'}}>...</span>
                        ) : prices.ozon ? (
                          <div
                            onClick={() => setPriceModal({
                              isOpen: true,
                              product: product,
                              marketplace: 'ozon',
                              price: prices.ozon,
                              calculatorData: calculatorData[productKey]?.ozon
                            })}
                            style={{cursor: 'pointer'}}
                            title="Нажмите для просмотра деталей расчета цены"
                          >
                            <div style={{fontSize: '14px', fontWeight: 600, color: '#0b91ff'}}>
                              {prices.ozon} ₽
                            </div>
                            <div style={{fontSize: '11px', color: 'var(--muted)', marginTop: '2px'}}>мин. цена</div>
                          </div>
                        ) : priceErrors[productKey]?.ozon ? (
                          <div
                            style={{cursor: 'help'}}
                            title={priceErrors[productKey].ozon}
                          >
                            <span style={{color: '#ef4444', fontSize: '12px'}}>⚠️ Ошибка</span>
                            <div style={{fontSize: '10px', color: 'var(--muted)', marginTop: '2px'}}>
                              Данных нет
                            </div>
                          </div>
                        ) : skuOzon ? (
                          <span className="mp-badge ozon" style={{opacity: 0.5}}>OZON</span>
                        ) : (
                          <span style={{color: 'var(--muted)', fontSize: '12px'}}>—</span>
                        )}
                      </td>
                      <td style={{textAlign: 'center', whiteSpace: 'nowrap'}}>
                        {isLoading ? (
                          <span style={{color: 'var(--muted)', fontSize: '12px'}}>...</span>
                        ) : prices.wb ? (
                          <div
                            onClick={() => setPriceModal({
                              isOpen: true,
                              product: product,
                              marketplace: 'wb',
                              price: prices.wb,
                              calculatorData: calculatorData[productKey]?.wb
                            })}
                            style={{cursor: 'pointer'}}
                            title="Нажмите для просмотра деталей расчета цены"
                          >
                            <div style={{fontSize: '14px', fontWeight: 600, color: '#cb11ab'}}>
                              {prices.wb} ₽
                            </div>
                            <div style={{fontSize: '11px', color: 'var(--muted)', marginTop: '2px'}}>мин. цена</div>
                          </div>
                        ) : priceErrors[productKey]?.wb ? (
                          <div
                            style={{cursor: 'help'}}
                            title={priceErrors[productKey].wb}
                          >
                            <span style={{color: '#ef4444', fontSize: '12px'}}>⚠️ Ошибка</span>
                            <div style={{fontSize: '10px', color: 'var(--muted)', marginTop: '2px', maxWidth: '240px'}}>
                              {priceErrors[productKey].wb.length > 85 
                                ? priceErrors[productKey].wb.substring(0, 85) + '…'
                                : priceErrors[productKey].wb}
                            </div>
                          </div>
                        ) : calculatorData[productKey]?.wb?.error ? (
                          <div
                            onClick={() => setPriceModal({
                              isOpen: true,
                              product: product,
                              marketplace: 'wb',
                              price: null,
                              calculatorData: calculatorData[productKey]?.wb
                            })}
                            style={{cursor: 'pointer'}}
                            title="Нажмите для просмотра ошибки"
                          >
                            <div style={{fontSize: '12px', color: '#ef4444', fontWeight: 500}}>
                              ⚠️ Ошибка
                            </div>
                            <div style={{fontSize: '10px', color: 'var(--muted)', marginTop: '2px'}}>
                              {calculatorData[productKey]?.wb?.error || 'Данных нет'}
                            </div>
                          </div>
                        ) : skuWb ? (
                          <span className="mp-badge wb" style={{opacity: 0.5}}>WB</span>
                        ) : (
                          <span style={{color: 'var(--muted)', fontSize: '12px'}}>—</span>
                        )}
                      </td>
                      <td style={{textAlign: 'center', whiteSpace: 'nowrap'}}>
                        {isLoading ? (
                          <span style={{color: 'var(--muted)', fontSize: '12px'}}>...</span>
                        ) : prices.ym ? (
                          <div
                            onClick={() => setPriceModal({
                              isOpen: true,
                              product: product,
                              marketplace: 'ym',
                              price: prices.ym,
                              calculatorData: calculatorData[productKey]?.ym
                            })}
                            style={{cursor: 'pointer'}}
                            title="Нажмите для просмотра деталей расчета цены"
                          >
                            <div style={{fontSize: '14px', fontWeight: 600, color: '#ffcc00'}}>
                              {prices.ym} ₽
                            </div>
                            <div style={{fontSize: '11px', color: 'var(--muted)', marginTop: '2px'}}>мин. цена</div>
                          </div>
                        ) : skuYm ? (
                          <span className="mp-badge ym" style={{opacity: 0.5}}>YM</span>
                        ) : (
                          <span style={{color: 'var(--muted)', fontSize: '12px'}}>—</span>
                        )}
                      </td>
                      <td style={{textAlign: 'center', verticalAlign: 'middle'}}>
                        <Button
                          type="button"
                          variant="secondary"
                          size="small"
                          onClick={() => handleRecalcOne(product.id)}
                          disabled={recalcAllLoading || recalcOneProductId === product.id}
                          title="Пересчитать минимальные цены только для этого товара"
                        >
                          {recalcOneProductId === product.id ? '⏳' : '🔄'} Пересчитать
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="actions" style={{marginTop: '16px', display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center'}}>
        <Button variant="primary" onClick={handleRecalcAndSave} disabled={recalcAllLoading}>
          {recalcAllLoading ? '⏳ Пересчёт и сохранение...' : '📊 Пересчитать и сохранить все минимальные цены'}
        </Button>
        <div style={{marginTop: '8px', fontSize: '12px', color: 'var(--muted)', width: '100%', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px'}}>
          {recalcAllMessage && (
            <span style={{color: recalcAllMessage.startsWith('Ошибка') ? 'var(--danger, #ef4444)' : 'var(--primary)'}}>
              {recalcAllMessage.startsWith('Ошибка') ? '⚠️' : 'ℹ️'} {recalcAllMessage}
            </span>
          )}
          {Object.keys(loadingPrices).length > 0 && (
            <span>Расчет цен в процессе... ({Object.keys(loadingPrices).length} товаров)</span>
          )}
          {Object.keys(loadingPrices).length === 0 && Object.keys(calculatedPrices).length > 0 && !recalcAllMessage && (
            <span>✅ Рассчитано цен: {Object.keys(calculatedPrices).length} товаров</span>
          )}
        </div>
      </div>
      </>
      )}

      <PriceDetailsModal
        isOpen={priceModal.isOpen}
        onClose={() => setPriceModal({ isOpen: false, product: null, marketplace: null, price: null, calculatorData: null })}
        product={priceModal.product}
        marketplace={priceModal.marketplace}
        priceData={priceModal.price}
        calculatorData={(() => {
          const productKey = priceModal.product && (priceModal.product.id ?? priceModal.product.sku);
          const fromState = productKey ? calculatorData[productKey]?.[priceModal.marketplace] : null;
          const fromModal = priceModal.calculatorData;
          const fromStored = priceModal.product && priceModal.marketplace
            ? (priceModal.marketplace === 'ozon' ? priceModal.product.storedCalculationDetailsOzon : priceModal.marketplace === 'wb' ? priceModal.product.storedCalculationDetailsWb : priceModal.product.storedCalculationDetailsYm)
            : null;
          return fromState ?? fromModal ?? fromStored ?? null;
        })()}
        wbAcquiringPercent={wbAcquiringPercent}
        wbGemServicesPercent={wbGemServicesPercent}
      />

      {/* Модалка: товары акции Ozon — участвующие и доступные к акции */}
      <Modal
        isOpen={actionModal.isOpen}
        onClose={() => setActionModal({ isOpen: false, action: null })}
        title={actionModal.action ? `Акция: ${actionModal.action.title || actionModal.action.id}` : 'Акция'}
        size="large"
      >
        <div style={{ marginBottom: '12px', display: 'flex', gap: '8px', borderBottom: '1px solid var(--border)', paddingBottom: '8px' }}>
          <button
            type="button"
            onClick={() => setActionModalTab('participating')}
            style={{
              padding: '8px 14px',
              background: actionModalTab === 'participating' ? 'rgba(0,91,255,0.2)' : 'transparent',
              border: '1px solid rgba(255,255,255,0.2)',
              borderRadius: '6px',
              color: actionModalTab === 'participating' ? '#fff' : 'var(--muted)',
              cursor: 'pointer',
              fontSize: '13px'
            }}
          >
            Участвующие в акции
          </button>
          <button
            type="button"
            onClick={() => setActionModalTab('candidates')}
            style={{
              padding: '8px 14px',
              background: actionModalTab === 'candidates' ? 'rgba(0,91,255,0.2)' : 'transparent',
              border: '1px solid rgba(255,255,255,0.2)',
              borderRadius: '6px',
              color: actionModalTab === 'candidates' ? '#fff' : 'var(--muted)',
              cursor: 'pointer',
              fontSize: '13px'
            }}
          >
            Доступные к акции
          </button>
        </div>
        {actionModalTab === 'participating' && (
          <div className="prices-table-container">
            {actionProductsLoading ? (
              <p style={{ color: 'var(--muted)' }}>Загрузка...</p>
            ) : actionProductsError ? (
              <p style={{ color: 'var(--danger, #ef4444)' }}>⚠️ {actionProductsError}</p>
            ) : actionProducts.length === 0 ? (
              <p style={{ color: 'var(--muted)' }}>Нет товаров из нашей системы, участвующих в этой акции</p>
            ) : (
              <div style={{ overflowX: 'auto', maxWidth: '100%' }}>
                <table className="prices-table table">
                  <thead>
                    <tr>
                      <th>Наш товар</th>
                      <th>Артикул</th>
                      <th>ID Ozon</th>
                      <th title="Сохранённая минимальная цена для Ozon">Мин. цена (Ozon), ₽</th>
                      <th>Цена, ₽</th>
                      <th>Цена по акции, ₽</th>
                      <th title="Цена выше рекомендуемой">⚠ Превышена</th>
                      <th>Рек. цена акции, ₽</th>
                      <th>Макс. цена акции, ₽</th>
                      <th>Режим</th>
                      <th>Мин. остаток</th>
                      <th>Остаток</th>
                      <th>Бустинг, %</th>
                      <th>Цена мин. бустинга, ₽</th>
                      <th>Цена макс. бустинга, ₽</th>
                      <th>Мин. бустинг, %</th>
                      <th>Макс. бустинг, %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {actionProducts.map((p) => (
                      <tr key={p.id} style={p.alert_max_action_price_failed ? { backgroundColor: 'rgba(239,68,68,0.08)' } : undefined}>
                        <td style={{ maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis' }} title={p.our_product_name || ''}>{p.our_product_name || '—'}</td>
                        <td style={{ fontSize: '13px', color: 'var(--muted)' }}>{p.our_sku ?? p.offer_id ?? '—'}</td>
                        <td style={{ fontSize: '12px', color: 'var(--muted)' }}>{p.id}</td>
                        <td style={{ color: 'var(--primary)' }}>{p.min_price_ozon != null ? `${p.min_price_ozon} ₽` : '—'}</td>
                        <td>{p.price != null ? `${p.price} ₽` : '—'}</td>
                        <td>{p.action_price != null ? `${p.action_price} ₽` : '—'}</td>
                        <td title={p.alert_max_action_price_failed ? 'Цена выше рекомендуемой, товар может быть исключён' : ''}>{p.alert_max_action_price_failed ? '⚠ Да' : '—'}</td>
                        <td>{p.alert_max_action_price != null ? `${p.alert_max_action_price} ₽` : '—'}</td>
                        <td>{p.max_action_price != null ? `${p.max_action_price} ₽` : '—'}</td>
                        <td style={{ fontSize: '12px' }}>{p.add_mode || '—'}</td>
                        <td>{p.min_stock != null ? p.min_stock : '—'}</td>
                        <td>{p.stock != null ? p.stock : '—'}</td>
                        <td>{p.current_boost != null ? p.current_boost : '—'}</td>
                        <td>{p.price_min_elastic != null ? `${p.price_min_elastic} ₽` : '—'}</td>
                        <td>{p.price_max_elastic != null ? `${p.price_max_elastic} ₽` : '—'}</td>
                        <td>{p.min_boost != null ? p.min_boost : '—'}</td>
                        <td>{p.max_boost != null ? p.max_boost : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
        {actionModalTab === 'candidates' && (
          <div className="prices-table-container">
            {actionCandidatesLoading ? (
              <p style={{ color: 'var(--muted)' }}>Загрузка...</p>
            ) : actionCandidatesError ? (
              <p style={{ color: 'var(--danger, #ef4444)' }}>⚠️ {actionCandidatesError}</p>
            ) : actionCandidates.length === 0 ? (
              <p style={{ color: 'var(--muted)' }}>Нет товаров из нашей системы, доступных к добавлению в эту акцию</p>
            ) : (
              <div style={{ overflowX: 'auto', maxWidth: '100%' }}>
                <table className="prices-table table">
                  <thead>
                    <tr>
                      <th>Наш товар</th>
                      <th>Артикул</th>
                      <th>ID Ozon</th>
                      <th title="Сохранённая минимальная цена для Ozon">Мин. цена (Ozon), ₽</th>
                      <th>Цена, ₽</th>
                      <th>Цена по акции, ₽</th>
                      <th title="Цена выше рекомендуемой">⚠ Превышена</th>
                      <th>Рек. цена акции, ₽</th>
                      <th>Макс. цена акции, ₽</th>
                      <th>Режим</th>
                      <th>Мин. остаток</th>
                      <th>Остаток</th>
                      <th>Бустинг, %</th>
                      <th>Цена мин. бустинга, ₽</th>
                      <th>Цена макс. бустинга, ₽</th>
                      <th>Мин. бустинг, %</th>
                      <th>Макс. бустинг, %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {actionCandidates.map((p) => (
                      <tr key={p.id} style={p.alert_max_action_price_failed ? { backgroundColor: 'rgba(239,68,68,0.08)' } : undefined}>
                        <td style={{ maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis' }} title={p.our_product_name || ''}>{p.our_product_name || '—'}</td>
                        <td style={{ fontSize: '13px', color: 'var(--muted)' }}>{p.our_sku ?? p.offer_id ?? '—'}</td>
                        <td style={{ fontSize: '12px', color: 'var(--muted)' }}>{p.id}</td>
                        <td style={{ color: 'var(--primary)' }}>{p.min_price_ozon != null ? `${p.min_price_ozon} ₽` : '—'}</td>
                        <td>{p.price != null ? `${p.price} ₽` : '—'}</td>
                        <td>{p.action_price != null ? `${p.action_price} ₽` : '—'}</td>
                        <td title={p.alert_max_action_price_failed ? 'Цена выше рекомендуемой' : ''}>{p.alert_max_action_price_failed ? '⚠ Да' : '—'}</td>
                        <td>{p.alert_max_action_price != null ? `${p.alert_max_action_price} ₽` : '—'}</td>
                        <td>{p.max_action_price != null ? `${p.max_action_price} ₽` : '—'}</td>
                        <td style={{ fontSize: '12px' }}>{p.add_mode || '—'}</td>
                        <td>{p.min_stock != null ? p.min_stock : '—'}</td>
                        <td>{p.stock != null ? p.stock : '—'}</td>
                        <td>{p.current_boost != null ? p.current_boost : '—'}</td>
                        <td>{p.price_min_elastic != null ? `${p.price_min_elastic} ₽` : '—'}</td>
                        <td>{p.price_max_elastic != null ? `${p.price_max_elastic} ₽` : '—'}</td>
                        <td>{p.min_boost != null ? p.min_boost : '—'}</td>
                        <td>{p.max_boost != null ? p.max_boost : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* Модалка: детали акции WB + номенклатуры (участвующие / доступные) */}
      <Modal
        isOpen={wbActionModal.isOpen}
        onClose={() => setWbActionModal({ isOpen: false, promotion: null })}
        title={wbActionModal.promotion ? `Акция WB: ${wbActionModal.promotion.name || wbActionModal.promotion.id}` : 'Акция WB'}
        size="large"
      >
        <div style={{ marginBottom: '12px', display: 'flex', gap: '8px', borderBottom: '1px solid var(--border)', paddingBottom: '8px' }}>
          <button
            type="button"
            onClick={() => setWbActionModalTab('details')}
            style={{
              padding: '8px 14px',
              background: wbActionModalTab === 'details' ? 'rgba(203,17,171,0.2)' : 'transparent',
              border: '1px solid rgba(255,255,255,0.2)',
              borderRadius: '6px',
              color: wbActionModalTab === 'details' ? '#fff' : 'var(--muted)',
              cursor: 'pointer',
              fontSize: '13px'
            }}
          >
            Детали
          </button>
          <button
            type="button"
            onClick={() => setWbActionModalTab('participating')}
            style={{
              padding: '8px 14px',
              background: wbActionModalTab === 'participating' ? 'rgba(203,17,171,0.2)' : 'transparent',
              border: '1px solid rgba(255,255,255,0.2)',
              borderRadius: '6px',
              color: wbActionModalTab === 'participating' ? '#fff' : 'var(--muted)',
              cursor: 'pointer',
              fontSize: '13px'
            }}
          >
            Участвующие в акции
          </button>
          <button
            type="button"
            onClick={() => setWbActionModalTab('candidates')}
            style={{
              padding: '8px 14px',
              background: wbActionModalTab === 'candidates' ? 'rgba(203,17,171,0.2)' : 'transparent',
              border: '1px solid rgba(255,255,255,0.2)',
              borderRadius: '6px',
              color: wbActionModalTab === 'candidates' ? '#fff' : 'var(--muted)',
              cursor: 'pointer',
              fontSize: '13px'
            }}
          >
            Доступные к акции
          </button>
        </div>

        {wbActionModalTab === 'details' && (
          <>
            {wbActionDetailsLoading ? (
              <p style={{ color: 'var(--muted)' }}>Загрузка деталей акции...</p>
            ) : wbActionDetailsError ? (
              <p style={{ color: 'var(--danger, #ef4444)' }}>⚠️ {wbActionDetailsError}</p>
            ) : wbActionDetails ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                {wbActionDetails.description && (
                  <div>
                    <strong style={{ color: 'var(--muted)', fontSize: '12px', textTransform: 'uppercase' }}>Описание</strong>
                    <p style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap' }}>{wbActionDetails.description}</p>
                  </div>
                )}
                {Array.isArray(wbActionDetails.advantages) && wbActionDetails.advantages.length > 0 && (
                  <div>
                    <strong style={{ color: 'var(--muted)', fontSize: '12px', textTransform: 'uppercase' }}>Преимущества</strong>
                    <ul style={{ margin: '6px 0 0', paddingLeft: '20px' }}>
                      {wbActionDetails.advantages.map((adv, i) => (
                        <li key={i}>{adv}</li>
                      ))}
                    </ul>
                  </div>
                )}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '16px 24px' }}>
                  <div>
                    <span style={{ color: 'var(--muted)', fontSize: '12px' }}>Тип</span>
                    <div>{wbActionDetails.type || '—'}</div>
                  </div>
                  <div>
                    <span style={{ color: 'var(--muted)', fontSize: '12px' }}>Начало</span>
                    <div>{wbActionDetails.startDateTime ? new Date(wbActionDetails.startDateTime).toLocaleString('ru-RU') : '—'}</div>
                  </div>
                  <div>
                    <span style={{ color: 'var(--muted)', fontSize: '12px' }}>Окончание</span>
                    <div>{wbActionDetails.endDateTime ? new Date(wbActionDetails.endDateTime).toLocaleString('ru-RU') : '—'}</div>
                  </div>
                  <div>
                    <span style={{ color: 'var(--muted)', fontSize: '12px' }}>В акции (остаток / всего)</span>
                    <div>{wbActionDetails.inPromoActionLeftovers != null || wbActionDetails.inPromoActionTotal != null ? `${wbActionDetails.inPromoActionLeftovers ?? '—'} / ${wbActionDetails.inPromoActionTotal ?? '—'}` : '—'}</div>
                  </div>
                  <div>
                    <span style={{ color: 'var(--muted)', fontSize: '12px' }}>Не в акции (остаток / всего)</span>
                    <div>{wbActionDetails.notInPromoActionLeftovers != null || wbActionDetails.notInPromoActionTotal != null ? `${wbActionDetails.notInPromoActionLeftovers ?? '—'} / ${wbActionDetails.notInPromoActionTotal ?? '—'}` : '—'}</div>
                  </div>
                  <div>
                    <span style={{ color: 'var(--muted)', fontSize: '12px' }}>% участия</span>
                    <div>{wbActionDetails.participationPercentage != null ? `${wbActionDetails.participationPercentage}%` : '—'}</div>
                  </div>
                  {wbActionDetails.exceptionProductsCount != null && (
                    <div>
                      <span style={{ color: 'var(--muted)', fontSize: '12px' }}>Исключённых товаров</span>
                      <div>{wbActionDetails.exceptionProductsCount}</div>
                    </div>
                  )}
                </div>
                {Array.isArray(wbActionDetails.ranging) && wbActionDetails.ranging.length > 0 && (
                  <div>
                    <strong style={{ color: 'var(--muted)', fontSize: '12px', textTransform: 'uppercase' }}>Ранжирование</strong>
                    <div style={{ overflowX: 'auto', marginTop: '8px' }}>
                      <table className="prices-table table" style={{ minWidth: '280px' }}>
                        <thead>
                          <tr>
                            <th>Условие</th>
                            <th>% участия</th>
                            <th>Буст</th>
                          </tr>
                        </thead>
                        <tbody>
                          {wbActionDetails.ranging.map((r, i) => (
                            <tr key={i}>
                              <td>{r.condition || '—'}</td>
                              <td>{r.participationRate != null ? `${r.participationRate}%` : '—'}</td>
                              <td>{r.boost != null ? r.boost : '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <p style={{ color: 'var(--muted)' }}>Нет деталей по акции</p>
            )}
          </>
        )}

        {wbActionModalTab === 'participating' && (
          <div className="prices-table-container">
            {wbNomenclaturesInLoading ? (
              <p style={{ color: 'var(--muted)' }}>Загрузка товаров в акции...</p>
            ) : wbNomenclaturesInError ? (
              <p style={{ color: 'var(--danger, #ef4444)' }}>⚠️ {wbNomenclaturesInError}</p>
            ) : wbNomenclaturesIn.length === 0 ? (
              <p style={{ color: 'var(--muted)' }}>
                {wbNomenclaturesInNotApplicable
                  ? 'Для этой акции список товаров недоступен (например, авто-акция).'
                  : 'Нет товаров, участвующих в этой акции'}
              </p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table className="prices-table table">
                  <thead>
                    <tr>
                      <th>ID (nm)</th>
                      <th>В акции</th>
                      <th>Цена, ₽</th>
                      <th>Валюта</th>
                      <th>План. цена, ₽</th>
                      <th>Скидка, %</th>
                      <th>План. скидка, %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {wbNomenclaturesIn.map((n) => (
                      <tr key={n.id}>
                        <td style={{ fontSize: '13px', color: 'var(--muted)' }}>{n.id}</td>
                        <td>{n.inAction ? 'Да' : 'Нет'}</td>
                        <td>{n.price != null ? `${n.price}` : '—'}</td>
                        <td>{n.currencyCode || '—'}</td>
                        <td>{n.planPrice != null ? `${n.planPrice}` : '—'}</td>
                        <td>{n.discount != null ? `${n.discount}%` : '—'}</td>
                        <td>{n.planDiscount != null ? `${n.planDiscount}%` : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {wbActionModalTab === 'candidates' && (
          <div className="prices-table-container">
            {wbNomenclaturesOutLoading ? (
              <p style={{ color: 'var(--muted)' }}>Загрузка товаров, доступных к акции...</p>
            ) : wbNomenclaturesOutError ? (
              <p style={{ color: 'var(--danger, #ef4444)' }}>⚠️ {wbNomenclaturesOutError}</p>
            ) : wbNomenclaturesOut.length === 0 ? (
              <p style={{ color: 'var(--muted)' }}>
                {wbNomenclaturesOutNotApplicable
                  ? 'Для этой акции список товаров недоступен (например, авто-акция).'
                  : 'Нет товаров, доступных к добавлению в эту акцию'}
              </p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table className="prices-table table">
                  <thead>
                    <tr>
                      <th>ID (nm)</th>
                      <th>В акции</th>
                      <th>Цена, ₽</th>
                      <th>Валюта</th>
                      <th>План. цена, ₽</th>
                      <th>Скидка, %</th>
                      <th>План. скидка, %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {wbNomenclaturesOut.map((n) => (
                      <tr key={n.id}>
                        <td style={{ fontSize: '13px', color: 'var(--muted)' }}>{n.id}</td>
                        <td>{n.inAction ? 'Да' : 'Нет'}</td>
                        <td>{n.price != null ? `${n.price}` : '—'}</td>
                        <td>{n.currencyCode || '—'}</td>
                        <td>{n.planPrice != null ? `${n.planPrice}` : '—'}</td>
                        <td>{n.discount != null ? `${n.discount}%` : '—'}</td>
                        <td>{n.planDiscount != null ? `${n.planDiscount}%` : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}

