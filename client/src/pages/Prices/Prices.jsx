/**
 * Prices Page
 * Страница управления ценами товаров на маркетплейсах
 */

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useProducts } from '../../hooks/useProducts';
import { useCategories } from '../../hooks/useCategories';
import { useBrands } from '../../hooks/useBrands';
import { useOrganizations } from '../../hooks/useOrganizations';
import { useWarehouses } from '../../hooks/useWarehouses';
import { pricesApi } from '../../services/prices.api.js';
import { productsApi } from '../../services/products.api.js';
import { categoryMappingsApi } from '../../services/categoryMappings.api.js';
import { integrationsApi } from '../../services/integrations.api.js';
import { Button } from '../../components/common/Button/Button';
import { MarketplaceToggle } from '../../components/common/MarketplaceToggle/MarketplaceToggle.jsx';
import { PriceDetailsModal } from '../../components/PriceDetailsModal/PriceDetailsModal';
import { MarketplacePriceCells } from './MarketplacePriceCell.jsx';
import './Prices.css';
import '../Products/Products.css';
import { useProductCardModal } from '../../context/ProductCardModalContext.jsx';
import {
  FILTER_CATEGORY_NONE,
  fetchHasUncategorizedProducts,
} from '../../utils/uncategorizedCategoryFilter.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { isProfileKitsEnabled, isProfileFbsEnabled, isProfileFboEnabled } from '../../utils/profileFlags.js';
import { enrichOzonCalculatorFromProduct } from '../../utils/ozonBrandPromotion.js';
import { enrichCalculatorVolumeFromProduct, resolveEffectiveVolumeLiters, resolveProductVolumeLiters } from '../../utils/productVolume.js';
import { computeTaxesAndNetProfit, taxProfileForProduct } from '../../utils/organizationTaxRates.js';
import { getApiSessionContext } from '../../services/apiSession.js';
import { privateClientMinPrice } from '../../utils/marketplaceMinProfit.js';

const PRICES_LIST_PAGE_SIZES = [50, 100, 200];

/** Тумблеры фильтра связи с МП (как на странице товаров) */
const MP_LINK_FILTER_TOGGLES = [
  { code: 'ozon', label: 'OZ', name: 'Ozon', color: '#005bff' },
  { code: 'wb', label: 'WB', name: 'Wildberries', color: '#cb11ab' },
  { code: 'ym', label: 'ЯМ', name: 'Яндекс.Маркет', color: '#fc3f1d' },
];

// Нормализация ответа API: сервер возвращает { ok, data: result }, axios даёт response.data = этот объект
function getPriceResult(r) {
  if (r == null) return r;
  if (typeof r === 'object' && 'data' in r && r.data != null) return r.data;
  return r;
}

// Функция расчета минимальной цены на основе комиссий. Только фактические данные, без значений по умолчанию.
function calculateMinPrice(basePrice, calculator, marketplace, minProfit, product = null, wbAcquiringPercent = null, wbGemServicesPercent = null, taxProfile = null, ozonAcquiringPercent = null) {
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
  // WB: мин. цена по схеме FBO/FBW (paidStorageKgvp). Логистика уже в logistics_base/liter.
  const emptyCommission = { percent: 0, value: 0, delivery_amount: 0, return_amount: 0 };
  let commission;
  if (marketplace === 'wb') {
    const wbBase = commissions.FBO || commissions.FBS || emptyCommission;
    commission = { ...wbBase, delivery_amount: 0 };
  } else {
    commission = commissions.FBS || commissions.FBO || emptyCommission;
  }
  
  if (marketplace === 'wb') {
    console.log(`[calculateMinPrice] WB commission: FBO=${commissions.FBO?.percent}% FBS=${commissions.FBS?.percent}% → using ${commission.percent}% (FBO/FBW)`);
    if (commission.percent === 0) {
      console.error(`[calculateMinPrice] ✗ ERROR: Selected WB commission percent is 0!`);
    }
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
  } else if (marketplace === 'ozon' && ozonAcquiringPercent != null && ozonAcquiringPercent !== '') {
    acquiring = Number(ozonAcquiringPercent) || 0;
    console.log(`[calculateMinPrice] ✓ Ozon acquiring percent from settings: ${acquiring}%`);
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
  
  // Обработка заказа: Ozon — fbs_first_mile_min_amount; YM — SORTING; WB — нет
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
    const volume = resolveEffectiveVolumeLiters(calculator, product, marketplace) || 0;
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
  // Реклама (ДРР) — из Performance API / fallback настроек
  const adsPromotionPercent = (calculator.ads_promotion_percent != null && !isNaN(Number(calculator.ads_promotion_percent)))
    ? Number(calculator.ads_promotion_percent) / 100
    : 0;
  
  // Фиксированные расходы: для YM доставка (%) и приём платежа (0.12 ₽) учитываются в формуле/итерации
  const fixedExpenses = Number(processingCost) + Number(logisticsCost) + Number(deliveryToCustomer) + Number(returnCost) + Number(returnProcessingCost) + Number(returnLossCost) + (marketplace === 'ym' ? (ymAgencyFixed + ymPaymentTransferFixed) : 0);

  const targetProfitAfterTax = Number(minProfitNum);
  const profile = taxProfile || taxProfileForProduct(null, product);

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
    const adsPromotionAmount = priceNum * adsPromotionPercent;
    const gemServicesAmount = priceNum * gemServicesPercent;
    const deliveryAmountAtPrice = marketplace === 'ym' ? priceNum * ymDeliveryPercent : 0;
    const totalExpenses = Number(basePriceNum) + Number(fixedExpenses) + Number(commissionAmount) + Number(acquiringAmount) + Number(deliveryAmountAtPrice) + Number(brandPromotionAmount) + Number(adsPromotionAmount) + Number(gemServicesAmount);
    const { netProfit } = computeTaxesAndNetProfit({
      price: priceNum,
      totalExpenses,
      taxProfile: profile,
    });
    return Number(netProfit);
  };
  
  const denominator = 1 - marketplaceCommissionPercent - acquiringPercent - brandPromotionPercent - adsPromotionPercent - gemServicesPercent - (marketplace === 'ym' ? ymDeliveryPercent : 0);
  if (denominator <= 0) {
    console.warn('[calculateMinPrice] Invalid denominator (commission/acquiring/delivery data)');
    return null;
  }
  let recommendedPrice = Math.round((basePriceNum + fixedExpenses + targetProfitAfterTax) / denominator);
  
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
  const finalAdsPromotionAmount = Number(recommendedPriceNum * adsPromotionPercent);
  // Услуги Джем (только для WB, вычисляется от суммы товара)
  const finalGemServicesAmount = Number(recommendedPriceNum * gemServicesPercent);
  const finalTotalExpenses = Number(basePriceNum) + Number(fixedExpenses) + Number(finalCommissionAmount) + Number(finalAcquiringAmount) + Number(finalBrandPromotionAmount) + Number(finalAdsPromotionAmount) + Number(finalGemServicesAmount);
  const { vat: finalVat, incomeTax: finalTaxes, netProfit: finalNetProfit, profitBeforeIncomeTax: finalProfitBeforeTax } = computeTaxesAndNetProfit({
    price: recommendedPriceNum,
    totalExpenses: finalTotalExpenses,
    taxProfile: profile,
  });
  
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
    vat: Number(finalVat).toFixed(2),
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
  const { profile } = useAuth();
  const kitsEnabled = isProfileKitsEnabled(profile);
  const showFbsPrices = isProfileFbsEnabled(profile);
  const showFboPrices = isProfileFboEnabled(profile);
  const minColsPerMp = (showFbsPrices ? 1 : 0) + (showFboPrices ? 1 : 0) || 1;
  const mpColSpan = minColsPerMp; // только мин. цены (FBS/FBO)
  const { products, meta, loading, listRefreshing, error, loadProducts } = useProducts({ autoLoad: false });
  const { categories } = useCategories();
  const { brands } = useBrands();
  const { organizations } = useOrganizations();
  const { warehouses } = useWarehouses();
  const { openProductCardFromClick } = useProductCardModal();
  const [filterOrganizationId, setFilterOrganizationId] = useState('');
  const [filterBrandId, setFilterBrandId] = useState('');
  const [filterCategoryId, setFilterCategoryId] = useState('');
  const [filterProductType, setFilterProductType] = useState('');
  const [filterArchiveMode, setFilterArchiveMode] = useState('');
  /** Активные тумблеры: показать товары без связи с этими МП */
  const [filterUnlinkedMp, setFilterUnlinkedMp] = useState(() => new Set());
  /** Активные тумблеры: показать товары со связью с этими МП */
  const [filterLinkedMp, setFilterLinkedMp] = useState(() => new Set());
  const [showUncategorizedCategoryOption, setShowUncategorizedCategoryOption] = useState(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [listSearch, setListSearch] = useState('');
  const listSearchDebounceRef = useRef(null);
  const loadListRef = useRef(() => {});
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(() => {
    try {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem('pricesListPageSize') : null;
      const n = parseInt(raw, 10);
      return PRICES_LIST_PAGE_SIZES.includes(n) ? n : 50;
    } catch {
      return 50;
    }
  });
  const [calculatedPrices, setCalculatedPrices] = useState({});
  const [loadingPrices, setLoadingPrices] = useState({});
  const [calculatorData, setCalculatorData] = useState({});
  const [priceErrors, setPriceErrors] = useState({}); // Ошибки расчета цен
  const [priceModal, setPriceModal] = useState({ isOpen: false, product: null, marketplace: null, price: null, calculatorData: null });
  const [wbAcquiringPercent, setWbAcquiringPercent] = useState(null); // Процент эквайринга для WB из настроек
  const [ozonAcquiringPercent, setOzonAcquiringPercent] = useState(null); // Переопределение эквайринга Ozon из настроек
  const [wbGemServicesPercent, setWbGemServicesPercent] = useState(null); // Процент услуг Джем для WB из настроек
  const [ymEarlyShipmentDiscountPp, setYmEarlyShipmentDiscountPp] = useState(null);  const [recalcAllLoading, setRecalcAllLoading] = useState(false); // Загрузка пересчёта всех цен
  const [recalcAllMessage, setRecalcAllMessage] = useState(null); // Сообщение после запуска фонового пересчёта
  const [recalcOneProductId, setRecalcOneProductId] = useState(null); // ID товара, для которого идёт пересчёт
  const [pushAllLoading, setPushAllLoading] = useState(false);
  const [pushOneProductId, setPushOneProductId] = useState(null);

  // Получаем wbWarehouseName из основного склада (type = 'warehouse' с указанным wbWarehouseName)
  const mainWarehouse = warehouses.find(w => w.type === 'warehouse' && w.wbWarehouseName);
  const wbWarehouseName = mainWarehouse?.wbWarehouseName || null;

  const visibleProducts = useMemo(() => products.filter(Boolean), [products]);

  const loadList = (partial = {}) => {
    const org = partial.organizationId !== undefined ? partial.organizationId : filterOrganizationId;
    const brand = partial.brandId !== undefined ? partial.brandId : filterBrandId;
    const cat = partial.categoryId !== undefined ? partial.categoryId : filterCategoryId;
    const pt = partial.productType !== undefined ? partial.productType : filterProductType;
    const archiveMode =
      partial.archiveMode !== undefined ? partial.archiveMode : filterArchiveMode;
    const unlinked =
      partial.unlinkedMp !== undefined ? partial.unlinkedMp : filterUnlinkedMp;
    const linked =
      partial.linkedMp !== undefined ? partial.linkedMp : filterLinkedMp;
    const searchRaw = partial.search !== undefined ? partial.search : listSearch;
    const page = partial.page !== undefined ? partial.page : currentPage;
    const search = typeof searchRaw === 'string' ? searchRaw.trim() : '';
    const ptTrim = typeof pt === 'string' ? pt.trim() : '';
    const limitCandidate = partial.limit !== undefined ? Number(partial.limit) : pageSize;
    const limit = PRICES_LIST_PAGE_SIZES.includes(limitCandidate) ? limitCandidate : 50;
    const unlinkedArr = unlinked instanceof Set
      ? [...unlinked]
      : Array.isArray(unlinked)
        ? unlinked
        : [];
    const linkedArr = linked instanceof Set
      ? [...linked]
      : Array.isArray(linked)
        ? linked
        : [];
    return loadProducts({
      organizationId: org || undefined,
      brandId: brand || undefined,
      categoryId: cat || undefined,
      productType: ptTrim || undefined,
      search: search || undefined,
      includeArchived: archiveMode === 'include' || archiveMode === 'only',
      archivedOnly: archiveMode === 'only',
      unlinkedMp: unlinkedArr.length ? unlinkedArr : undefined,
      linkedMp: linkedArr.length ? linkedArr : undefined,
      limit,
      offset: Math.max(0, (page - 1) * limit),
      silent: true,
    });
  };

  loadListRef.current = loadList;

  const activeFiltersCount =
    (filterOrganizationId ? 1 : 0) +
    (filterBrandId ? 1 : 0) +
    (filterCategoryId ? 1 : 0) +
    (filterProductType ? 1 : 0) +
    (filterArchiveMode ? 1 : 0) +
    filterUnlinkedMp.size +
    filterLinkedMp.size;
  const totalProducts = Number.isFinite(Number(meta?.total)) ? Number(meta.total) : visibleProducts.length;
  const totalPages = Math.max(1, Math.ceil(Math.max(0, totalProducts) / Math.max(1, pageSize)));

  const clearListFilters = () => {
    setCurrentPage(1);
    setFilterOrganizationId('');
    setFilterBrandId('');
    setFilterCategoryId('');
    setFilterProductType('');
    setFilterArchiveMode('');
    setFilterUnlinkedMp(new Set());
    setFilterLinkedMp(new Set());
    loadList({
      organizationId: '',
      brandId: '',
      categoryId: '',
      productType: '',
      archiveMode: '',
      unlinkedMp: [],
      linkedMp: [],
      page: 1,
    });
  };

  const toggleUnlinkedMpFilter = (mpCode) => {
    setCurrentPage(1);
    const nextUnlinked = new Set(filterUnlinkedMp);
    if (nextUnlinked.has(mpCode)) nextUnlinked.delete(mpCode);
    else nextUnlinked.add(mpCode);
    const nextLinked = new Set(filterLinkedMp);
    if (nextUnlinked.has(mpCode)) nextLinked.delete(mpCode);
    setFilterUnlinkedMp(nextUnlinked);
    setFilterLinkedMp(nextLinked);
    loadListRef.current({ unlinkedMp: nextUnlinked, linkedMp: nextLinked, page: 1 });
  };

  const toggleLinkedMpFilter = (mpCode) => {
    setCurrentPage(1);
    const nextLinked = new Set(filterLinkedMp);
    if (nextLinked.has(mpCode)) nextLinked.delete(mpCode);
    else nextLinked.add(mpCode);
    const nextUnlinked = new Set(filterUnlinkedMp);
    if (nextLinked.has(mpCode)) nextUnlinked.delete(mpCode);
    setFilterLinkedMp(nextLinked);
    setFilterUnlinkedMp(nextUnlinked);
    loadListRef.current({ unlinkedMp: nextUnlinked, linkedMp: nextLinked, page: 1 });
  };

  const handleListSearchChange = (e) => {
    const v = e.target.value;
    setListSearch(v);
    if (listSearchDebounceRef.current) clearTimeout(listSearchDebounceRef.current);
    listSearchDebounceRef.current = setTimeout(() => {
      setCurrentPage(1);
      loadListRef.current({ search: v, page: 1 });
    }, 400);
  };

  const handleFilterOrganizationChange = (e) => {
    const v = e.target.value;
    setCurrentPage(1);
    setFilterOrganizationId(v);
    loadList({ organizationId: v, page: 1 });
  };

  const handleFilterCategoryChange = (e) => {
    const v = e.target.value;
    setCurrentPage(1);
    setFilterCategoryId(v);
    loadList({ categoryId: v, page: 1 });
  };

  const handleFilterProductTypeChange = (e) => {
    const v = e.target.value;
    setCurrentPage(1);
    setFilterProductType(v);
    loadList({ productType: v, page: 1 });
  };

  const handleFilterArchiveModeChange = (e) => {
    const v = e.target.value;
    setCurrentPage(1);
    setFilterArchiveMode(v);
    loadList({ archiveMode: v, page: 1 });
  };

  const handleFilterBrandChange = (e) => {
    const v = e.target.value;
    setCurrentPage(1);
    setFilterBrandId(v);
    loadList({ brandId: v, page: 1 });
  };

  const handlePageSizeChange = (e) => {
    const next = parseInt(e.target.value, 10);
    if (!PRICES_LIST_PAGE_SIZES.includes(next)) return;
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem('pricesListPageSize', String(next));
    } catch {
      /* ignore */
    }
    setPageSize(next);
    setCurrentPage(1);
    loadListRef.current({ page: 1, limit: next });
  };

  const goToPage = (page) => {
    const next = Math.min(Math.max(1, page), totalPages);
    setCurrentPage(next);
    loadListRef.current({ page: next });
  };

  const showNoneCategoryOption = showUncategorizedCategoryOption === true;

  useEffect(() => {
    return () => {
      if (listSearchDebounceRef.current) clearTimeout(listSearchDebounceRef.current);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const delay = typeof listSearch === 'string' && listSearch.trim() !== '' ? 400 : 0;
    const t = setTimeout(async () => {
      try {
        const searchTrim = typeof listSearch === 'string' ? listSearch.trim() : '';
        const ptTrim = typeof filterProductType === 'string' ? filterProductType.trim() : '';
        const has = await fetchHasUncategorizedProducts({
          organizationId: filterOrganizationId || undefined,
          brandId: filterBrandId || undefined,
          productType: ptTrim || undefined,
          search: searchTrim || undefined,
        });
        if (cancelled) return;
        setShowUncategorizedCategoryOption(has);
      } catch {
        if (!cancelled) setShowUncategorizedCategoryOption(false);
      }
    }, delay);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [filterOrganizationId, filterBrandId, filterProductType, listSearch]);

  useEffect(() => {
    if (showUncategorizedCategoryOption === false && filterCategoryId === FILTER_CATEGORY_NONE) {
      setFilterCategoryId('');
      setCurrentPage(1);
      loadListRef.current({ categoryId: '', page: 1 });
    }
  }, [showUncategorizedCategoryOption, filterCategoryId]);

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [currentPage, totalPages, pageSize]);

  useEffect(() => {
    loadList({ page: currentPage, silent: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- начальная загрузка
  }, []);

  const renderPricesListPager = (placement) => {
    const idSuffix = placement === 'top' ? 'top' : 'bottom';
    return (
      <div
        className={`d-flex justify-content-between align-items-center px-3 py-2 flex-wrap gap-2 ${
          placement === 'top' ? 'border-bottom' : 'border-top'
        }`}
      >
        <div className="d-flex flex-wrap align-items-center gap-3 text-muted small">
          <span>
            Страница <strong>{currentPage}</strong> из <strong>{totalPages}</strong>
            {' · '}
            Показано <strong>{visibleProducts.length}</strong> из <strong>{totalProducts}</strong>
          </span>
          <label className="d-inline-flex align-items-center gap-2 mb-0" htmlFor={`prices-list-page-size-${idSuffix}`}>
            <span>На странице</span>
            <select
              id={`prices-list-page-size-${idSuffix}`}
              className="form-select form-select-sm"
              style={{ width: 'auto', minWidth: '4.5rem' }}
              value={pageSize}
              onChange={handlePageSizeChange}
              disabled={listRefreshing}
            >
              {PRICES_LIST_PAGE_SIZES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="d-flex gap-2">
          <Button
            variant="secondary"
            size="small"
            onClick={() => goToPage(currentPage - 1)}
            disabled={currentPage <= 1 || listRefreshing}
          >
            Назад
          </Button>
          <Button
            variant="secondary"
            size="small"
            onClick={() => goToPage(currentPage + 1)}
            disabled={currentPage >= totalPages || listRefreshing}
          >
            Вперёд
          </Button>
        </div>
      </div>
    );
  };

  // Загрузка настроек интеграций (эквайринг WB/Ozon, услуги Джем, скидка YM) — один раз при монтировании
  useEffect(() => {
    let cancelled = false;
    const loadMpSettings = async () => {
      try {
        const [wbRes, ozonRes, ymRes] = await Promise.all([
          integrationsApi.getMarketplace('wildberries'),
          integrationsApi.getMarketplace('ozon'),
          integrationsApi.getMarketplace('yandex'),
        ]);
        if (cancelled) return;
        const wbConfig = wbRes?.data || wbRes || {};
        const acquiringPercent = wbConfig.acquiring_percent;
        if (acquiringPercent !== undefined && acquiringPercent !== null && acquiringPercent !== '') {
          const percentValue = Number(acquiringPercent);
          setWbAcquiringPercent(!isNaN(percentValue) && isFinite(percentValue) ? percentValue : null);
        } else {
          setWbAcquiringPercent(null);
        }
        const gemServicesPercent = wbConfig.gem_services_percent;
        if (gemServicesPercent !== undefined && gemServicesPercent !== null && gemServicesPercent !== '') {
          const percentValue = Number(gemServicesPercent);
          setWbGemServicesPercent(!isNaN(percentValue) && isFinite(percentValue) ? percentValue : null);
        } else {
          setWbGemServicesPercent(null);
        }
        const ozonConfig = ozonRes?.data || ozonRes || {};
        const ozonAcq = ozonConfig.acquiring_percent;
        if (ozonAcq !== undefined && ozonAcq !== null && ozonAcq !== '') {
          const percentValue = Number(ozonAcq);
          setOzonAcquiringPercent(!isNaN(percentValue) && isFinite(percentValue) ? percentValue : null);
        } else {
          setOzonAcquiringPercent(null);
        }
        const ymConfig = ymRes?.data || ymRes || {};
        const earlyPp = ymConfig.early_shipment_discount_pp ?? ymConfig.earlyShipmentDiscountPp;
        if (earlyPp !== undefined && earlyPp !== null && earlyPp !== '') {
          const percentValue = Number(earlyPp);
          setYmEarlyShipmentDiscountPp(!isNaN(percentValue) && isFinite(percentValue) ? percentValue : null);
        } else {
          setYmEarlyShipmentDiscountPp(null);
        }
      } catch (err) {
        if (!cancelled) {
          console.error('[Prices] Error loading marketplace settings:', err);
          setWbAcquiringPercent(null);
          setWbGemServicesPercent(null);
          setOzonAcquiringPercent(null);
          setYmEarlyShipmentDiscountPp(null);
        }
      }
    };
    loadMpSettings();
    return () => { cancelled = true; };
  }, [filterOrganizationId]);

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

  /** Пересчитать минимальные цены для одного товара на сервере (Ozon, WB, YM с учётом профиля). */
  const handleRecalcOne = async (productId) => {
    if (!productId) return;
    const product = products.find((p) => String(p?.id) === String(productId));
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

      const res = await pricesApi.recalculateForProduct(productId);
      const payload = res?.data !== undefined ? res.data : res;
      const errors = payload?.errors && typeof payload.errors === 'object' ? payload.errors : {};
      const errParts = Object.entries(errors).filter(([, v]) => v);

      setPriceErrors((prev) => {
        const next = { ...prev };
        if (errParts.length) {
          next[productKey] = { ...(next[productKey] || {}), ...Object.fromEntries(errParts) };
        } else if (next[productKey]) {
          const cleared = { ...next[productKey] };
          delete cleared.ozon;
          delete cleared.wb;
          delete cleared.ym;
          if (Object.keys(cleared).length === 0) delete next[productKey];
          else next[productKey] = cleared;
        }
        return next;
      });

      await loadListRef.current();

      if (errParts.length) {
        const summary = errParts.map(([mp, msg]) => `${mp.toUpperCase()}: ${msg}`).join(' · ');
        setRecalcAllMessage(
          summary.length > 220 ? `Частично: ${summary.slice(0, 217)}…` : `Частично сохранено. ${summary}`
        );
      } else {
        setRecalcAllMessage('Цены для товара пересчитаны и сохранены.');
      }
      setTimeout(() => setRecalcAllMessage(null), 6000);
    } catch (err) {
      console.error('[Prices] recalc one failed:', err);
      setRecalcAllMessage('Ошибка пересчёта: ' + (err.response?.data?.message || err.message));
    } finally {
      setRecalcOneProductId(null);
    }
  };

  /** Пересчитать минимальные цены для всех товаров на сервере (фон), без сотен запросов из браузера. */
  const handleRecalcAndSave = async () => {
    try {
      setRecalcAllLoading(true);
      setRecalcAllMessage(null);
      const res = await pricesApi.recalculateAll();
      const msg =
        res?.message ||
        res?.data?.message ||
        'Пересчёт минимальных цен запущен в фоне. Обновите страницу через несколько минут.';
      setRecalcAllMessage(msg);
      setTimeout(() => setRecalcAllMessage(null), 15000);
    } catch (err) {
      console.error('[Prices] recalc and save failed:', err);
      const status = err.response?.status;
      const msg = status === 404
        ? 'Эндпоинт пересчёта не найден (404). Перезапустите сервер (backend) и попробуйте снова.'
        : (err.response?.data?.message || err.message);
      setRecalcAllMessage('Ошибка: ' + msg);
    } finally {
      setRecalcAllLoading(false);
    }
  };

  /** Отправить сохранённые мин. цены одного товара на маркетплейсы. */
  const handlePushOne = async (productId) => {
    if (!productId) return;
    try {
      setPushOneProductId(productId);
      setRecalcAllMessage(null);
      const res = await pricesApi.pushForProduct(productId);
      const msg = res?.message || 'Цены отправлены на маркетплейсы.';
      setRecalcAllMessage(msg);
      setTimeout(() => setRecalcAllMessage(null), 8000);
    } catch (err) {
      console.error('[Prices] push one failed:', err);
      setRecalcAllMessage('Ошибка: ' + (err.response?.data?.message || err.message));
      setTimeout(() => setRecalcAllMessage(null), 8000);
    } finally {
      setPushOneProductId(null);
    }
  };

  /** Отправить мин. цены на МП (фон). Если выбран фильтр организации — только она. */
  const handlePushAll = async () => {
    try {
      setPushAllLoading(true);
      setRecalcAllMessage(null);
      if (filterOrganizationId) {
        const org = organizations.find((o) => String(o.id) === String(filterOrganizationId));
        if (org && org.auto_push_marketplace_prices !== true) {
          setRecalcAllMessage(
            'Ошибка: у выбранной организации выключена «Автоматически отправлять цены на маркетплейсы». Включите в разделе Организации.'
          );
          setTimeout(() => setRecalcAllMessage(null), 10000);
          return;
        }
      } else {
        const ok = window.confirm(
          'Отправить сохранённые минимальные цены на маркетплейсы для всех организаций с включённой автоотправкой цен?\n\nОперация выполняется в фоне.'
        );
        if (!ok) return;
      }
      const res = await pricesApi.pushAll({
        organizationId: filterOrganizationId || undefined,
      });
      const msg =
        res?.message ||
        'Отправка цен на маркетплейсы запущена в фоне.';
      setRecalcAllMessage(msg);
      setTimeout(() => setRecalcAllMessage(null), 15000);
    } catch (err) {
      console.error('[Prices] push all failed:', err);
      setRecalcAllMessage('Ошибка: ' + (err.response?.data?.message || err.message));
      setTimeout(() => setRecalcAllMessage(null), 10000);
    } finally {
      setPushAllLoading(false);
    }
  };

  if (loading && products.length === 0) {
    return <div className="loading">Загрузка цен...</div>;
  }

  if (error && products.length === 0) {
    return <div className="error">Ошибка: {error}</div>;
  }

  return (
    <div className="card">
      <h1 className="title">💰 Цены</h1>
      <p className="subtitle">
        Управление ценами товаров на маркетплейсах ·{' '}
        <Link to="/prices/strategies" style={{ color: 'var(--primary)' }}>Стратегии ценообразования</Link>
      </p>

      <div className="main-card mb-3 card">
        <div className="card-body p-0">
          <div className="products-list-toolbar">
            <div className="d-flex flex-wrap align-items-end gap-2 gap-md-3">
              <div className="flex-grow-1" style={{ minWidth: 200, maxWidth: 480 }}>
                <label className="text-muted small mb-1 d-block" htmlFor="prices-list-search">
                  Поиск по списку
                </label>
                <input
                  id="prices-list-search"
                  type="search"
                  className="form-control form-control-sm products-list-search-input"
                  placeholder="Название, артикул, штрихкод…"
                  value={listSearch}
                  onChange={handleListSearchChange}
                  autoComplete="off"
                  aria-label="Поиск по названию, артикулу или штрихкоду"
                  aria-busy={listRefreshing}
                />
              </div>
              <div className="d-flex align-items-end gap-2 ms-md-auto flex-wrap">
                <span
                  className={`products-list-refresh-hint small ${listRefreshing ? 'is-visible' : ''}`}
                  aria-live="polite"
                >
                  Обновление списка…
                </span>
                <Button
                  type="button"
                  variant="secondary"
                  size="small"
                  className="btn-shadow"
                  onClick={() => setFiltersOpen((o) => !o)}
                  aria-expanded={filtersOpen}
                  title="Организация, бренд, категория, тип товара"
                >
                  {filtersOpen ? '▼ Фильтры' : '▶ Фильтры'}
                  {activeFiltersCount > 0 ? (
                    <span className="badge bg-primary ms-1 rounded-pill">{activeFiltersCount}</span>
                  ) : null}
                </Button>
              </div>
            </div>
            {filtersOpen ? (
              <div className="products-filters-panel">
                <div className="row g-2 g-md-3 align-items-end">
                  <div className="col-12 col-md-6 col-lg-3">
                    <label className="text-muted small mb-1 d-block" htmlFor="prices-filter-org">
                      Организация
                    </label>
                    <select
                      id="prices-filter-org"
                      className="form-select form-select-sm"
                      value={filterOrganizationId}
                      onChange={handleFilterOrganizationChange}
                    >
                      <option value="">Все организации</option>
                      {organizations.map((org) => (
                        <option key={org.id} value={org.id}>
                          {org.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="col-12 col-md-6 col-lg-3">
                    <label className="text-muted small mb-1 d-block" htmlFor="prices-filter-brand">
                      Бренд
                    </label>
                    <select
                      id="prices-filter-brand"
                      className="form-select form-select-sm"
                      value={filterBrandId}
                      onChange={handleFilterBrandChange}
                    >
                      <option value="">Все бренды</option>
                      {[...brands]
                        .filter((b) => b && b.name)
                        .sort((a, b) => String(a.name).localeCompare(String(b.name), 'ru'))
                        .map((b) => (
                          <option key={b.id} value={b.id}>
                            {b.name}
                          </option>
                        ))}
                    </select>
                  </div>
                  <div className="col-12 col-md-6 col-lg-3">
                    <label className="text-muted small mb-1 d-block" htmlFor="prices-filter-cat">
                      Категория
                    </label>
                    <select
                      id="prices-filter-cat"
                      className="form-select form-select-sm"
                      value={filterCategoryId}
                      onChange={handleFilterCategoryChange}
                    >
                      <option value="">Все категории</option>
                      {showNoneCategoryOption ? (
                        <option value={FILTER_CATEGORY_NONE}>Без категории</option>
                      ) : null}
                      {categories.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="col-12 col-md-6 col-lg-3">
                    <label className="text-muted small mb-1 d-block" htmlFor="prices-filter-type">
                      Тип товара
                    </label>
                    <select
                      id="prices-filter-type"
                      className="form-select form-select-sm"
                      value={filterProductType}
                      onChange={handleFilterProductTypeChange}
                    >
                      <option value="">Все типы</option>
                      <option value="product">Товар</option>
                      {kitsEnabled ? <option value="kit">Комплект</option> : null}
                    </select>
                  </div>
                  <div className="col-12 col-md-6 col-lg-3">
                    <label className="text-muted small mb-1 d-block" htmlFor="prices-filter-archive">
                      Архив
                    </label>
                    <select
                      id="prices-filter-archive"
                      className="form-select form-select-sm"
                      value={filterArchiveMode}
                      onChange={handleFilterArchiveModeChange}
                    >
                      <option value="">Скрыть архивные</option>
                      <option value="include">Включая архивные</option>
                      <option value="only">Только архивные</option>
                    </select>
                  </div>
                  <div className="col-12 col-md-6 col-lg-3">
                    <div className="products-unlinked-mp-filter" title="Показать товары без связи с маркетплейсом">
                      <span className="text-muted small d-block mb-1">Не связан</span>
                      <div className="d-flex align-items-center gap-1">
                        {MP_LINK_FILTER_TOGGLES.map((mp) => {
                          const active = filterUnlinkedMp.has(mp.code);
                          return (
                            <MarketplaceToggle
                              key={mp.code}
                              active={active}
                              size={28}
                              color={mp.color}
                              title={
                                active
                                  ? `Показаны товары без связи с ${mp.name}`
                                  : `Показать товары без связи с ${mp.name}`
                              }
                              onToggle={() => toggleUnlinkedMpFilter(mp.code)}
                            >
                              {mp.label}
                            </MarketplaceToggle>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                  <div className="col-12 col-md-6 col-lg-3">
                    <div className="products-unlinked-mp-filter" title="Показать товары со связью с маркетплейсом">
                      <span className="text-muted small d-block mb-1">Связан</span>
                      <div className="d-flex align-items-center gap-1">
                        {MP_LINK_FILTER_TOGGLES.map((mp) => {
                          const active = filterLinkedMp.has(mp.code);
                          return (
                            <MarketplaceToggle
                              key={mp.code}
                              active={active}
                              size={28}
                              color={mp.color}
                              title={
                                active
                                  ? `Показаны товары со связью с ${mp.name}`
                                  : `Показать товары со связью с ${mp.name}`
                              }
                              onToggle={() => toggleLinkedMpFilter(mp.code)}
                            >
                              {mp.label}
                            </MarketplaceToggle>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                </div>
                {activeFiltersCount > 0 ? (
                  <div className="mt-2">
                    <button
                      type="button"
                      className="btn btn-link btn-sm p-0 text-decoration-none"
                      onClick={clearListFilters}
                    >
                      Сбросить фильтры
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div style={{marginBottom: '20px', padding: '10px', background: 'rgba(255,255,255,0.05)', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.1)'}}>
        <p style={{margin: 0, color: 'var(--muted)', fontSize: '14px'}}>
          💡 <strong>Подсказка:</strong> Наведите курсор на цену товара в таблице ниже, чтобы увидеть подробную информацию о товаре.
        </p>
      </div>
      {totalProducts > 0 && !products.some(p => (p.storedMinPriceOzon ?? p.stored_min_price_ozon) != null || (p.storedMinPriceWb ?? p.stored_min_price_wb) != null || (p.storedMinPriceYm ?? p.stored_min_price_ym) != null) && (
        <div style={{marginBottom: '16px', padding: '12px 16px', background: 'rgba(251, 191, 36, 0.12)', borderRadius: '8px', border: '1px solid rgba(251, 191, 36, 0.35)', color: '#d97706', fontSize: '14px'}}>
          📊 <strong>Сохранённые цены не загружены.</strong> Нажмите «Пересчитать все минимальные цены» ниже — после завершения обновите страницу, и цены будут отображаться при каждом обновлении.
        </div>
      )}

      <div style={{marginTop: '20px', width: '100%'}}>
        {totalProducts === 0 && !listRefreshing ? (
          <div className="empty-state">
            <p>Нет товаров для отображения</p>
            <p style={{fontSize: '13px', marginTop: '8px'}}>Добавьте товары в разделе «Товары» или измените фильтры</p>
          </div>
        ) : (
          <div className={`prices-table-container card ${listRefreshing ? 'opacity-75' : ''}`}>
            {renderPricesListPager('top')}
            <table className="prices-table table prices-table-commercial">
              <thead>
                <tr>
                  <th rowSpan={2} style={{ verticalAlign: 'middle' }}>Артикул</th>
                  <th rowSpan={2} style={{ width: '16%', verticalAlign: 'middle' }}>Товар</th>
                  <th
                    rowSpan={2}
                    className="prices-private-col"
                    style={{
                      width: '88px',
                      minWidth: '88px',
                      textAlign: 'center',
                      verticalAlign: 'middle',
                      background: 'rgba(16,185,129,0.14)',
                      color: '#047857',
                      fontWeight: 700,
                    }}
                    title="Мин. цена для частного клиента: себестоимость + доп. расходы + наценка (частные)"
                  >
                    Частные
                  </th>
                  <th colSpan={mpColSpan} className="mp-head-mp" style={{ background: 'rgba(0,91,255,0.12)' }}>
                    Ozon
                  </th>
                  <th colSpan={mpColSpan} className="mp-head-mp" style={{ background: 'rgba(203,17,171,0.12)' }}>
                    WB
                  </th>
                  <th colSpan={mpColSpan} className="mp-head-mp" style={{ background: 'rgba(255,204,0,0.14)' }}>
                    Я.Маркет
                  </th>
                  <th rowSpan={2} style={{ width: '72px', textAlign: 'center', verticalAlign: 'middle' }}>
                    Действия
                  </th>
                </tr>
                <tr>
                  {showFbsPrices && (
                    <th className="mp-head-sub" style={{ background: 'rgba(0,91,255,0.06)' }}>
                      {showFboPrices ? 'мин. FBS' : 'мин.'}
                    </th>
                  )}
                  {showFboPrices && (
                    <th className="mp-head-sub" style={{ background: 'rgba(0,91,255,0.06)' }}>
                      {showFbsPrices ? 'мин. FBO' : 'мин. FBO'}
                    </th>
                  )}
                  {!showFbsPrices && !showFboPrices && (
                    <th className="mp-head-sub" style={{ background: 'rgba(0,91,255,0.06)' }}>мин.</th>
                  )}
                  {showFbsPrices && (
                    <th className="mp-head-sub" style={{ background: 'rgba(203,17,171,0.06)' }}>
                      {showFboPrices ? 'мин. FBS' : 'мин.'}
                    </th>
                  )}
                  {showFboPrices && (
                    <th className="mp-head-sub" style={{ background: 'rgba(203,17,171,0.06)' }}>
                      {showFbsPrices ? 'мин. FBO' : 'мин. FBO'}
                    </th>
                  )}
                  {!showFbsPrices && !showFboPrices && (
                    <th className="mp-head-sub" style={{ background: 'rgba(203,17,171,0.06)' }}>мин.</th>
                  )}
                  {showFbsPrices && (
                    <th className="mp-head-sub" style={{ background: 'rgba(255,204,0,0.08)' }}>
                      {showFboPrices ? 'мин. FBS' : 'мин.'}
                    </th>
                  )}
                  {showFboPrices && (
                    <th className="mp-head-sub" style={{ background: 'rgba(255,204,0,0.08)' }}>
                      {showFbsPrices ? 'мин. FBO' : 'мин. FBO'}
                    </th>
                  )}
                  {!showFbsPrices && !showFboPrices && (
                    <th className="mp-head-sub" style={{ background: 'rgba(255,204,0,0.08)' }}>мин.</th>
                  )}
                </tr>
              </thead>
              <tbody>
                {visibleProducts.map((product) => {
                  const productMerged = product;
                  const productKey = String(product.id ?? product.sku ?? '');
                  const raw = calculatedPrices[productKey] || {};
                  const storedOzon = product.storedMinPriceOzon ?? product.stored_min_price_ozon;
                  const storedWb = product.storedMinPriceWb ?? product.stored_min_price_wb;
                  const storedYm = product.storedMinPriceYm ?? product.stored_min_price_ym;
                  const prices = {
                    ozon: raw.ozon ?? storedOzon ?? null,
                    wb: raw.wb ?? storedWb ?? null,
                    ym: raw.ym ?? storedYm ?? null,
                    ozonFbs: raw.ozonFbs ?? product.storedMinPriceOzonFbs ?? storedOzon ?? null,
                    ozonFbo: raw.ozonFbo ?? product.storedMinPriceOzonFbo ?? null,
                    wbFbs: raw.wbFbs ?? product.storedMinPriceWbFbs ?? null,
                    wbFbo: raw.wbFbo ?? product.storedMinPriceWbFbo ?? storedWb ?? null,
                    ymFbs: raw.ymFbs ?? product.storedMinPriceYmFbs ?? storedYm ?? null,
                    ymFbo: raw.ymFbo ?? product.storedMinPriceYmFbo ?? null,
                  };
                  const openMinModal = (marketplace, scheme, price, detailsFallback) => {
                    const schemeKey = scheme === 'FBO' ? 'Fbo' : scheme === 'FBS' ? 'Fbs' : '';
                    const storedDetails =
                      (schemeKey &&
                        product[
                          `storedCalculationDetails${marketplace === 'ozon' ? 'Ozon' : marketplace === 'wb' ? 'Wb' : 'Ym'}${schemeKey}`
                        ]) ||
                      (marketplace === 'ozon'
                        ? product.storedCalculationDetailsOzon
                        : marketplace === 'wb'
                          ? product.storedCalculationDetailsWb
                          : product.storedCalculationDetailsYm);
                    setPriceModal({
                      isOpen: true,
                      product,
                      marketplace,
                      priceScheme: scheme || null,
                      price,
                      calculatorData:
                        calculatorData[productKey]?.[marketplace] ||
                        detailsFallback ||
                        storedDetails ||
                        null,
                    });
                  };
                  const isLoading = loadingPrices[productKey];
                  const strategyLocked = product.hasPricingStrategy === true;
                  const skuOzon =
                    product.sku_ozon || product.ozon_sku || (product.product_skus && product.product_skus.ozon);
                  const skuWb =
                    product.mp_wb_vendor_code ||
                    (product.product_skus && product.product_skus.wb) ||
                    product.wb_sku ||
                    (product.sku_wb && !/^\d+$/.test(String(product.sku_wb).trim())
                      ? product.sku_wb
                      : null) ||
                    product.sku_wb;
                  const skuYm = product.sku_ym || product.ym_sku || (product.product_skus && product.product_skus.ym);

                  return (
                    <tr key={product.id}>
                      <td style={{ fontSize: '13px', color: 'var(--muted)', whiteSpace: 'nowrap', textAlign: 'center', verticalAlign: 'middle' }}>
                        {product?.id ? (
                          <button
                            type="button"
                            onClick={(e) => openProductCardFromClick(product.id, e)}
                            title="Открыть карточку товара"
                            style={{
                              padding: 0,
                              border: 0,
                              background: 'transparent',
                              color: 'inherit',
                              textDecoration: 'underline',
                              cursor: 'pointer',
                            }}
                          >
                            {product.sku || '—'}
                          </button>
                        ) : (
                          product.sku || '—'
                        )}
                      </td>
                      <td style={{ overflow: 'hidden', textOverflow: 'ellipsis', textAlign: 'center', verticalAlign: 'middle' }}>
                        <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', textAlign: 'center' }}>
                          {product?.id ? (
                            <button
                              type="button"
                              onClick={(e) => openProductCardFromClick(product.id, e)}
                              title="Открыть карточку товара"
                              style={{
                                padding: 0,
                                border: 0,
                                background: 'transparent',
                                color: 'inherit',
                                textDecoration: 'underline',
                                cursor: 'pointer',
                                textAlign: 'center',
                              }}
                            >
                              {product.name || 'Без названия'}
                            </button>
                          ) : (
                            product.name || 'Без названия'
                          )}
                        </div>
                        {resolveProductVolumeLiters(product) != null && (
                          <div style={{ fontSize: '11px', color: 'var(--muted)', marginTop: '2px', textAlign: 'center' }}>
                            Объем: {resolveProductVolumeLiters(product).toFixed(2)} л
                          </div>
                        )}
                        {strategyLocked ? (
                          <div
                            style={{ fontSize: '10px', color: '#d97706', marginTop: '2px', textAlign: 'center' }}
                            title={
                              product.effectivePricingStrategySource === 'product'
                                ? 'Стратегия товара'
                                : product.effectivePricingStrategySource === 'organization'
                                  ? 'Стратегия организации'
                                  : 'Стратегия по умолчанию кабинета'
                            }
                          >
                            {product.effectivePricingStrategyName
                              ? product.effectivePricingStrategyName
                              : 'стратегия'}
                          </div>
                        ) : null}
                      </td>
                      <td
                        className="prices-private-col"
                        style={{
                          textAlign: 'center',
                          verticalAlign: 'middle',
                          background: 'rgba(16,185,129,0.08)',
                          whiteSpace: 'nowrap',
                        }}
                        title="Нажмите, чтобы открыть расчёт мин. цены для частного клиента"
                      >
                        {(() => {
                          const rowTaxProfile = taxProfileForProduct(
                            organizations,
                            productMerged,
                            filterOrganizationId || getApiSessionContext().organizationId || null
                          );
                          const privatePrice = privateClientMinPrice(productMerged, rowTaxProfile);
                          if (privatePrice == null) {
                            return <span className="mp-price-muted">—</span>;
                          }
                          return (
                            <button
                              type="button"
                              className="mp-price-cell-min-btn"
                              style={{ color: '#047857' }}
                              onClick={() =>
                                setPriceModal({
                                  isOpen: true,
                                  product: productMerged,
                                  marketplace: 'private',
                                  priceScheme: null,
                                  price: privatePrice,
                                  calculatorData: null,
                                })
                              }
                            >
                              {privatePrice} ₽
                            </button>
                          );
                        })()}
                      </td>
                      <MarketplacePriceCells
                        product={productMerged}
                        marketplace="ozon"
                        minPrice={prices.ozon}
                        minPriceFbs={prices.ozonFbs}
                        minPriceFbo={prices.ozonFbo}
                        showFbs={showFbsPrices}
                        showFbo={showFboPrices}
                        minOnly
                        isLoading={isLoading}
                        hasSku={!!skuOzon}
                        skuBadge="OZ"
                        strategyLocked={strategyLocked}
                        disabled={recalcAllLoading || pushAllLoading}
                        onOpenMinDetails={() => openMinModal('ozon', null, prices.ozon)}
                        onOpenMinDetailsFbs={() => openMinModal('ozon', 'FBS', prices.ozonFbs)}
                        onOpenMinDetailsFbo={() => openMinModal('ozon', 'FBO', prices.ozonFbo)}
                      />
                      <MarketplacePriceCells
                        product={productMerged}
                        marketplace="wb"
                        minPrice={prices.wb}
                        minPriceFbs={prices.wbFbs}
                        minPriceFbo={prices.wbFbo}
                        showFbs={showFbsPrices}
                        showFbo={showFboPrices}
                        minOnly
                        isLoading={isLoading}
                        hasSku={!!skuWb}
                        skuBadge="WB"
                        strategyLocked={strategyLocked}
                        disabled={recalcAllLoading || pushAllLoading}
                        onOpenMinDetails={() => openMinModal('wb', null, prices.wb)}
                        onOpenMinDetailsFbs={() => openMinModal('wb', 'FBS', prices.wbFbs)}
                        onOpenMinDetailsFbo={() => openMinModal('wb', 'FBO', prices.wbFbo)}
                      />
                      <MarketplacePriceCells
                        product={productMerged}
                        marketplace="ym"
                        minPrice={prices.ym}
                        minPriceFbs={prices.ymFbs}
                        minPriceFbo={prices.ymFbo}
                        showFbs={showFbsPrices}
                        showFbo={showFboPrices}
                        minOnly
                        isLoading={isLoading}
                        hasSku={!!skuYm}
                        skuBadge="YM"
                        strategyLocked={strategyLocked}
                        disabled={recalcAllLoading || pushAllLoading}
                        onOpenMinDetails={() => openMinModal('ym', null, prices.ym)}
                        onOpenMinDetailsFbs={() => openMinModal('ym', 'FBS', prices.ymFbs)}
                        onOpenMinDetailsFbo={() => openMinModal('ym', 'FBO', prices.ymFbo)}
                      />
                      <td style={{ textAlign: 'center', verticalAlign: 'middle', whiteSpace: 'nowrap' }}>
                        <div
                          style={{
                            display: 'inline-flex',
                            gap: '4px',
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
                        >
                          <Button
                            type="button"
                            variant="secondary"
                            size="small"
                            className="prices-row-action-btn"
                            onClick={() => handleRecalcOne(product.id)}
                            disabled={
                              recalcAllLoading ||
                              pushAllLoading ||
                              recalcOneProductId === product.id ||
                              pushOneProductId === product.id
                            }
                            title="Пересчитать минимальные цены"
                            aria-label="Пересчитать минимальные цены"
                          >
                            {recalcOneProductId === product.id ? '⏳' : '🔄'}
                          </Button>
                          <Button
                            type="button"
                            variant="secondary"
                            size="small"
                            className="prices-row-action-btn"
                            onClick={() => handlePushOne(product.id)}
                            disabled={
                              recalcAllLoading ||
                              pushAllLoading ||
                              recalcOneProductId === product.id ||
                              pushOneProductId === product.id
                            }
                            title="Отправить цены на маркетплейсы"
                            aria-label="Отправить цены на маркетплейсы"
                          >
                            {pushOneProductId === product.id ? '⏳' : '📤'}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {renderPricesListPager('bottom')}
          </div>
        )}
      </div>

      <div className="actions" style={{marginTop: '16px', display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center'}}>
        <Button variant="primary" onClick={handleRecalcAndSave} disabled={recalcAllLoading || pushAllLoading || listRefreshing}>
          {recalcAllLoading ? '⏳ Запуск пересчёта...' : '📊 Пересчитать и сохранить все минимальные цены'}
        </Button>
        <Button variant="secondary" onClick={handlePushAll} disabled={recalcAllLoading || pushAllLoading || listRefreshing}>
          {pushAllLoading
            ? '⏳ Запуск отправки...'
            : filterOrganizationId
              ? '📤 Отправить цены на маркетплейсы (организация)'
              : '📤 Отправить цены на маркетплейсы'}
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

      <PriceDetailsModal
        isOpen={priceModal.isOpen}
        onClose={() => setPriceModal({ isOpen: false, product: null, marketplace: null, price: null, calculatorData: null })}
        product={priceModal.product}
        marketplace={priceModal.marketplace}
        priceData={priceModal.price}
        priceScheme={priceModal.priceScheme || null}
        calculatorData={(() => {
          if (priceModal.marketplace === 'private' || priceModal.marketplace === 'manual') {
            return null;
          }
          const productKey = priceModal.product && (priceModal.product.id ?? priceModal.product.sku);
          const fromState = productKey ? calculatorData[productKey]?.[priceModal.marketplace] : null;
          const fromModal = priceModal.calculatorData;
          const scheme = String(priceModal.priceScheme || '').toUpperCase();
          const mp = priceModal.marketplace;
          const mpCap = mp === 'ozon' ? 'Ozon' : mp === 'wb' ? 'Wb' : 'Ym';
          const fromStoredScheme =
            scheme === 'FBS'
              ? priceModal.product?.[`storedCalculationDetails${mpCap}Fbs`]
              : scheme === 'FBO' || scheme === 'FBY'
                ? priceModal.product?.[`storedCalculationDetails${mpCap}Fbo`]
                : null;
          const fromStored = priceModal.product && priceModal.marketplace
            ? (priceModal.marketplace === 'ozon' ? priceModal.product.storedCalculationDetailsOzon : priceModal.marketplace === 'wb' ? priceModal.product.storedCalculationDetailsWb : priceModal.product.storedCalculationDetailsYm)
            : null;
          const raw = fromModal ?? fromStoredScheme ?? fromState ?? fromStored ?? null;
          if (!raw || !priceModal.product) return raw;
          let enriched = enrichCalculatorVolumeFromProduct(raw, priceModal.product, priceModal.marketplace);
          if (priceModal.marketplace === 'ozon') {
            enriched = enrichOzonCalculatorFromProduct(enriched, priceModal.product);
          }
          return enriched;
        })()}
        wbAcquiringPercent={wbAcquiringPercent}
        ozonAcquiringPercent={ozonAcquiringPercent}
        wbGemServicesPercent={wbGemServicesPercent}
        ymEarlyShipmentDiscountPp={ymEarlyShipmentDiscountPp}
        taxProfile={taxProfileForProduct(
          organizations,
          priceModal.product,
          filterOrganizationId || getApiSessionContext().organizationId || null
        )}
      />
    </div>
  );
}
