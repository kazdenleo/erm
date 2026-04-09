/**
 * Price Details Modal Component
 * Модальное окно с детальной информацией о расчете цены
 */

import React from 'react';
import { Modal } from '../common/Modal/Modal';
import './PriceDetailsModal.css';

export function PriceDetailsModal({ isOpen, onClose, product, marketplace, priceData, calculatorData, wbAcquiringPercent = null, wbGemServicesPercent = null }) {
  if (!isOpen || !product || !marketplace) {
    return null;
  }

  const marketplaceNames = {
    'ozon': 'Ozon',
    'wb': 'Wildberries',
    'ym': 'Yandex Market'
  };

  const marketplaceName = marketplaceNames[marketplace] || marketplace;

  // Есть ли полноценные данные для детального расчёта (комиссии обязательны; для WB также логика по logistics_base/logistics_liter)
  const hasValidDetails = calculatorData && typeof calculatorData === 'object' && !calculatorData.error &&
    (calculatorData.commissions && typeof calculatorData.commissions === 'object' &&
      (marketplace === 'wb' ? (calculatorData.commissions.FBS != null || calculatorData.commissions.FBO != null) : true));

  // Нет данных калькулятора — показываем только сохранённую цену (из БД или после пересчёта в другой сессии)
  if (!hasValidDetails) {
    const price = priceData != null ? Number(priceData) : null;
    if (price == null || isNaN(price)) return null;
    return (
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        title={`Минимальная цена — ${marketplaceName}`}
        size="medium"
      >
        <div className="price-details" style={{ padding: '20px' }}>
          <div style={{ marginBottom: '16px', fontSize: '18px', fontWeight: 600 }}>
            {product.sku && <span style={{ color: 'var(--muted)', marginRight: '8px' }}>{product.sku}</span>}
            {product.name || 'Товар'}
          </div>
          <div style={{ marginBottom: '24px', padding: '16px', background: 'rgba(255,255,255,0.06)', borderRadius: '8px' }}>
            <div style={{ color: 'var(--muted)', fontSize: '13px', marginBottom: '4px' }}>Минимальная рекомендуемая цена</div>
            <div style={{ fontSize: '24px', fontWeight: 700 }}>{Math.round(price)} ₽</div>
          </div>
          <p style={{ color: 'var(--muted)', fontSize: '13px', margin: 0 }}>
            Детальный расчёт (комиссии, логистика, эквайринг) доступен после нажатия «Пересчитать и сохранить все минимальные цены» на странице цен.
          </p>
        </div>
      </Modal>
    );
  }

  // Проверяем, есть ли ошибка в calculatorData
  if (calculatorData.error) {
    return (
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        title={`⚠️ Ошибка расчета цены для ${marketplaceName}`}
        size="medium"
      >
        <div className="price-details" style={{ padding: '20px', textAlign: 'center' }}>
          <div style={{ color: '#ef4444', fontSize: '18px', marginBottom: '20px' }}>
            ❌ {calculatorData.error}
          </div>
          <p style={{ color: '#6b7280', marginTop: '20px' }}>
            Пожалуйста, проверьте настройки склада и попробуйте снова.
          </p>
        </div>
      </Modal>
    );
  }
  
  if (!priceData) {
    return null;
  }

  // Извлекаем данные из калькулятора. Расчёт по схеме FBS: для WB — только комиссия FBS (Маркетплейс).
  const commissions = calculatorData.commissions || {};
  const emptyCommission = { percent: 0, value: 0, delivery_amount: 0, return_amount: 0 };
  
  // ВАЖНО: Для WB используем ТОЛЬКО FBS комиссию (kgvpMarketplace), НЕ FBO!
  const commission = marketplace === 'wb'
    ? (commissions.FBS || emptyCommission)
    : (commissions.FBS || commissions.FBO || emptyCommission);
  
  // Логируем для диагностики
  if (marketplace === 'wb') {
    console.log(`[PriceDetailsModal] WB commission selection:`, {
      hasFBS: !!commissions.FBS,
      fbsPercent: commissions.FBS?.percent,
      hasFBO: !!commissions.FBO,
      fboPercent: commissions.FBO?.percent,
      selectedCommission: commission.percent,
      allCommissions: commissions
    });
    
    // Предупреждение, если используется FBO вместо FBS
    if (commissions.FBO && !commissions.FBS) {
      console.error(`[PriceDetailsModal] ⚠ ERROR: FBS commission missing, but FBO exists! This should not happen.`);
    }
    if (commissions.FBS && commissions.FBO && commissions.FBS.percent !== commissions.FBO.percent) {
      console.log(`[PriceDetailsModal] ✓ FBS (${commissions.FBS.percent}%) and FBO (${commissions.FBO.percent}%) differ - using FBS for WB`);
    }
  }
  
  // Преобразуем все значения в числа для безопасных вычислений
  // ВАЖНО: База расходов должна совпадать с расчётом на странице цен:
  // себестоимость (cost/price/base_price) + дополнительные расходы (additionalExpenses).
  const costBase = Number(product.cost ?? product.price ?? product.base_price ?? 0) || 0;
  const additionalExpenses = Number(product.additionalExpenses ?? product.additional_expenses ?? 0) || 0;
  const basePrice = costBase + additionalExpenses;
  const calculatedPrice = Number(priceData) || 0;
  
  // Фиксированные расходы (преобразуем в числа)
  // Для Wildberries используем процент эквайринга из настроек
  let acquiring = 0;
  if (marketplace === 'wb' && wbAcquiringPercent !== null && wbAcquiringPercent !== undefined) {
    // Для WB: используем процент эквайринга из настроек
    acquiring = Number(wbAcquiringPercent) || 0;
    console.log(`[PriceDetailsModal] WB acquiring percent from settings: ${acquiring}%`);
  } else {
    // Для других маркетплейсов используем значение из API
    acquiring = Number(calculatorData.acquiring) || 0;
  }
  // Обработка заказа: используем значение из API
  console.log(`[PriceDetailsModal] ========== PROCESSING COST DEBUG ==========`);
  console.log(`[PriceDetailsModal] Full calculatorData:`, JSON.stringify(calculatorData, null, 2));
  console.log(`[PriceDetailsModal] calculatorData.processing_cost:`, calculatorData.processing_cost);
  console.log(`[PriceDetailsModal] calculatorData.processing_cost type:`, typeof calculatorData.processing_cost);
  console.log(`[PriceDetailsModal] calculatorData.commissions:`, calculatorData.commissions);
  console.log(`[PriceDetailsModal] calculatorData.commissions.FBS:`, calculatorData.commissions?.FBS);
  console.log(`[PriceDetailsModal] calculatorData.commissions.FBS?.first_mile_amount:`, calculatorData.commissions?.FBS?.first_mile_amount);
  
  // Обработка заказа: Ozon — из API; YM — SORTING; WB — нет
  let processingCost = 0;
  if (marketplace === 'ozon') {
    processingCost = calculatorData.processing_cost !== undefined && calculatorData.processing_cost !== null
      ? Number(calculatorData.processing_cost)
      : 0;
    console.log(`[PriceDetailsModal] Ozon processing cost (from API): ${processingCost}`);
  } else if (marketplace === 'ym') {
    processingCost = calculatorData.processing_cost !== undefined && calculatorData.processing_cost !== null
      ? Number(calculatorData.processing_cost)
      : 0;
    console.log(`[PriceDetailsModal] YM processing cost (SORTING): ${processingCost}`);
  }
  console.log(`[PriceDetailsModal] =========================================`);
  
  // Логистика: пересчитываем для WB с учетом округления, для других маркетплейсов используем значение из API
  let logisticsCost = 0;
  if (marketplace === 'wb' && calculatorData.logistics_base !== undefined && calculatorData.logistics_liter !== undefined) {
    // Для WB пересчитываем логистику с учетом округления (volume - 1) вверх
    const volume = calculatorData.volume_weight !== undefined && calculatorData.volume_weight !== null 
      ? calculatorData.volume_weight 
      : (Number(product.volume) || 0);
    
    if (volume && volume > 1) {
      const additionalLiters = Math.ceil(volume - 1);
      logisticsCost = calculatorData.logistics_base + calculatorData.logistics_liter * additionalLiters;
    } else {
      logisticsCost = calculatorData.logistics_base;
    }
  } else {
    // Для других маркетплейсов используем значение из API
    logisticsCost = calculatorData.logistics_cost !== undefined && calculatorData.logistics_cost !== null
      ? Number(calculatorData.logistics_cost)
      : 0;
    // Для Ozon: округляем логистику до целого числа
    if (marketplace === 'ozon' && logisticsCost > 0) {
      const logisticsCostBefore = logisticsCost;
      logisticsCost = Math.round(logisticsCost);
      console.log(`[PriceDetailsModal] Ozon logistics cost rounded: ${logisticsCostBefore} → ${logisticsCost}`);
    }
  }
  
  // Доставка до клиента: для YM пересчитываем по valueType (relative = % от цены, absolute = фикс.)
  let deliveryToCustomer = (commission.delivery_amount !== undefined && commission.delivery_amount !== null)
    ? Number(commission.delivery_amount)
    : 0;
  if (marketplace === 'ym' && calculatorData.ymTariffs) {
    const d = calculatorData.ymTariffs.DELIVERY_TO_CUSTOMER;
    const cr = calculatorData.ymTariffs.CROSSREGIONAL_DELIVERY;
    const ex = calculatorData.ymTariffs.EXPRESS_DELIVERY;
    const atPrice = (t) => {
      if (!t) return 0;
      const vt = (t.valueType || 'absolute').toLowerCase();
      const v = Number(t.value) || Number(t.amount) || 0;
      return vt === 'relative' ? (calculatedPrice * (v / 100)) : v;
    };
    deliveryToCustomer = atPrice(d) + atPrice(cr) + atPrice(ex);
  }

  const quantity = Number(product.quantity) || 1;
  // Возвраты: только если в карточке указан процент выкупа (buyout_rate)
  const hasBuyoutRate = product.buyout_rate != null && product.buyout_rate !== '' && !isNaN(Number(product.buyout_rate));
  const buyoutRateInput = hasBuyoutRate ? Number(product.buyout_rate) : null;
  const buyoutRate = buyoutRateInput != null ? buyoutRateInput / 100 : 1;
  const returnRate = buyoutRateInput != null && buyoutRateInput < 100 ? (1 - buyoutRate) : 0;

  console.log(`[PriceDetailsModal] Returns for ${marketplace}:`, {
    buyoutRateFromProduct: product.buyout_rate,
    buyoutRateInput,
    returnRate: (returnRate * 100).toFixed(2) + '%',
    basePrice
  });

  let returnCostPerUnit = 0;
  let returnProcessingCostPerUnit = 0;
  let returnLossCostPerUnit = 0;
  let returnAmount = 0;

  if (returnRate > 0) {
    returnLossCostPerUnit = basePrice * returnRate;
    if (commission.return_amount !== undefined && commission.return_amount !== null) {
      returnAmount = Number(commission.return_amount);
    }
    returnCostPerUnit = returnAmount * returnRate;
    const returnProcessingFromApi = (commission.return_processing_amount !== undefined && commission.return_processing_amount !== null)
      ? Number(commission.return_processing_amount)
      : 0;
    returnProcessingCostPerUnit = returnProcessingFromApi * returnRate;

    console.log(`[PriceDetailsModal] ${marketplace} return costs (from API only):`, {
      return_amount: commission.return_amount,
      returnAmount,
      returnCostPerUnit: returnCostPerUnit.toFixed(2),
      returnProcessingCostPerUnit: returnProcessingCostPerUnit.toFixed(2),
      returnLossCostPerUnit: returnLossCostPerUnit.toFixed(2)
    });
  }
  
  // Для отображения показываем стоимость возврата на единицу товара
  const returnCost = Number(returnCostPerUnit) || 0;
  const returnProcessingCost = Number(returnProcessingCostPerUnit) || 0;
  const returnLossCost = Number(returnLossCostPerUnit) || 0;
  const expectedReturns = quantity * returnRate; // Для отображения в модальном окне
  
  // Отладочное логирование для проверки значений
  console.log(`[PriceDetailsModal] Return costs values:`, {
    returnLossCost: returnLossCost,
    returnCost: returnCost,
    returnProcessingCost: returnProcessingCost,
    shouldShow: (returnLossCost > 0 || returnCost > 0 || returnProcessingCost > 0),
    buyoutRate: buyoutRateInput,
    returnRate: returnRate
  });
  
  // Комиссия за продвижение бренда — только из API/калькулятора
  const brandPromotionPercent = (calculatorData.brand_promotion_percent != null && !isNaN(Number(calculatorData.brand_promotion_percent)))
    ? Number(calculatorData.brand_promotion_percent) / 100
    : 0;
  
  // Объем товара (для отображения)
  const productVolume = marketplace === 'ozon' 
    ? (Number(product.volume) || Number(product.volume_weight) || Number(calculatorData.volume_weight) || 0)
    : marketplace === 'wb'
    ? (Number(calculatorData.volume_weight) || Number(product.volume) || 0)
    : 0;
  
  // Обработка отправления (fbs_first_mile_max_amount) - отдельная статья расходов
  const shipmentProcessingCost = marketplace === 'ozon' 
    ? (Number(commission.first_mile_amount) || 0)
    : 0;
  
  // Отладочное логирование для диагностики
  console.log(`[PriceDetailsModal] Logistics data:`, {
    marketplace,
    logisticsCost: logisticsCost, // Итоговая стоимость логистики из API
    processingCost: processingCost, // Обработка отправления
    shipmentProcessingCost: shipmentProcessingCost, // Обработка отправления из API
    productVolume: productVolume, // Объем (для отображения)
    calculatorLogisticsCost: calculatorData.logistics_cost,
    calculatorData: calculatorData
  });
  
  // Проценты (преобразуем в числа)
  const marketplaceCommissionPercent = (Number(commission.percent) || 0) / 100;
  const acquiringPercent = (acquiring || 0) / 100;
  
  // Процент услуг Джем (только для WB, вычисляется от суммы товара)
  let gemServicesPercent = 0;
  if (marketplace === 'wb' && wbGemServicesPercent !== null && wbGemServicesPercent !== undefined) {
    gemServicesPercent = (Number(wbGemServicesPercent) || 0) / 100;
    console.log(`[PriceDetailsModal] WB gem services percent from settings: ${wbGemServicesPercent}% (${gemServicesPercent})`);
  }
  
  // ВАЖНО: Для WB проверяем, что используется FBS комиссия, а не FBO
  if (marketplace === 'wb') {
    if (commissions.FBS && commissions.FBO && commissions.FBS.percent !== commissions.FBO.percent) {
      if (commission.percent !== commissions.FBS.percent) {
        console.error(`[PriceDetailsModal] ✗ ERROR: Using wrong commission! Expected FBS (${commissions.FBS.percent}%), but got ${commission.percent}%`);
      } else {
        console.log(`[PriceDetailsModal] ✓ Correct: Using FBS commission (${commissions.FBS.percent}%) for WB, not FBO (${commissions.FBO.percent}%)`);
      }
    }
  }
  
  // Расчет затрат
  const commissionAmount = calculatedPrice * marketplaceCommissionPercent;
  // Для Ozon: округляем эквайринг в большую сторону до целого числа
  let acquiringAmount = calculatedPrice * acquiringPercent;
  if (marketplace === 'ozon') {
    const acquiringAmountBefore = acquiringAmount;
    acquiringAmount = Math.ceil(acquiringAmount);
    console.log(`[PriceDetailsModal] Ozon acquiring amount rounded: ${acquiringAmountBefore.toFixed(2)} → ${acquiringAmount}`);
  }
  const brandPromotionAmount = calculatedPrice * brandPromotionPercent;
  const gemServicesAmount = calculatedPrice * gemServicesPercent;
  const fixedExpenses = processingCost + logisticsCost + deliveryToCustomer + returnCost + returnProcessingCost + returnLossCost;

  // Для YM: приём (AGENCY_COMMISSION) и перевод (PAYMENT_TRANSFER) — считаем по valueType из API
  // absolute = фиксированная сумма в ₽, relative = процент от цены
  let ymAgencyDisplay = 0;
  let ymPaymentTransferDisplay = 0;
  if (marketplace === 'ym' && calculatorData.ymTariffs) {
    const agency = calculatorData.ymTariffs.AGENCY_COMMISSION;
    const payment = calculatorData.ymTariffs.PAYMENT_TRANSFER;
    const agencyValueType = (agency?.valueType || 'absolute').toLowerCase();
    const agencyValue = Number(agency?.value) || Number(agency?.amount) || 0;
    const paymentValueType = (payment?.valueType || 'absolute').toLowerCase();
    const paymentValue = Number(payment?.value) || Number(payment?.amount) || 0;
    if (agencyValueType === 'relative') {
      ymAgencyDisplay = calculatedPrice * (agencyValue / 100);
    } else {
      ymAgencyDisplay = agencyValue;
    }
    if (paymentValueType === 'relative') {
      ymPaymentTransferDisplay = calculatedPrice * (paymentValue / 100);
    } else {
      ymPaymentTransferDisplay = paymentValue;
    }
  }
  const ymAcquiringTotal = ymAgencyDisplay + ymPaymentTransferDisplay;
  const effectiveAcquiringAmount = marketplace === 'ym' ? ymAcquiringTotal : acquiringAmount;

  // Расчет прибыли
  const totalExpenses = commissionAmount + effectiveAcquiringAmount + brandPromotionAmount + gemServicesAmount + fixedExpenses + basePrice;
  const profit = calculatedPrice - totalExpenses;
  const profitPercent = calculatedPrice > 0 ? (profit / calculatedPrice) * 100 : 0;
  
  // Отладочное логирование для диагностики возвратов
  console.log(`[PriceDetailsModal] Final return costs calculation:`, {
    marketplace,
    buyoutRate: buyoutRateInput,
    returnRate: (returnRate * 100).toFixed(2) + '%',
    returnLossCost: returnLossCost.toFixed(2),
    returnCost: returnCost.toFixed(2),
    returnProcessingCost: returnProcessingCost.toFixed(2),
    totalReturnCosts: (returnLossCost + returnCost + returnProcessingCost).toFixed(2),
    fixedExpenses: fixedExpenses.toFixed(2),
    basePrice: basePrice.toFixed(2),
    totalExpenses: totalExpenses.toFixed(2)
  });
  
  // Налоги (15%)
  const taxRate = 0.15;
  const taxes = profit * taxRate;
  const netProfit = profit - taxes;
  const netProfitPercent = calculatedPrice > 0 ? (netProfit / calculatedPrice) * 100 : 0;

  const isEstimatedTariffs = marketplace === 'wb' && calculatorData._estimatedTariffs;

  const headerVolume = Number(product.volume) || Number(calculatorData?.volume_weight) || 0;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`💰 Расчёт минимальной цены · ${marketplaceName}`}
      size="large"
    >
      <div className="price-details">
        <div className="price-details-header" style={{ marginBottom: '16px', padding: '12px 16px', background: 'rgba(255,255,255,0.06)', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.1)', fontSize: '14px' }}>
          <span><strong>Артикул:</strong> {product.sku || '—'}</span>
          <span style={{ marginLeft: '16px' }}><strong>Название:</strong> {product.name || 'Без названия'}</span>
          <span style={{ marginLeft: '16px' }}><strong>Объём:</strong> {headerVolume > 0 ? `${headerVolume.toFixed(2)} л` : '—'}</span>
        </div>
        {isEstimatedTariffs && (
          <div style={{ marginBottom: '16px', padding: '12px', background: 'rgba(251, 191, 36, 0.15)', borderRadius: '8px', border: '1px solid rgba(251, 191, 36, 0.3)', color: '#d97706', fontSize: '13px' }}>
            ⚠️ Ориентировочный расчёт: тарифы Wildberries не загружены. Обновите тарифы в настройках интеграции (кнопка «Тарифы») для точного расчёта логистики и комиссий.
          </div>
        )}
        <div className="price-details-section">
          <h3 className="price-details-subtitle">💵 Расходы и расчёт цены</h3>
          <div className="price-breakdown">
            <div className="price-breakdown-item">
              <span className="price-breakdown-label">Себестоимость:</span>
              <span className="price-breakdown-value">
                {costBase > 0 ? `${costBase.toFixed(2)} ₽` : '— не указана'}
                {costBase > 0 && (
                  <div style={{fontSize: '10px', color: 'var(--muted)', marginTop: '2px', fontStyle: 'italic'}}>
                    = {costBase.toFixed(2)} ₽ {product.cost != null && product.cost !== '' && !isNaN(Number(product.cost)) && Number(product.cost) > 0
                      ? '(из карточки товара, себестоимость)'
                      : product.price != null && product.price !== '' && !isNaN(Number(product.price)) && Number(product.price) > 0
                        ? '(из цены товара)'
                        : '(из базовой цены)'}
                  </div>
                )}
              </span>
            </div>

            <div className="price-breakdown-item">
              <span className="price-breakdown-label">Дополнительные расходы:</span>
              <span className="price-breakdown-value">
                {additionalExpenses > 0 ? `${additionalExpenses.toFixed(2)} ₽` : '—'}
                <div style={{fontSize: '10px', color: 'var(--muted)', marginTop: '2px', fontStyle: 'italic'}}>
                  {additionalExpenses > 0
                    ? `= ${additionalExpenses.toFixed(2)} ₽ (из карточки товара)`
                    : '— не указаны'}
                </div>
              </span>
            </div>

            <div className="price-breakdown-item">
              <span className="price-breakdown-label">База (себестоимость + доп.):</span>
              <span className="price-breakdown-value">
                {basePrice > 0 ? `${basePrice.toFixed(2)} ₽` : '—'}
                {basePrice > 0 && (
                  <div style={{fontSize: '10px', color: 'var(--muted)', marginTop: '2px', fontStyle: 'italic'}}>
                    = {costBase.toFixed(2)} + {additionalExpenses.toFixed(2)} = {basePrice.toFixed(2)} ₽
                  </div>
                )}
              </span>
            </div>
            
            {processingCost > 0 && (
              <div className="price-breakdown-item">
                <span className="price-breakdown-label">Обработка заказа:</span>
                <span className="price-breakdown-value">
                  {processingCost.toFixed(2)} ₽
                  <div style={{fontSize: '10px', color: 'var(--muted)', marginTop: '2px', fontStyle: 'italic'}}>
                    = {processingCost.toFixed(2)} ₽ {marketplace === 'ozon' ? '(обработка заказа FBS из API Ozon)' : marketplace === 'ym' ? '(тариф YM SORTING — обработка заказа)' : '(из API)'}
                  </div>
                </span>
              </div>
            )}
            
            <div className="price-breakdown-item">
              <span className="price-breakdown-label">
                Логистика{productVolume > 0 ? ` (${productVolume.toFixed(2)} л)` : ''}:
              </span>
              <span className="price-breakdown-value">
                {logisticsCost.toFixed(2)} ₽
                <div style={{fontSize: '10px', color: 'var(--muted)', marginTop: '2px', fontStyle: 'italic'}}>
                  {marketplace === 'wb' && calculatorData.logistics_base !== undefined && calculatorData.logistics_liter !== undefined ? (
                    (() => {
                      // Используем volume_weight из calculatorData, если есть, иначе productVolume
                      const volume = calculatorData.volume_weight !== undefined && calculatorData.volume_weight !== null 
                        ? calculatorData.volume_weight 
                        : productVolume;
                      
                      if (!volume || volume <= 1) {
                        return `= ${calculatorData.logistics_base.toFixed(2)} ₽ (базовый тариф за первый литр)`;
                      } else {
                        // Округляем (volume - 1) вверх
                        const additionalLiters = Math.ceil(volume - 1);
                        const additionalCost = calculatorData.logistics_liter * additionalLiters;
                        // Пересчитываем logisticsCost с учетом округления
                        const recalculatedLogisticsCost = calculatorData.logistics_base + additionalCost;
                        return `= ${calculatorData.logistics_base.toFixed(2)} ₽ + ${calculatorData.logistics_liter.toFixed(2)} ₽ × ${additionalLiters} л = ${calculatorData.logistics_base.toFixed(2)} + ${additionalCost.toFixed(2)} = ${recalculatedLogisticsCost.toFixed(2)} ₽`;
                      }
                    })()
                  ) : marketplace === 'ozon' ? (
                    `= ${logisticsCost.toFixed(2)} ₽ (fbs_direct_flow_trans_max_amount из API Ozon)`
                  ) : (
                    `= ${logisticsCost.toFixed(2)} ₽ (из API YM)`
                  )}
                </div>
              </span>
            </div>
            
            {deliveryToCustomer > 0 && (
              <div className="price-breakdown-item">
                <span className="price-breakdown-label">Доставка до клиента:</span>
                <span className="price-breakdown-value">
                  {deliveryToCustomer.toFixed(2)} ₽
                  <div style={{fontSize: '10px', color: 'var(--muted)', marginTop: '2px', fontStyle: 'italic'}}>
                    = {deliveryToCustomer.toFixed(2)} ₽ {marketplace === 'ozon' ? '(fbs_deliv_to_customer_amount из API Ozon)' : marketplace === 'ym' ? '(тарифы YM: доставка до клиента + кросс-регион + экспресс, % или фикс.)' : '(из API)'}
                  </div>
                </span>
              </div>
            )}
            
            {/* Всегда показываем возвраты, если buyout_rate < 100% */}
            {returnRate > 0 && (
              <>
                <div className="price-breakdown-item">
                  <span className="price-breakdown-label">
                    Потеря себестоимости возвращенных товаров{expectedReturns > 0 ? ` (${expectedReturns.toFixed(2)} шт, выкуп ${buyoutRateInput.toFixed(0)}%)` : ` (выкуп ${buyoutRateInput.toFixed(0)}%)`}:
                  </span>
                  <span className="price-breakdown-value negative">
                    -{returnLossCost.toFixed(2)} ₽
                    <div style={{fontSize: '10px', color: 'var(--muted)', marginTop: '2px', fontStyle: 'italic'}}>
                      = {basePrice.toFixed(2)} × {(returnRate * 100).toFixed(1)}% = {returnLossCost.toFixed(2)} ₽
                    </div>
                  </span>
                </div>
                {returnCost > 0 && (
                  <div className="price-breakdown-item">
                    <span className="price-breakdown-label">
                      Возвраты{expectedReturns > 0 ? ` (${expectedReturns.toFixed(2)} шт)` : ` (${(returnRate * 100).toFixed(1)}%)`}:
                    </span>
                    <span className="price-breakdown-value negative">
                      -{returnCost.toFixed(2)} ₽
                      <div style={{fontSize: '10px', color: 'var(--muted)', marginTop: '2px', fontStyle: 'italic'}}>
                        = {returnAmount.toFixed(2)} × {(returnRate * 100).toFixed(1)}% = {returnCost.toFixed(2)} ₽
                      </div>
                    </span>
                  </div>
                )}
                {returnProcessingCost > 0 && (
                  <div className="price-breakdown-item">
                    <span className="price-breakdown-label">Обработка возвратов:</span>
                    <span className="price-breakdown-value negative">
                      -{returnProcessingCost.toFixed(2)} ₽
                      <div style={{fontSize: '10px', color: 'var(--muted)', marginTop: '2px', fontStyle: 'italic'}}>
                        = {returnProcessingCost.toFixed(2)} ₽ (из API × {(returnRate * 100).toFixed(1)}% возвратов)
                      </div>
                    </span>
                  </div>
                )}
              </>
            )}
            
            <div className="price-breakdown-item">
              <span className="price-breakdown-label">
                Комиссия {marketplaceName}{marketplace === 'wb' ? ' (FBS)' : ''} ({commission.percent || 0}%):
              </span>
              <span className="price-breakdown-value negative">
                -{commissionAmount.toFixed(2)} ₽
                <div style={{fontSize: '10px', color: 'var(--muted)', marginTop: '2px', fontStyle: 'italic'}}>
                  = {calculatedPrice.toFixed(2)} × {(marketplaceCommissionPercent * 100).toFixed(2)}% = {commissionAmount.toFixed(2)} ₽
                  {marketplace === 'wb' && (
                    <span style={{color: '#10b981', fontWeight: 600}}>
                      {' '}— схема FBS (Маркетплейс, kgvpMarketplace), по категории из API WB
                    </span>
                  )}
                </div>
                {marketplace === 'wb' && commissions.FBO && commissions.FBO.percent !== commission.percent && (
                  <div style={{fontSize: '9px', color: '#f59e0b', marginTop: '2px', fontStyle: 'italic'}}>
                    ⚠ FBO комиссия ({commissions.FBO.percent}%) не используется для WB
                  </div>
                )}
              </span>
            </div>
            
            {marketplace === 'ym' && (acquiringAmount > 0 || calculatorData.acquiring != null || (calculatorData.ymTariffs && (calculatorData.ymTariffs.AGENCY_COMMISSION || calculatorData.ymTariffs.PAYMENT_TRANSFER))) && (
              <>
                <div className="price-breakdown-item">
                  <span className="price-breakdown-label">Приём платежа покупателя (AGENCY_COMMISSION):</span>
                  <span className="price-breakdown-value negative">
                    -{ymAgencyDisplay.toFixed(2)} ₽
                    <div style={{fontSize: '10px', color: 'var(--muted)', marginTop: '2px', fontStyle: 'italic'}}>
                      {calculatorData.ymTariffs?.AGENCY_COMMISSION?.valueType === 'relative'
                        ? `= ${calculatedPrice.toFixed(2)} × ${(Number(calculatorData.ymTariffs.AGENCY_COMMISSION?.value) || 0).toFixed(2)}% = ${ymAgencyDisplay.toFixed(2)} ₽ (тариф YM, % от цены)`
                        : `= ${ymAgencyDisplay.toFixed(2)} ₽ (тариф YM, фиксированная сумма)`}
                    </div>
                  </span>
                </div>
                <div className="price-breakdown-item">
                  <span className="price-breakdown-label">Перевод платежа покупателя (PAYMENT_TRANSFER):</span>
                  <span className="price-breakdown-value negative">
                    -{ymPaymentTransferDisplay.toFixed(2)} ₽
                    <div style={{fontSize: '10px', color: 'var(--muted)', marginTop: '2px', fontStyle: 'italic'}}>
                      {calculatorData.ymTariffs?.PAYMENT_TRANSFER?.valueType === 'relative'
                        ? `= ${calculatedPrice.toFixed(2)} × ${(Number(calculatorData.ymTariffs.PAYMENT_TRANSFER?.value) || 0).toFixed(2)}% = ${ymPaymentTransferDisplay.toFixed(2)} ₽ (тариф YM, % от цены)`
                        : `= ${ymPaymentTransferDisplay.toFixed(2)} ₽ (тариф YM, фиксированная сумма)`}
                    </div>
                  </span>
                </div>
              </>
            )}
            {marketplace !== 'ym' && (acquiringAmount > 0 || (marketplace === 'wb' && (acquiring > 0 || wbAcquiringPercent != null)) || (marketplace === 'ozon' && calculatorData.acquiring != null)) && (
              <div className="price-breakdown-item">
                <span className="price-breakdown-label">
                  Эквайринг ({acquiring != null ? Number(acquiring).toFixed(2) : 0}%):
                </span>
                <span className="price-breakdown-value negative">
                  -{acquiringAmount.toFixed(2)} ₽
                  <div style={{fontSize: '10px', color: 'var(--muted)', marginTop: '2px', fontStyle: 'italic'}}>
                    = {calculatedPrice.toFixed(2)} × {(acquiringPercent * 100).toFixed(2)}% = {acquiringAmount.toFixed(2)} ₽
                    {marketplace === 'wb' && wbAcquiringPercent != null && (
                      <span> (из настроек интеграции)</span>
                    )}
                  </div>
                </span>
              </div>
            )}
            
            {(gemServicesAmount > 0 || (marketplace === 'wb' && wbGemServicesPercent !== null && wbGemServicesPercent !== undefined)) && (
              <div className="price-breakdown-item">
                <span className="price-breakdown-label">
                  Услуги Джем ({wbGemServicesPercent || 0}%):
                </span>
                <span className="price-breakdown-value negative">
                  -{gemServicesAmount.toFixed(2)} ₽
                  <div style={{fontSize: '10px', color: 'var(--muted)', marginTop: '2px', fontStyle: 'italic'}}>
                    = {calculatedPrice.toFixed(2)} × {(gemServicesPercent * 100).toFixed(2)}% = {gemServicesAmount.toFixed(2)} ₽
                    {marketplace === 'wb' && wbGemServicesPercent !== null && (
                      <span> (из настроек интеграции)</span>
                    )}
                  </div>
                </span>
              </div>
            )}
            
            {brandPromotionAmount > 0 && (
              <div className="price-breakdown-item">
                <span className="price-breakdown-label">
                  Продвижение бренда ({(brandPromotionPercent * 100).toFixed(2)}%):
                </span>
                <span className="price-breakdown-value negative">
                  -{brandPromotionAmount.toFixed(2)} ₽
                  <div style={{fontSize: '10px', color: 'var(--muted)', marginTop: '2px', fontStyle: 'italic'}}>
                    = {calculatedPrice.toFixed(2)} × {(brandPromotionPercent * 100).toFixed(2)}% = {brandPromotionAmount.toFixed(2)} ₽
                  </div>
                </span>
              </div>
            )}
            
            <div className="price-breakdown-item price-breakdown-subtotal">
              <span className="price-breakdown-label">Всего расходов:</span>
              <span className="price-breakdown-value negative">
                {(commissionAmount + effectiveAcquiringAmount + brandPromotionAmount + gemServicesAmount + fixedExpenses).toFixed(2)} ₽
                <div style={{fontSize: '10px', color: 'var(--muted)', marginTop: '2px', fontStyle: 'italic'}}>
                  = {commissionAmount.toFixed(2)} + {effectiveAcquiringAmount.toFixed(2)}{marketplace === 'ym' ? ` (${ymAgencyDisplay.toFixed(2)} + ${ymPaymentTransferDisplay.toFixed(2)})` : ''} + {brandPromotionAmount.toFixed(2)}{gemServicesAmount > 0 ? ' + ' + gemServicesAmount.toFixed(2) : ''} + {fixedExpenses.toFixed(2)} = {(commissionAmount + effectiveAcquiringAmount + brandPromotionAmount + gemServicesAmount + fixedExpenses).toFixed(2)} ₽
                </div>
              </span>
            </div>
            
            <div className="price-breakdown-item">
              <span className="price-breakdown-label">Минимальная чистая прибыль:</span>
              <span className="price-breakdown-value" style={{color: '#10b981'}}>
                {product?.minPrice != null && product.minPrice !== '' && !isNaN(Number(product.minPrice))
                  ? `+${Number(product.minPrice).toFixed(2)} ₽`
                  : '— не указана'}
                {product?.minPrice != null && product.minPrice !== '' && !isNaN(Number(product.minPrice)) && (
                  <div style={{fontSize: '10px', color: 'var(--muted)', marginTop: '2px', fontStyle: 'italic'}}>
                    = {Number(product.minPrice).toFixed(2)} ₽ (целевая чистая прибыль после налогов, из карточки товара)
                  </div>
                )}
              </span>
            </div>
          </div>
        </div>

        <div className="price-details-section">
          <h3 className="price-details-subtitle">📊 Прибыль</h3>
          <div className="price-breakdown">
            <div className="price-breakdown-item">
              <span className="price-breakdown-label">Валовая прибыль:</span>
              <span className="price-breakdown-value positive">
                {profit.toFixed(2)} ₽ ({profitPercent.toFixed(2)}%)
                <div style={{fontSize: '10px', color: 'var(--muted)', marginTop: '2px', fontStyle: 'italic'}}>
                  = {calculatedPrice.toFixed(2)} - {totalExpenses.toFixed(2)} = {profit.toFixed(2)} ₽
                </div>
              </span>
            </div>
            
            <div className="price-breakdown-item">
              <span className="price-breakdown-label">Налоги (15%):</span>
              <span className="price-breakdown-value negative">
                -{taxes.toFixed(2)} ₽
                <div style={{fontSize: '10px', color: 'var(--muted)', marginTop: '2px', fontStyle: 'italic'}}>
                  = {profit > 0 ? `${profit.toFixed(2)} × 15% = ${taxes.toFixed(2)} ₽` : '0 ₽ (прибыль отрицательная)'}
                </div>
              </span>
            </div>
            
            <div className="price-breakdown-item price-breakdown-total">
              <span className="price-breakdown-label">Чистая прибыль:</span>
              <span className="price-breakdown-value positive large">
                {netProfit.toFixed(2)} ₽ ({netProfitPercent.toFixed(2)}%)
                <div style={{fontSize: '10px', color: 'var(--muted)', marginTop: '2px', fontStyle: 'italic'}}>
                  = {profit.toFixed(2)} - {taxes.toFixed(2)} = {netProfit.toFixed(2)} ₽
                </div>
              </span>
            </div>
          </div>
        </div>

        <div className="price-details-section price-details-final">
          <div className="price-details-final-row">
            <span className="price-details-final-label">Минимальная рекомендуемая цена:</span>
            <span className="price-details-final-value">
              {calculatedPrice.toFixed(2)} ₽
              <div style={{fontSize: '11px', color: 'var(--muted)', marginTop: '4px', fontStyle: 'italic'}}>
                Рассчитана по формуле: себестоимость + расходы + целевая чистая прибыль (после налогов), с учётом комиссий и тарифов маркетплейса
              </div>
            </span>
          </div>
        </div>

        {calculatorData.categoryCommission && (
          <div className="price-details-section">
            <h3 className="price-details-subtitle">📋 Информация о категории</h3>
            <div className="price-details-grid">
              <div className="price-details-item">
                <span className="price-details-label">Категория:</span>
                <span className="price-details-value">
                  {calculatorData.categoryCommission.subjectName || 'Не указана'}
                </span>
              </div>
              <div className="price-details-item">
                <span className="price-details-label">ID категории:</span>
                <span className="price-details-value">
                  {calculatorData.categoryCommission.subjectID || '—'}
                </span>
              </div>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

