/**
 * Price Details Modal Component
 * Модальное окно с детальной информацией о расчете цены
 */

import React from 'react';
import { Modal } from '../common/Modal/Modal';
import { computeTaxesAndNetProfit, resolveOrganizationTaxProfile, taxProfileForProduct } from '../../utils/organizationTaxRates.js';
import { enrichOzonCalculatorFromProduct } from '../../utils/ozonBrandPromotion.js';
import { enrichCalculatorVolumeFromProduct, resolveEffectiveVolumeLiters } from '../../utils/productVolume.js';
import { resolveWbLogisticsDimensionsCm } from '../../utils/marketplaceDimensions.js';
import {
  privateClientPriceParts,
  resolveMarketplaceMinProfit,
} from '../../utils/marketplaceMinProfit.js';
import { resolveMarketplaceBuyoutRate } from '../../utils/marketplaceBuyoutRate.js';
import { resolveOzonLogisticsCostsForReturn, computeOzonReturnUnitAmount } from '../../utils/ozonReturnAmount.js';
import { calculateMinPrice, resolveWbSppPercent } from '../../utils/calculateMinPrice.js';
import './PriceDetailsModal.css';

function toFiniteNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function PriceRangeMax({ amount, title }) {
  const n = toFiniteNumber(amount);
  if (n == null) return null;
  return (
    <span className="price-range-max" title={title}>
      {n.toFixed(2)} ₽
    </span>
  );
}

/** Сумма в строке расходов; формула расчёта — в title (показ по hover). */
function PriceBreakdownValue({ children, formula, className = '', style, extra = null }) {
  const title =
    formula != null && String(formula).trim() !== ''
      ? String(formula).replace(/\s+/g, ' ').trim()
      : undefined;
  return (
    <span
      className={`price-breakdown-value${className ? ` ${className}` : ''}${title ? ' has-formula' : ''}`}
      style={style}
      title={title}
    >
      {children}
      {extra}
    </span>
  );
}

/**
 * Название строки расходов. ! — значение из настроек / карточки (не из API МП).
 * @param {{ children: React.ReactNode, fromSettings?: boolean, title?: string, className?: string }} props
 */
function BreakdownLabel({ children, fromSettings = false, title, className = '' }) {
  const tip =
    title ||
    (fromSettings
      ? 'Значение из настроек или карточки товара (не из API маркетплейса)'
      : undefined);
  return (
    <span className={`price-breakdown-label${className ? ` ${className}` : ''}`} title={tip}>
      {children}
      {fromSettings ? (
        <span className="price-breakdown-manual-mark" title={tip} aria-label="Не из API">
          !
        </span>
      ) : null}
    </span>
  );
}

class PriceDetailsModalErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error) {
    console.error('[PriceDetailsModal] render error', error);
  }

  componentDidUpdate(prevProps) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error) return this.props.fallback;
    return this.props.children;
  }
}

export function PriceDetailsModal(props) {
  const { isOpen, onClose, product, marketplace, priceData, priceScheme } = props;
  if (!isOpen || !product || !marketplace) return null;

  const shownPrice = Number(priceData);
  const fallback = (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Минимальная цена"
      size="medium"
    >
      <div className="price-details" style={{ padding: '20px' }}>
        <div style={{ marginBottom: '16px', fontSize: '18px', fontWeight: 600 }}>
          {product.sku && <span style={{ color: 'var(--muted)', marginRight: '8px' }}>{product.sku}</span>}
          {product.name || 'Товар'}
        </div>
        {Number.isFinite(shownPrice) && shownPrice >= 0 && (
          <div style={{ marginBottom: '16px', fontSize: '24px', fontWeight: 700 }}>
            {Math.round(shownPrice)} ₽
          </div>
        )}
        <p style={{ color: 'var(--muted)', fontSize: '13px', margin: 0 }}>
          Не удалось показать детальный расчёт. Пересчитайте минимальные цены и откройте снова.
        </p>
      </div>
    </Modal>
  );

  return (
    <PriceDetailsModalErrorBoundary
      resetKey={`${product.id}-${marketplace}-${priceScheme}-${shownPrice}`}
      fallback={fallback}
    >
      <PriceDetailsModalInner {...props} />
    </PriceDetailsModalErrorBoundary>
  );
}

function PriceDetailsModalInner({
  isOpen,
  onClose,
  product,
  marketplace,
  priceData,
  calculatorData,
  priceScheme = null,
  wbAcquiringPercent = null,
  wbGemServicesPercent = null,
  wbLocalizationIndex = null,
  wbSppPercent = null,
  ozonAcquiringPercent = null,
  ymEarlyShipmentDiscountPp = null,
  taxProfile = null,
}) {
  if (!isOpen || !product || !marketplace) {
    return null;
  }

  if (marketplace === 'private' || marketplace === 'manual') {
    const profile = taxProfile || taxProfileForProduct(null, product) || resolveOrganizationTaxProfile(null);
    const parts = privateClientPriceParts(product, profile);
    const total =
      parts?.total ??
      (priceData != null && !Number.isNaN(Number(priceData)) ? Math.round(Number(priceData)) : null);
    if (total == null) return null;

    const vatPctLabel = profile.vatRate > 0 ? `${(profile.vatRate * 100).toFixed(0)}%` : '0%';
    const incomeTaxPctLabel =
      profile.incomeTaxRate > 0
        ? profile.incomeTaxOnRevenue
          ? `УСН ${(profile.incomeTaxRate * 100).toFixed(0)}% с выручки`
          : `УСН ${(profile.incomeTaxRate * 100).toFixed(0)}% с прибыли`
        : 'не указан в организации';
    const incomeTaxPct = profile.incomeTaxRate > 0 ? `${(profile.incomeTaxRate * 100).toFixed(0)}%` : '0%';
    const vatAmount = parts?.vat ?? 0;
    const incomeTaxAmount = parts?.incomeTax ?? 0;
    const netProfit = parts?.netProfit ?? 0;
    const profitBeforeIncomeTax = parts?.profitBeforeIncomeTax ?? 0;
    const incomeTaxFormulaHint = (() => {
      if (profile.incomeTaxRate <= 0) return null;
      if (profile.incomeTaxOnRevenue) {
        return `= ${total.toFixed(2)} × ${incomeTaxPct} = ${incomeTaxAmount.toFixed(2)} ₽`;
      }
      const base = profitBeforeIncomeTax.toFixed(2);
      if (profitBeforeIncomeTax <= 0) {
        return `= ${base} × ${incomeTaxPct} = 0 ₽ (прибыль до налога не положительная)`;
      }
      return `= ${base} × ${incomeTaxPct} = ${incomeTaxAmount.toFixed(2)} ₽ (прибыль до налога: цена − расходы − НДС)`;
    })();

    return (
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        title="Минимальная цена — частные заказы"
        size="medium"
      >
        <div className="price-details" style={{ padding: '20px' }}>
          <div style={{ marginBottom: '16px', fontSize: '18px', fontWeight: 600 }}>
            {product.sku && <span style={{ color: 'var(--muted)', marginRight: '8px' }}>{product.sku}</span>}
            {product.name || 'Товар'}
          </div>

          <div className="price-details-section">
            <h3 className="price-details-subtitle">Расчёт для частного клиента</h3>
            <div className="price-breakdown-source-legend">
              <span className="price-breakdown-manual-mark">!</span>
              {' '}— значение из настроек или карточки товара (не из API маркетплейса)
            </div>
            <div className="price-breakdown">
              <div className="price-breakdown-item">
                <BreakdownLabel fromSettings>Себестоимость</BreakdownLabel>
                <span className="price-breakdown-value">
                  {(parts?.cost ?? 0).toFixed(2)} ₽
                </span>
              </div>
              <div className="price-breakdown-item">
                <BreakdownLabel fromSettings>Доп. расходы</BreakdownLabel>
                <span className="price-breakdown-value">
                  {(parts?.additionalExpenses ?? 0).toFixed(2)} ₽
                </span>
              </div>
              <div className="price-breakdown-item price-breakdown-subtotal">
                <span className="price-breakdown-label">Расходы всего</span>
                <span className="price-breakdown-value">
                  {(parts?.expenses ?? 0).toFixed(2)} ₽
                </span>
              </div>
              <div className="price-breakdown-item">
                <BreakdownLabel fromSettings>Целевая чистая прибыль (наценка)</BreakdownLabel>
                <PriceBreakdownValue formula="после налогов · из карточки товара">
                  {(parts?.minMarkup ?? 0).toFixed(2)} ₽
                </PriceBreakdownValue>
              </div>
            </div>
          </div>

          <div className="price-details-section">
            <h3 className="price-details-subtitle">Налоги и прибыль</h3>
            <div className="price-breakdown">
              {profile.vatRate > 0 && (
                <div className="price-breakdown-item">
                  <BreakdownLabel fromSettings>НДС ({vatPctLabel})</BreakdownLabel>
                  <PriceBreakdownValue
                    className="negative"
                    formula={`= ${total.toFixed(2)} × ${vatPctLabel}`}
                  >
                    −{vatAmount.toFixed(2)} ₽
                  </PriceBreakdownValue>
                </div>
              )}
              {profile.incomeTaxRate > 0 && (
                <div className="price-breakdown-item">
                  <BreakdownLabel fromSettings>Налог ({incomeTaxPctLabel})</BreakdownLabel>
                  <PriceBreakdownValue className="negative" formula={incomeTaxFormulaHint}>
                    −{incomeTaxAmount.toFixed(2)} ₽
                  </PriceBreakdownValue>
                </div>
              )}
              {profile.vatRate <= 0 && profile.incomeTaxRate <= 0 && (
                <div className="price-breakdown-item">
                  <span className="price-breakdown-label">Налоги</span>
                  <span className="price-breakdown-value" style={{ color: 'var(--muted)' }}>
                    не заданы в организации товара
                  </span>
                </div>
              )}
              <div className="price-breakdown-item">
                <span className="price-breakdown-label">Чистая прибыль</span>
                <span className={`price-breakdown-value ${netProfit >= 0 ? 'positive' : 'negative'}`}>
                  {netProfit.toFixed(2)} ₽
                </span>
              </div>
              <div className="price-breakdown-item price-breakdown-total">
                <span className="price-breakdown-label">Минимальная цена</span>
                <span className="price-breakdown-value">{total.toFixed(2)} ₽</span>
              </div>
            </div>
            <p style={{ color: 'var(--muted)', fontSize: '12px', margin: '12px 0 0' }}>
              Без комиссий МП. Цена подобрана так, чтобы чистая прибыль после налогов была не ниже целевой наценки.
            </p>
          </div>
        </div>
      </Modal>
    );
  }

  const marketplaceNames = {
    'ozon': 'Ozon',
    'wb': 'Wildberries',
    'ym': 'Yandex Market'
  };

  const schemeNorm = String(priceScheme || '').toUpperCase();
  const schemeLabel =
    schemeNorm === 'FBS' ? 'FBS' :
    schemeNorm === 'FBO' || schemeNorm === 'FBY' || schemeNorm === 'FBW' ? (marketplace === 'ym' ? 'FBY' : 'FBO') :
    null;
  const marketplaceName = marketplaceNames[marketplace] || marketplace;
  const titleScheme = schemeLabel ? ` (${schemeLabel})` : '';

  // Есть ли полноценные данные для детального расчёта (комиссии обязательны; для WB также логика по logistics_base/logistics_liter)
  const hasValidDetails = calculatorData && typeof calculatorData === 'object' && !calculatorData.error &&
    (calculatorData.commissions && typeof calculatorData.commissions === 'object' &&
      (marketplace === 'wb' ? (calculatorData.commissions.FBS != null || calculatorData.commissions.FBO != null) : true));

  // Нет данных калькулятора — показываем сохранённую цену или пояснение, окно не закрываем
  if (!hasValidDetails) {
    const price = priceData != null && priceData !== '' ? Number(priceData) : null;
    const priceOk = price != null && !isNaN(price) && price > 0;
    return (
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        title={`Минимальная цена — ${marketplaceName}${titleScheme}`}
        size="medium"
      >
        <div className="price-details" style={{ padding: '20px' }}>
          <div style={{ marginBottom: '16px', fontSize: '18px', fontWeight: 600 }}>
            {product.sku && <span style={{ color: 'var(--muted)', marginRight: '8px' }}>{product.sku}</span>}
            {product.name || 'Товар'}
          </div>
          {priceOk ? (
            <div style={{ marginBottom: '24px', padding: '16px', background: 'rgba(255,255,255,0.06)', borderRadius: '8px' }}>
              <div style={{ color: 'var(--muted)', fontSize: '13px', marginBottom: '4px' }}>Минимальная рекомендуемая цена</div>
              <div style={{ fontSize: '24px', fontWeight: 700 }}>{Math.round(price)} ₽</div>
            </div>
          ) : (
            <div style={{ marginBottom: '16px', color: 'var(--muted)', fontSize: '14px' }}>
              Для этой схемы сохранённой мин. цены нет.
            </div>
          )}
          <p style={{ color: 'var(--muted)', fontSize: '13px', margin: 0 }}>
            Детальный расчёт (комиссии, логистика, эквайринг) доступен после нажатия «Пересчитать и сохранить все минимальные цены» на странице цен.
          </p>
        </div>
      </Modal>
    );
  }

  const resolvedCalculatorData = enrichCalculatorVolumeFromProduct(
    marketplace === 'ozon'
      ? enrichOzonCalculatorFromProduct(calculatorData, product)
      : calculatorData,
    product,
    marketplace
  );

  // Проверяем, есть ли ошибка в resolvedCalculatorData
  if (resolvedCalculatorData.error) {
    return (
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        title={`⚠️ Ошибка расчета цены для ${marketplaceName}`}
        size="medium"
      >
        <div className="price-details" style={{ padding: '20px', textAlign: 'center' }}>
          <div style={{ color: '#ef4444', fontSize: '18px', marginBottom: '20px' }}>
            ❌ {resolvedCalculatorData.error}
          </div>
          <p style={{ color: '#6b7280', marginTop: '20px' }}>
            Пожалуйста, проверьте настройки склада и попробуйте снова.
          </p>
        </div>
      </Modal>
    );
  }
  
  const calculatedPriceStored = Number(priceData);
  if (!Number.isFinite(calculatedPriceStored) || calculatedPriceStored <= 0) {
    return (
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        title={`Минимальная цена — ${marketplaceName}${titleScheme}`}
        size="medium"
      >
        <div className="price-details" style={{ padding: '20px' }}>
          <div style={{ marginBottom: '16px', fontSize: '18px', fontWeight: 600 }}>
            {product.sku && <span style={{ color: 'var(--muted)', marginRight: '8px' }}>{product.sku}</span>}
            {product.name || 'Товар'}
          </div>
          <p style={{ color: 'var(--muted)', fontSize: '13px', margin: 0 }}>
            Для этой схемы нет сохранённой мин. цены (в базе 0 — заглушка до успешного пересчёта).
            Ночной автопересчёт пишет цену только если есть комиссия категории и себестоимость.
            Нажмите «Пересчитать и сохранить все минимальные цены» на странице цен.
          </p>
        </div>
      </Modal>
    );
  }

  let calculatedPrice = calculatedPriceStored;

  // Извлекаем данные из калькулятора. Схема: priceScheme или дефолт (WB→FBO, остальные→FBS).
  const commissions = resolvedCalculatorData.commissions || {};
  const emptyCommission = { percent: 0, value: 0, delivery_amount: 0, return_amount: 0 };
  const wantFbo = schemeNorm === 'FBO' || schemeNorm === 'FBY' || schemeNorm === 'FBW'
    || (!schemeNorm && marketplace === 'wb');
  const wantFbs = schemeNorm === 'FBS' || (!schemeNorm && marketplace !== 'wb');

  let commission;
  if (marketplace === 'wb') {
    const wbBase = wantFbs
      ? (commissions.FBS || commissions.FBO || emptyCommission)
      : (commissions.FBO || commissions.FBS || emptyCommission);
    commission = { ...wbBase, delivery_amount: 0 };
  } else if (wantFbo) {
    commission = commissions.FBO || commissions.FBS || emptyCommission;
  } else {
    commission = commissions.FBS || commissions.FBO || emptyCommission;
  }
  
  if (marketplace === 'wb') {
    console.log(`[PriceDetailsModal] WB commission: FBO=${commissions.FBO?.percent}% FBS=${commissions.FBS?.percent}% → using ${commission.percent}%`);
  }
  
  // Преобразуем все значения в числа для безопасных вычислений
  // ВАЖНО: База расходов должна совпадать с расчётом на странице цен:
  // себестоимость (cost/price/base_price) + дополнительные расходы (additionalExpenses).
  const costBase = Number(product.cost ?? product.price ?? product.base_price ?? 0) || 0;
  const additionalExpenses = Number(product.additionalExpenses ?? product.additional_expenses ?? 0) || 0;
  const basePrice = costBase + additionalExpenses;
  
  // Фиксированные расходы (преобразуем в числа)
  // WB / Ozon: процент эквайринга из настроек интеграции, если задан; иначе из API/калькулятора
  let acquiring = 0;
  if (marketplace === 'wb' && wbAcquiringPercent !== null && wbAcquiringPercent !== undefined) {
    acquiring = Number(wbAcquiringPercent) || 0;
    console.log(`[PriceDetailsModal] WB acquiring percent from settings: ${acquiring}%`);
  } else if (marketplace === 'ozon' && ozonAcquiringPercent !== null && ozonAcquiringPercent !== undefined) {
    acquiring = Number(ozonAcquiringPercent) || 0;
    console.log(`[PriceDetailsModal] Ozon acquiring percent from settings: ${acquiring}%`);
  } else {
    acquiring = Number(resolvedCalculatorData.acquiring) || 0;
  }
  // Обработка заказа: используем значение из API
  console.log(`[PriceDetailsModal] ========== PROCESSING COST DEBUG ==========`);
  console.log(`[PriceDetailsModal] calculator keys:`, resolvedCalculatorData && Object.keys(resolvedCalculatorData));
  console.log(`[PriceDetailsModal] resolvedCalculatorData.processing_cost:`, resolvedCalculatorData.processing_cost);
  console.log(`[PriceDetailsModal] resolvedCalculatorData.processing_cost type:`, typeof resolvedCalculatorData.processing_cost);
  console.log(`[PriceDetailsModal] resolvedCalculatorData.commissions:`, resolvedCalculatorData.commissions);
  console.log(`[PriceDetailsModal] resolvedCalculatorData.commissions.FBS:`, resolvedCalculatorData.commissions?.FBS);
  console.log(`[PriceDetailsModal] resolvedCalculatorData.commissions.FBS?.first_mile_amount:`, resolvedCalculatorData.commissions?.FBS?.first_mile_amount);
  
  // Обработка заказа: Ozon — из API; YM — SORTING; WB — нет
  let processingCost = 0;
  let processingCostMax = null;
  if (marketplace === 'ozon' && wantFbo) {
    processingCost = 0;
  } else if (marketplace === 'ozon') {
    processingCost = resolvedCalculatorData.processing_cost !== undefined && resolvedCalculatorData.processing_cost !== null
      ? Number(resolvedCalculatorData.processing_cost)
      : 0;
    processingCostMax = toFiniteNumber(resolvedCalculatorData.processing_cost_max)
      ?? toFiniteNumber(commission.first_mile_amount_max);
    if (processingCostMax != null) processingCostMax = Math.round(processingCostMax);
    console.log(`[PriceDetailsModal] Ozon processing cost (from API): ${processingCost}`);
  } else if (marketplace === 'ym') {
    processingCost = resolvedCalculatorData.processing_cost !== undefined && resolvedCalculatorData.processing_cost !== null
      ? Number(resolvedCalculatorData.processing_cost)
      : 0;
    console.log(`[PriceDetailsModal] YM processing cost (SORTING): ${processingCost}`);
  }
  console.log(`[PriceDetailsModal] =========================================`);
  
  // Логистика: пересчитываем для WB с учетом округления, для других маркетплейсов используем значение из API
  let logisticsCost = 0;
  let logisticsCostMax = null;
  const wbSchemeKey = wantFbo ? 'fbo' : 'fbs';
  const wbLogisticsBase = toFiniteNumber(resolvedCalculatorData[`logistics_base_${wbSchemeKey}`])
    ?? toFiniteNumber(resolvedCalculatorData.logistics_base);
  const wbLogisticsLiter = toFiniteNumber(resolvedCalculatorData[`logistics_liter_${wbSchemeKey}`])
    ?? toFiniteNumber(resolvedCalculatorData.logistics_liter);
  const wbLogisticsPrecomputed = toFiniteNumber(resolvedCalculatorData[`logistics_cost_${wbSchemeKey}`])
    ?? toFiniteNumber(resolvedCalculatorData.logistics_cost);
  const wbLocalizationFromSettings = wbLocalizationIndex != null && wbLocalizationIndex !== '';
  let wbLogisticsLocalizationIndex = 1;
  if (wbLocalizationFromSettings) {
    const n = Number(wbLocalizationIndex);
    wbLogisticsLocalizationIndex = Number.isFinite(n) && n > 0 ? n : 1;
  } else {
    const n = Number(resolvedCalculatorData.logistics_localization_index);
    wbLogisticsLocalizationIndex = Number.isFinite(n) && n > 0 ? n : 1;
  }
  if (marketplace === 'wb' && wbLogisticsBase != null) {
    const volume = resolveEffectiveVolumeLiters(resolvedCalculatorData, product, marketplace) || 0;
    const liter = wbLogisticsLiter ?? 0;
    let volumeCost;
    if (volume > 1) {
      volumeCost = wbLogisticsBase + liter * Math.ceil(volume - 1);
    } else if (volume > 0) {
      volumeCost = wbLogisticsBase;
    } else {
      logisticsCost = wbLogisticsPrecomputed != null && wbLogisticsPrecomputed > 0
        ? wbLogisticsPrecomputed
        : wbLogisticsBase;
      volumeCost = null;
    }
    if (volumeCost != null) {
      logisticsCost = Math.round(volumeCost * wbLogisticsLocalizationIndex * 100) / 100;
    }
  } else if (marketplace === 'ozon') {
    const ozonRaw = resolvedCalculatorData.fullCommissions || resolvedCalculatorData.rawCommissions || {};
    if (wantFbo) {
      const fboMin = toFiniteNumber(commission.direct_flow_trans_amount)
        ?? toFiniteNumber(resolvedCalculatorData.logistics_cost_fbo)
        ?? 0;
      logisticsCost = fboMin > 0 ? Math.round(fboMin) : 0;
      logisticsCostMax = toFiniteNumber(commission.direct_flow_trans_amount_max)
        ?? toFiniteNumber(resolvedCalculatorData.logistics_cost_fbo_max)
        ?? toFiniteNumber(ozonRaw.fbo_direct_flow_trans_max_amount);
    } else {
      logisticsCost = resolvedCalculatorData.logistics_cost !== undefined && resolvedCalculatorData.logistics_cost !== null
        ? Number(resolvedCalculatorData.logistics_cost)
        : 0;
      if (logisticsCost > 0) {
        const logisticsCostBefore = logisticsCost;
        logisticsCost = Math.round(logisticsCost);
        console.log(`[PriceDetailsModal] Ozon logistics cost rounded: ${logisticsCostBefore} → ${logisticsCost}`);
      }
      logisticsCostMax = toFiniteNumber(commission.direct_flow_trans_amount_max)
        ?? toFiniteNumber(resolvedCalculatorData.logistics_cost_max)
        ?? toFiniteNumber(ozonRaw.fbs_direct_flow_trans_max_amount);
    }
    if (logisticsCostMax != null && logisticsCostMax > 0) {
      logisticsCostMax = Math.round(logisticsCostMax);
    }
    if (logisticsCostMax != null && logisticsCostMax <= logisticsCost) {
      logisticsCostMax = null;
    }
    if (processingCostMax != null && processingCostMax <= processingCost) {
      processingCostMax = null;
    }
  } else {
    logisticsCost = resolvedCalculatorData.logistics_cost !== undefined && resolvedCalculatorData.logistics_cost !== null
      ? Number(resolvedCalculatorData.logistics_cost)
      : 0;
  }
  logisticsCost = Number(logisticsCost);
  if (!Number.isFinite(logisticsCost)) logisticsCost = 0;
  
  // Доставка до клиента: для YM пересчитываем по valueType (relative = % от цены, absolute = фикс.)
  let deliveryToCustomer = (commission.delivery_amount !== undefined && commission.delivery_amount !== null)
    ? Number(commission.delivery_amount)
    : 0;
  if (marketplace === 'ym' && resolvedCalculatorData.ymTariffs) {
    const d = resolvedCalculatorData.ymTariffs.DELIVERY_TO_CUSTOMER;
    const cr = resolvedCalculatorData.ymTariffs.CROSSREGIONAL_DELIVERY;
    const ex = resolvedCalculatorData.ymTariffs.EXPRESS_DELIVERY;
    const atPrice = (t) => {
      if (!t) return 0;
      const vt = (t.valueType || 'absolute').toLowerCase();
      const v = Number(t.value) || Number(t.amount) || 0;
      return vt === 'relative' ? (calculatedPrice * (v / 100)) : v;
    };
    deliveryToCustomer = atPrice(d) + atPrice(cr) + atPrice(ex);
  }

  const buyoutRateInput = resolveMarketplaceBuyoutRate(product, marketplace);
  const buyoutRate = buyoutRateInput != null ? buyoutRateInput / 100 : 1;
  const returnRate = buyoutRateInput != null && buyoutRateInput < 100 ? (1 - buyoutRate) : 0;
  const buyoutPercentLabel =
    buyoutRateInput != null && buyoutRateInput < 100
      ? `выкуп ${Math.round(buyoutRateInput)}%`
      : null;

  console.log(`[PriceDetailsModal] Reverse logistics inputs for ${marketplace}:`, {
    buyoutRateFromProduct: buyoutRateInput,
    buyoutRateInput,
    returnRate: (returnRate * 100).toFixed(2) + '%',
    basePrice
  });

  let returnAmountAtMax = 0;
  let returnProcessingAtMax = 0;
  if (returnRate > 0) {
    if (commission.return_amount !== undefined && commission.return_amount !== null) {
      returnAmountAtMax = Number(commission.return_amount);
    }
    returnProcessingAtMax =
      commission.return_processing_amount !== undefined && commission.return_processing_amount !== null
        ? Number(commission.return_processing_amount)
        : 0;
  }
  
  // Комиссия за продвижение бренда — из API или настроек бренда
  const brandPromotionPercent = (resolvedCalculatorData.brand_promotion_percent != null && !isNaN(Number(resolvedCalculatorData.brand_promotion_percent)))
    ? Number(resolvedCalculatorData.brand_promotion_percent) / 100
    : 0;
  const adsPromotionPercent = (resolvedCalculatorData.ads_promotion_percent != null && !isNaN(Number(resolvedCalculatorData.ads_promotion_percent)))
    ? Number(resolvedCalculatorData.ads_promotion_percent) / 100
    : 0;
  
  const productVolume = resolveEffectiveVolumeLiters(resolvedCalculatorData, product, marketplace) || 0;
  
  // Обработка отправления (fbs_first_mile_min_amount) - отдельная статья расходов
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
    calculatorLogisticsCost: resolvedCalculatorData.logistics_cost,
    resolvedCalculatorData: resolvedCalculatorData
  });
  
  // Проценты. YM: полная ставка размещения + скидка за раннюю отгрузку отдельной строкой.
  // Источник истины — настройки интеграции YM. Не показываем «запечённую» скидку из
  // calculation_details / кэша калькулятора, если поле в интеграциях очищено.
  const settingsEarlyPp =
    marketplace === 'ym' && ymEarlyShipmentDiscountPp != null && ymEarlyShipmentDiscountPp !== ''
      ? Number(ymEarlyShipmentDiscountPp)
      : NaN;
  const metaEarlyPp =
    marketplace === 'ym'
      ? Number(commission.early_shipment_discount_pp ?? resolvedCalculatorData.early_shipment_discount_pp)
      : NaN;
  const earlyShipmentDiscountPp =
    Number.isFinite(settingsEarlyPp) && settingsEarlyPp > 0 ? settingsEarlyPp : 0;

  const commissionPercentBefore = Number(commission.percent_before_early_shipment);
  const storedCommissionPercent = Number(commission.percent) || 0;
  let commissionDisplayPercent = storedCommissionPercent;
  let commissionNetPercent = storedCommissionPercent;
  if (earlyShipmentDiscountPp > 0) {
    if (Number.isFinite(commissionPercentBefore)) {
      // Детали после пересчёта: percent уже нетто, before — полная ставка
      commissionDisplayPercent = commissionPercentBefore;
      commissionNetPercent = storedCommissionPercent;
    } else if (Number.isFinite(metaEarlyPp) && metaEarlyPp > 0) {
      commissionDisplayPercent = storedCommissionPercent + earlyShipmentDiscountPp;
      commissionNetPercent = storedCommissionPercent;
    } else {
      // Только из настроек: в сохранённых деталях ещё полная ставка API
      commissionDisplayPercent = storedCommissionPercent;
      commissionNetPercent = Math.max(0, storedCommissionPercent - earlyShipmentDiscountPp);
    }
  } else if (marketplace === 'ym' && Number.isFinite(commissionPercentBefore) && commissionPercentBefore > 0) {
    // Скидка в интеграциях очищена, но в details ещё «запечён» нетто — показываем живую базу
    commissionDisplayPercent = commissionPercentBefore;
    commissionNetPercent = commissionPercentBefore;
  }
  const marketplaceCommissionPercent = commissionNetPercent / 100;
  const acquiringPercent = (acquiring || 0) / 100;
  
  // Процент услуг Джем (только для WB, вычисляется от суммы товара)
  let gemServicesPercent = 0;
  if (marketplace === 'wb' && wbGemServicesPercent !== null && wbGemServicesPercent !== undefined) {
    gemServicesPercent = (Number(wbGemServicesPercent) || 0) / 100;
    console.log(`[PriceDetailsModal] WB gem services percent from settings: ${wbGemServicesPercent}% (${gemServicesPercent})`);
  }

  const profile = taxProfile || taxProfileForProduct(null, product) || resolveOrganizationTaxProfile(null);
  const targetProfit = resolveMarketplaceMinProfit(product, marketplace, null);
  if (marketplace !== 'ym' && targetProfit != null && targetProfit >= 0) {
    let calcForSolve = marketplace === 'ozon' && ozonAcquiringPercent != null
      ? { ...resolvedCalculatorData, acquiring: Number(ozonAcquiringPercent) || 0 }
      : resolvedCalculatorData;
    if (marketplace === 'wb') {
      calcForSolve = {
        ...calcForSolve,
        logistics_localization_index: wbLogisticsLocalizationIndex,
      };
    }
    const solved = calculateMinPrice(
      basePrice,
      calcForSolve,
      marketplace,
      targetProfit,
      product,
      wbAcquiringPercent,
      wbGemServicesPercent,
      profile,
      priceScheme,
      wbSppPercent
    );
    if (solved != null) calculatedPrice = solved;
  }

  let ozonReturnMeta = null;
  let returnAmount = returnAmountAtMax;
  if (marketplace === 'ozon' && returnRate > 0) {
    const ozonLogistics = resolveOzonLogisticsCostsForReturn(resolvedCalculatorData, commission, priceScheme);
    const lc = ozonLogistics.logisticsCost > 0 ? ozonLogistics.logisticsCost : logisticsCost;
    const lcMax = ozonLogistics.logisticsCostMax ?? logisticsCostMax;
    ozonReturnMeta = computeOzonReturnUnitAmount(lc, lcMax, returnAmountAtMax);
    returnAmount = ozonReturnMeta.unitAmount;
  }
  const returnCost = returnAmount * returnRate;
  const returnProcessingCost = returnProcessingAtMax * returnRate;
  
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
  const commissionGrossAmount = calculatedPrice * (commissionDisplayPercent / 100);
  const earlyShipmentDiscountAmount =
    earlyShipmentDiscountPp > 0 ? calculatedPrice * (earlyShipmentDiscountPp / 100) : 0;
  // Ozon: эквайринг = price × % с округлением до копеек (не ceil)
  let acquiringAmount = calculatedPrice * acquiringPercent;
  if (marketplace === 'ozon') {
    acquiringAmount = Math.round(acquiringAmount * 100) / 100;
  }
  const brandPromotionAmount = calculatedPrice * brandPromotionPercent;
  const adsPromotionAmount = calculatedPrice * adsPromotionPercent;
  const gemServicesAmount = calculatedPrice * gemServicesPercent;
  const fixedExpenses = processingCost + logisticsCost + deliveryToCustomer + returnCost + returnProcessingCost;

  // Для YM: приём (AGENCY_COMMISSION) и перевод (PAYMENT_TRANSFER) — считаем по valueType из API
  // absolute = фиксированная сумма в ₽, relative = процент от цены
  let ymAgencyDisplay = 0;
  let ymPaymentTransferDisplay = 0;
  if (marketplace === 'ym' && resolvedCalculatorData.ymTariffs) {
    const agency = resolvedCalculatorData.ymTariffs.AGENCY_COMMISSION;
    const payment = resolvedCalculatorData.ymTariffs.PAYMENT_TRANSFER;
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
  const totalExpenses = commissionAmount + effectiveAcquiringAmount + brandPromotionAmount + adsPromotionAmount + gemServicesAmount + fixedExpenses + basePrice;
  const profit = calculatedPrice - totalExpenses;
  const profitPercent = calculatedPrice > 0 ? (profit / calculatedPrice) * 100 : 0;

  const sppPercent = resolveWbSppPercent(marketplace, wbSppPercent);
  const sellingPriceAfterSpp = Math.round(calculatedPrice * (1 - sppPercent / 100) * 100) / 100;

  // Налоги от цены продажи после СПП (для не-WB sellingPrice = calculatedPrice)
  const taxBreakdown = computeTaxesAndNetProfit({
    price: sellingPriceAfterSpp,
    totalExpenses,
    taxProfile: profile,
  });
  const vatAmount = taxBreakdown.vat;
  const incomeTaxAmount = taxBreakdown.incomeTax;
  const netProfit = taxBreakdown.netProfit;
  const netProfitPercent = sellingPriceAfterSpp > 0 ? (netProfit / sellingPriceAfterSpp) * 100 : 0;
  
  // Отладочное логирование обратной логистики
  console.log(`[PriceDetailsModal] Final reverse logistics calculation:`, {
    marketplace,
    buyoutRate: buyoutRateInput,
    returnRate: (returnRate * 100).toFixed(2) + '%',
    returnCost: returnCost.toFixed(2),
    returnProcessingCost: returnProcessingCost.toFixed(2),
    totalReverseLogistics: (returnCost + returnProcessingCost).toFixed(2),
    fixedExpenses: fixedExpenses.toFixed(2),
    basePrice: basePrice.toFixed(2),
    totalExpenses: totalExpenses.toFixed(2)
  });
  
  const vatPctLabel = profile.vatRate > 0 ? `${(profile.vatRate * 100).toFixed(0)}%` : '0%';
  const incomeTaxPctLabel =
    profile.incomeTaxRate > 0
      ? profile.incomeTaxOnRevenue
        ? `УСН ${(profile.incomeTaxRate * 100).toFixed(0)}% с выручки`
        : `УСН ${(profile.incomeTaxRate * 100).toFixed(0)}% с прибыли`
      : 'не указан в организации';
  const incomeTaxPct = profile.incomeTaxRate > 0 ? `${(profile.incomeTaxRate * 100).toFixed(0)}%` : '0%';
  const profitBeforeIncomeTax = taxBreakdown.profitBeforeIncomeTax;
  const incomeTaxFormulaHint = (() => {
    if (profile.incomeTaxRate <= 0) return null;
    if (profile.incomeTaxOnRevenue) {
      return `= ${sellingPriceAfterSpp.toFixed(2)} × ${incomeTaxPct} = ${incomeTaxAmount.toFixed(2)} ₽ (от цены продажи)`;
    }
    const base = profitBeforeIncomeTax.toFixed(2);
    if (profitBeforeIncomeTax <= 0) {
      return `= ${base} × ${incomeTaxPct} = 0 ₽ (прибыль до налога не положительная)`;
    }
    return `= ${base} × ${incomeTaxPct} = ${incomeTaxAmount.toFixed(2)} ₽ (прибыль до налога: цена продажи − расходы − НДС)`;
  })();

  const extraOzonFixed =
    marketplace === 'ozon'
      ? (logisticsCostMax != null && logisticsCostMax > logisticsCost ? logisticsCostMax - logisticsCost : 0)
        + (processingCostMax != null && processingCostMax > processingCost ? processingCostMax - processingCost : 0)
      : 0;
  let maxCalculatedPrice = null;
  if (extraOzonFixed > 0 && calculatedPrice > 0) {
    const variableRate =
      marketplaceCommissionPercent + acquiringPercent + brandPromotionPercent + adsPromotionPercent;
    const vatR = Number(profile.vatRate) || 0;
    const incR = Number(profile.incomeTaxRate) || 0;
    let seedDenom = profile.incomeTaxOnRevenue
      ? 1 - variableRate - vatR - incR
      : 1 - variableRate - vatR;
    if (!(seedDenom > 0.01)) seedDenom = Math.max(0.15, 1 - variableRate);
    const estimated = Math.round(calculatedPrice + extraOzonFixed / seedDenom);
    if (estimated > calculatedPrice) maxCalculatedPrice = estimated;
  }

  const isEstimatedTariffs = marketplace === 'wb' && resolvedCalculatorData._estimatedTariffs;

  const headerVolume = resolveEffectiveVolumeLiters(resolvedCalculatorData, product, marketplace) || 0;
  const wbCmDims =
    marketplace === 'wb'
      ? resolveWbLogisticsDimensionsCm(product) ||
        (resolvedCalculatorData?.wb_logistics_cm
          ? {
              length: Number(resolvedCalculatorData.wb_logistics_cm.length),
              width: Number(resolvedCalculatorData.wb_logistics_cm.width),
              height: Number(resolvedCalculatorData.wb_logistics_cm.height),
            }
          : null)
      : null;
  const volumeLabel =
    headerVolume > 0
      ? wbCmDims && wbCmDims.length > 0
        ? `${headerVolume.toFixed(2)} л (${wbCmDims.length}×${wbCmDims.width}×${wbCmDims.height} см)`
        : `${headerVolume.toFixed(2)} л`
      : 'нет габаритов';

  const acquiringFromSettings =
    (marketplace === 'wb' && wbAcquiringPercent != null && wbAcquiringPercent !== undefined) ||
    (marketplace === 'ozon' && ozonAcquiringPercent != null && ozonAcquiringPercent !== undefined);
  const brandFromSettings =
    marketplace === 'ozon' && resolvedCalculatorData.brand_promotion_source !== 'api';
  const adsFromSettings =
    marketplace === 'ozon' && resolvedCalculatorData.ads_promotion_source !== 'ads';
  const ymPaymentFromSettings = !!resolvedCalculatorData.ymTariffs?.PAYMENT_TRANSFER?.fromSettings;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`💰 Расчёт минимальной цены · ${marketplaceName}${titleScheme}`}
      size="large"
    >
      <div className="price-details">
        <div className="price-details-header" style={{ marginBottom: '16px', padding: '12px 16px', background: 'rgba(255,255,255,0.06)', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.1)', fontSize: '14px' }}>
          <span><strong>Артикул:</strong> {product.sku || '—'}</span>
          <span style={{ marginLeft: '16px' }}><strong>Название:</strong> {product.name || 'Без названия'}</span>
          <span style={{ marginLeft: '16px' }}><strong>Объём:</strong>{' '}
            {volumeLabel}
          </span>
        </div>
        {isEstimatedTariffs && (
          <div style={{ marginBottom: '16px', padding: '12px', background: 'rgba(251, 191, 36, 0.15)', borderRadius: '8px', border: '1px solid rgba(251, 191, 36, 0.3)', color: '#d97706', fontSize: '13px' }}>
            ⚠️ Ориентировочный расчёт: тарифы Wildberries не загружены. Обновите тарифы в настройках интеграции (кнопка «Тарифы») для точного расчёта логистики и комиссий.
          </div>
        )}
        <div className="price-details-section">
          <h3 className="price-details-subtitle">💵 Расходы и расчёт цены</h3>
          <div className="price-breakdown-source-legend">
            <span className="price-breakdown-manual-mark">!</span>
            {' '}— значение из настроек или карточки товара (не из API маркетплейса)
          </div>
          <div className="price-breakdown">
            <div className="price-breakdown-item">
              <BreakdownLabel fromSettings>Себестоимость:</BreakdownLabel>
              <PriceBreakdownValue
                formula={
                  costBase > 0
                    ? `= ${costBase.toFixed(2)} ₽ ${
                        product.cost != null && product.cost !== '' && !isNaN(Number(product.cost)) && Number(product.cost) > 0
                          ? '(из карточки товара, себестоимость)'
                          : product.price != null && product.price !== '' && !isNaN(Number(product.price)) && Number(product.price) > 0
                            ? '(из цены товара)'
                            : '(из базовой цены)'
                      }`
                    : undefined
                }
              >
                {costBase > 0 ? `${costBase.toFixed(2)} ₽` : '— не указана'}
              </PriceBreakdownValue>
            </div>

            <div className="price-breakdown-item">
              <BreakdownLabel fromSettings>Дополнительные расходы:</BreakdownLabel>
              <PriceBreakdownValue
                formula={
                  additionalExpenses > 0
                    ? `= ${additionalExpenses.toFixed(2)} ₽ (из карточки товара)`
                    : '— не указаны'
                }
              >
                {additionalExpenses > 0 ? `${additionalExpenses.toFixed(2)} ₽` : '—'}
              </PriceBreakdownValue>
            </div>

            <div className="price-breakdown-item">
              <BreakdownLabel fromSettings>База (себестоимость + доп.):</BreakdownLabel>
              <PriceBreakdownValue
                formula={
                  basePrice > 0
                    ? `= ${costBase.toFixed(2)} + ${additionalExpenses.toFixed(2)} = ${basePrice.toFixed(2)} ₽`
                    : undefined
                }
              >
                {basePrice > 0 ? `${basePrice.toFixed(2)} ₽` : '—'}
              </PriceBreakdownValue>
            </div>
            
            {processingCost > 0 && (
              <div className="price-breakdown-item">
                <span className="price-breakdown-label">Обработка заказа:</span>
                <PriceBreakdownValue
                  formula={
                    marketplace === 'ozon'
                      ? processingCostMax != null
                        ? `В расчёт: ${processingCost.toFixed(2)} ₽ (min). Макс. из API: ${processingCostMax.toFixed(2)} ₽`
                        : `= ${processingCost.toFixed(2)} ₽ (fbs_first_mile_min_amount из API Ozon)`
                      : marketplace === 'ym'
                        ? `= ${processingCost.toFixed(2)} ₽ (тариф YM SORTING — обработка заказа)`
                        : `= ${processingCost.toFixed(2)} ₽ (из API)`
                  }
                  extra={
                    marketplace === 'ozon' && processingCostMax != null ? (
                      <PriceRangeMax
                        amount={processingCostMax}
                        title="Максимальный тариф API; в расчёт берётся минимум"
                      />
                    ) : null
                  }
                >
                  {processingCost.toFixed(2)} ₽
                </PriceBreakdownValue>
              </div>
            )}
            
            <div className="price-breakdown-item">
              <BreakdownLabel fromSettings={marketplace === 'wb'}>
                Логистика
                {productVolume > 0
                  ? wbCmDims && wbCmDims.length > 0
                    ? ` (${productVolume.toFixed(2)} л, ${wbCmDims.length}×${wbCmDims.width}×${wbCmDims.height} см)`
                    : ` (${productVolume.toFixed(2)} л)`
                  : ''}
                :
              </BreakdownLabel>
              <PriceBreakdownValue
                formula={
                  marketplace === 'wb' && wbLogisticsBase != null
                    ? (() => {
                        const volume = productVolume;
                        const base = wbLogisticsBase;
                        const liter = wbLogisticsLiter ?? 0;
                        const il = wbLogisticsLocalizationIndex;
                        if (!(base > 0) && !(liter > 0)) {
                          return '= 0 ₽ (в тарифах склада нет базовой ставки)';
                        }
                        const ilSuffix = wbLocalizationFromSettings
                          ? `ИЛ ${il} (настройки интеграции)`
                          : `ИЛ ${il}`;
                        if (!volume || volume <= 1) {
                          const withIl = Math.round(base * il * 100) / 100;
                          return `= ${base.toFixed(2)} × ${ilSuffix} = ${withIl.toFixed(2)} ₽`;
                        }
                        const additionalLiters = Math.ceil(volume - 1);
                        const volumeCost = base + liter * additionalLiters;
                        const withIl = Math.round(volumeCost * il * 100) / 100;
                        return `= (${base.toFixed(2)} + ${liter.toFixed(2)} × ${additionalLiters} л) × ${ilSuffix} = ${withIl.toFixed(2)} ₽`;
                      })()
                    : marketplace === 'ozon'
                      ? logisticsCostMax != null
                        ? `В расчёт: ${logisticsCost.toFixed(2)} ₽ (min). Макс. из API: ${logisticsCostMax.toFixed(2)} ₽`
                        : `= ${logisticsCost.toFixed(2)} ₽ (${wantFbo ? 'fbo' : 'fbs'}_direct_flow_trans_min_amount из API Ozon)`
                      : `= ${logisticsCost.toFixed(2)} ₽ (из API YM)`
                }
                extra={
                  marketplace === 'ozon' && logisticsCostMax != null ? (
                    <PriceRangeMax
                      amount={logisticsCostMax}
                      title="Максимальный тариф логистики API; в расчёт берётся минимум"
                    />
                  ) : null
                }
              >
                {logisticsCost.toFixed(2)} ₽
              </PriceBreakdownValue>
            </div>
            
            {deliveryToCustomer > 0 && (
              <div className="price-breakdown-item">
                <span className="price-breakdown-label">Доставка до клиента:</span>
                <PriceBreakdownValue
                  formula={`= ${deliveryToCustomer.toFixed(2)} ₽ ${marketplace === 'ozon' ? '(fbs_deliv_to_customer_amount из API Ozon)' : marketplace === 'ym' ? '(тарифы YM: доставка до клиента + кросс-регион + экспресс, % или фикс.)' : '(из API)'}`}
                >
                  {deliveryToCustomer.toFixed(2)} ₽
                </PriceBreakdownValue>
              </div>
            )}
            
            {returnRate > 0 && (returnCost > 0 || returnProcessingCost > 0) && (
              <>
                {returnCost > 0 && (
                  <div className="price-breakdown-item">
                    <span
                      className="price-breakdown-label"
                      title={
                        buyoutRateInput != null
                          ? `% выкупа по ${marketplace.toUpperCase()} из карточки товара (обновляется раз в сутки из API маркетплейса)`
                          : undefined
                      }
                    >
                      Обратная логистика
                      {buyoutPercentLabel ? ` (${buyoutPercentLabel})` : ''}:
                    </span>
                    <PriceBreakdownValue
                      className="negative"
                      formula={
                        marketplace === 'ozon' &&
                        returnRate > 0 &&
                        ozonReturnMeta?.logisticsMax &&
                        ozonReturnMeta.logisticsMin > 0
                          ? `= (${ozonReturnMeta.logisticsMin.toFixed(0)} + ${ozonReturnMeta.logisticsMax.toFixed(0)}) / 2 × ${(returnRate * 100).toFixed(1)}% невыкупа = ${returnCost.toFixed(2)} ₽`
                          : marketplace === 'wb'
                            ? `= ${returnAmount.toFixed(2)} ₽ (базовый тариф по объёму, без коэф. склада) × ${(returnRate * 100).toFixed(1)}% невыкупа = ${returnCost.toFixed(2)} ₽`
                            : `= ${returnAmount.toFixed(2)} × ${(returnRate * 100).toFixed(1)}% невыкупа = ${returnCost.toFixed(2)} ₽`
                      }
                    >
                      -{returnCost.toFixed(2)} ₽
                    </PriceBreakdownValue>
                  </div>
                )}
                {returnProcessingCost > 0 && (
                  <div className="price-breakdown-item">
                    <span className="price-breakdown-label">Обработка обратной логистики:</span>
                    <PriceBreakdownValue
                      className="negative"
                      formula={`= ${returnProcessingCost.toFixed(2)} ₽ (из API × ${(returnRate * 100).toFixed(1)}% невыкупа)`}
                    >
                      -{returnProcessingCost.toFixed(2)} ₽
                    </PriceBreakdownValue>
                  </div>
                )}
              </>
            )}
            
            <div className="price-breakdown-item">
              <span className="price-breakdown-label">
                Комиссия {marketplaceName}{marketplace === 'wb' ? ' (FBO)' : ''} ({commissionDisplayPercent}%):
              </span>
              <PriceBreakdownValue
                className="negative"
                formula={
                  `= ${calculatedPrice.toFixed(2)} × ${Number(commissionDisplayPercent).toFixed(2)}% = ${commissionGrossAmount.toFixed(2)} ₽` +
                  (marketplace === 'wb'
                    ? ' — схема FBO/FBW (Склад WB, paidStorageKgvp), по категории из API WB'
                    : '')
                }
                extra={
                  marketplace === 'wb' && commissions.FBS && commissions.FBS.percent !== commission.percent ? (
                    <div style={{fontSize: '9px', color: '#64748b', marginTop: '2px', fontStyle: 'italic', whiteSpace: 'normal'}}>
                      FBS комиссия ({commissions.FBS.percent}%) справочно, в расчёт мин. цены не входит
                    </div>
                  ) : null
                }
              >
                -{commissionGrossAmount.toFixed(2)} ₽
              </PriceBreakdownValue>
            </div>

            {marketplace === 'ym' && earlyShipmentDiscountPp > 0 && (
              <div className="price-breakdown-item">
                <BreakdownLabel fromSettings>
                  Скидка за раннюю отгрузку (−{earlyShipmentDiscountPp} п.п.):
                </BreakdownLabel>
                <PriceBreakdownValue
                  className="positive"
                  formula={`= ${calculatedPrice.toFixed(2)} × ${earlyShipmentDiscountPp.toFixed(2)}% = ${earlyShipmentDiscountAmount.toFixed(2)} ₽ (комиссия ${commissionDisplayPercent}% → ${commissionNetPercent}%)`}
                >
                  +{earlyShipmentDiscountAmount.toFixed(2)} ₽
                </PriceBreakdownValue>
              </div>
            )}
            
            {marketplace === 'ym' && (acquiringAmount > 0 || resolvedCalculatorData.acquiring != null || (resolvedCalculatorData.ymTariffs && (resolvedCalculatorData.ymTariffs.AGENCY_COMMISSION || resolvedCalculatorData.ymTariffs.PAYMENT_TRANSFER))) && (
              <>
                <div className="price-breakdown-item">
                  <span className="price-breakdown-label">Приём платежа покупателя:</span>
                  <PriceBreakdownValue
                    className="negative"
                    formula={
                      resolvedCalculatorData.ymTariffs?.AGENCY_COMMISSION?.valueType === 'relative'
                        ? `= ${calculatedPrice.toFixed(2)} × ${(Number(resolvedCalculatorData.ymTariffs.AGENCY_COMMISSION?.value) || 0).toFixed(2)}% = ${ymAgencyDisplay.toFixed(2)} ₽`
                        : `= ${ymAgencyDisplay.toFixed(2)} ₽ (фиксированная сумма)`
                    }
                  >
                    -{ymAgencyDisplay.toFixed(2)} ₽
                  </PriceBreakdownValue>
                </div>
                <div className="price-breakdown-item">
                  <BreakdownLabel fromSettings={ymPaymentFromSettings}>
                    Перевод платежа покупателя:
                  </BreakdownLabel>
                  <PriceBreakdownValue
                    className="negative"
                    formula={
                      resolvedCalculatorData.ymTariffs?.PAYMENT_TRANSFER?.valueType === 'relative'
                        ? `= ${calculatedPrice.toFixed(2)} × ${(Number(resolvedCalculatorData.ymTariffs.PAYMENT_TRANSFER?.value) || 0).toFixed(2)}% = ${ymPaymentTransferDisplay.toFixed(2)} ₽${resolvedCalculatorData.ymTariffs.PAYMENT_TRANSFER?.fromSettings ? ' (из настроек)' : ''}`
                        : `= ${ymPaymentTransferDisplay.toFixed(2)} ₽ (фиксированная сумма)`
                    }
                  >
                    -{ymPaymentTransferDisplay.toFixed(2)} ₽
                  </PriceBreakdownValue>
                </div>
              </>
            )}
            {marketplace !== 'ym' && (acquiringAmount > 0 || (marketplace === 'wb' && (acquiring > 0 || wbAcquiringPercent != null)) || (marketplace === 'ozon' && resolvedCalculatorData.acquiring != null)) && (
              <div className="price-breakdown-item">
                <BreakdownLabel fromSettings={acquiringFromSettings}>
                  Эквайринг ({acquiring != null ? Number(acquiring).toFixed(2) : 0}%):
                </BreakdownLabel>
                <PriceBreakdownValue
                  className="negative"
                  formula={
                    `= ${calculatedPrice.toFixed(2)} × ${(acquiringPercent * 100).toFixed(2)}% = ${acquiringAmount.toFixed(2)} ₽` +
                    (marketplace === 'wb' && wbAcquiringPercent != null ? ' (из настроек интеграции)' : '')
                  }
                >
                  -{acquiringAmount.toFixed(2)} ₽
                </PriceBreakdownValue>
              </div>
            )}
            
            {(gemServicesAmount > 0 || (marketplace === 'wb' && wbGemServicesPercent !== null && wbGemServicesPercent !== undefined)) && (
              <div className="price-breakdown-item">
                <BreakdownLabel fromSettings>
                  Услуги Джем ({wbGemServicesPercent || 0}%):
                </BreakdownLabel>
                <PriceBreakdownValue
                  className="negative"
                  formula={
                    `= ${calculatedPrice.toFixed(2)} × ${(gemServicesPercent * 100).toFixed(2)}% = ${gemServicesAmount.toFixed(2)} ₽` +
                    (marketplace === 'wb' && wbGemServicesPercent !== null ? ' (из настроек интеграции)' : '')
                  }
                >
                  -{gemServicesAmount.toFixed(2)} ₽
                </PriceBreakdownValue>
              </div>
            )}
            
            {marketplace === 'ozon' && (
              <div className="price-breakdown-item">
                <BreakdownLabel fromSettings={brandFromSettings}>
                  Продвижение бренда ({(brandPromotionPercent * 100).toFixed(2)}%)
                  {resolvedCalculatorData.brand_promotion_source === 'brand'
                    ? ' — из настроек бренда'
                    : resolvedCalculatorData.brand_promotion_source === 'api'
                      ? ' — из API Ozon'
                      : ''}
                  :
                </BreakdownLabel>
                <PriceBreakdownValue
                  className={brandPromotionAmount > 0 ? 'negative' : ''}
                  formula={
                    brandPromotionPercent > 0
                      ? `= ${calculatedPrice.toFixed(2)} × ${(brandPromotionPercent * 100).toFixed(2)}% = ${brandPromotionAmount.toFixed(2)} ₽`
                      : 'нет данных API / настроек бренда — в формуле 0%'
                  }
                >
                  {brandPromotionAmount > 0 ? `-${brandPromotionAmount.toFixed(2)} ₽` : '0.00 ₽'}
                </PriceBreakdownValue>
              </div>
            )}

            {marketplace === 'ozon' && (
              <div className="price-breakdown-item">
                <BreakdownLabel fromSettings={adsFromSettings}>
                  Реклама / ДРР ({(adsPromotionPercent * 100).toFixed(2)}%)
                  {resolvedCalculatorData.ads_promotion_source === 'config'
                    ? ' — из настроек интеграции'
                    : resolvedCalculatorData.ads_promotion_source === 'ads'
                      ? ' — Performance API'
                      : ''}
                  :
                </BreakdownLabel>
                <PriceBreakdownValue
                  className={adsPromotionAmount > 0 ? 'negative' : ''}
                  formula={
                    adsPromotionPercent > 0
                      ? `= ${calculatedPrice.toFixed(2)} × ${(adsPromotionPercent * 100).toFixed(2)}% = ${adsPromotionAmount.toFixed(2)} ₽`
                      : 'нет статистики Performance по SKU — в формуле 0% (или задайте ДРР по умолчанию в интеграциях)'
                  }
                >
                  {adsPromotionAmount > 0 ? `-${adsPromotionAmount.toFixed(2)} ₽` : '0.00 ₽'}
                </PriceBreakdownValue>
              </div>
            )}
            
            <div className="price-breakdown-item price-breakdown-subtotal">
              <span className="price-breakdown-label">Всего расходов:</span>
              <PriceBreakdownValue
                className="negative"
                formula={
                  `= ${
                    earlyShipmentDiscountPp > 0
                      ? `${commissionGrossAmount.toFixed(2)} − ${earlyShipmentDiscountAmount.toFixed(2)}`
                      : commissionAmount.toFixed(2)
                  } + ${effectiveAcquiringAmount.toFixed(2)}${
                    marketplace === 'ym' ? ` (${ymAgencyDisplay.toFixed(2)} + ${ymPaymentTransferDisplay.toFixed(2)})` : ''
                  } + ${brandPromotionAmount.toFixed(2)}${
                    adsPromotionAmount > 0 ? ` + ${adsPromotionAmount.toFixed(2)}` : ''
                  }${gemServicesAmount > 0 ? ` + ${gemServicesAmount.toFixed(2)}` : ''} + ${fixedExpenses.toFixed(2)} = ${(
                    commissionAmount +
                    effectiveAcquiringAmount +
                    brandPromotionAmount +
                    adsPromotionAmount +
                    gemServicesAmount +
                    fixedExpenses
                  ).toFixed(2)} ₽`
                }
              >
                {(commissionAmount + effectiveAcquiringAmount + brandPromotionAmount + adsPromotionAmount + gemServicesAmount + fixedExpenses).toFixed(2)} ₽
              </PriceBreakdownValue>
            </div>
            
            <div className="price-breakdown-item">
              <BreakdownLabel fromSettings>Минимальная чистая прибыль:</BreakdownLabel>
              {(() => {
                const targetProfit = resolveMarketplaceMinProfit(product, marketplace, null);
                if (targetProfit == null) {
                  return <PriceBreakdownValue style={{ color: '#10b981' }}>— не указана</PriceBreakdownValue>;
                }
                const mpLabel =
                  marketplace === 'ozon' ? 'Ozon' : marketplace === 'wb' ? 'WB' : marketplace === 'ym' ? 'Я.Маркет' : marketplace;
                const specific =
                  marketplace === 'ozon'
                    ? product?.minProfitOzon ?? product?.min_profit_ozon
                    : marketplace === 'wb'
                      ? product?.minProfitWb ?? product?.min_profit_wb
                      : product?.minProfitYm ?? product?.min_profit_ym;
                const fromMp = specific != null && specific !== '' && !isNaN(Number(specific));
                return (
                  <PriceBreakdownValue
                    style={{ color: '#10b981' }}
                    formula={`= ${Number(targetProfit).toFixed(2)} ₽ (цель после налогов${fromMp ? ` · ${mpLabel}` : ' · общая наценка'})`}
                  >
                    +{Number(targetProfit).toFixed(2)} ₽
                  </PriceBreakdownValue>
                );
              })()}
            </div>
          </div>
        </div>

        <div className="price-details-section">
          <h3 className="price-details-subtitle">📊 Прибыль</h3>
          <div className="price-breakdown">
            <div className="price-breakdown-item">
              <span className="price-breakdown-label">Валовая прибыль:</span>
              <PriceBreakdownValue
                className="positive"
                formula={`= ${calculatedPrice.toFixed(2)} - ${totalExpenses.toFixed(2)} = ${profit.toFixed(2)} ₽`}
              >
                {profit.toFixed(2)} ₽ ({profitPercent.toFixed(2)}%)
              </PriceBreakdownValue>
            </div>

            {marketplace === 'wb' && (
              <>
                <div className="price-breakdown-item">
                  <BreakdownLabel fromSettings>СПП ({sppPercent.toFixed(2)}%):</BreakdownLabel>
                  <PriceBreakdownValue
                    formula={`= мин. цена × (100% − ${sppPercent.toFixed(2)}%) → цена продажи (из настроек интеграции)`}
                  >
                    −{sppPercent.toFixed(2)}%
                  </PriceBreakdownValue>
                </div>
                <div className="price-breakdown-item">
                  <BreakdownLabel fromSettings>Цена продажи (после СПП):</BreakdownLabel>
                  <PriceBreakdownValue
                    formula={`= ${calculatedPrice.toFixed(2)} × ${(100 - sppPercent).toFixed(2)}% = ${sellingPriceAfterSpp.toFixed(2)} ₽`}
                  >
                    {sellingPriceAfterSpp.toFixed(2)} ₽
                  </PriceBreakdownValue>
                </div>
              </>
            )}
            
            {profile.vatRate > 0 && (
              <div className="price-breakdown-item">
                <BreakdownLabel fromSettings>НДС ({vatPctLabel}):</BreakdownLabel>
                <PriceBreakdownValue
                  className="negative"
                  formula={`= ${sellingPriceAfterSpp.toFixed(2)} × ${vatPctLabel} = ${vatAmount.toFixed(2)} ₽${marketplace === 'wb' ? ' (от цены продажи)' : ''}`}
                >
                  -{vatAmount.toFixed(2)} ₽
                </PriceBreakdownValue>
              </div>
            )}

            {profile.incomeTaxRate > 0 && (
              <div className="price-breakdown-item">
                <BreakdownLabel fromSettings>Налог ({incomeTaxPctLabel}):</BreakdownLabel>
                <PriceBreakdownValue className="negative" formula={incomeTaxFormulaHint}>
                  -{incomeTaxAmount.toFixed(2)} ₽
                </PriceBreakdownValue>
              </div>
            )}

            <div className="price-breakdown-item price-breakdown-total">
              <span className="price-breakdown-label">Чистая прибыль:</span>
              <span className={`price-breakdown-value large ${netProfit >= 0 ? 'positive' : 'negative'}`}>
                {netProfit.toFixed(2)} ₽ ({netProfitPercent.toFixed(2)}%)
              </span>
            </div>
          </div>
        </div>

        <div className="price-details-section price-details-final">
          <div className="price-details-final-row">
            <span className="price-details-final-label">Минимальная рекомендуемая цена:</span>
            <span className="price-details-final-value">
              <span className="price-details-final-amounts">
                {calculatedPrice.toFixed(2)} ₽
                {maxCalculatedPrice != null && (
                  <PriceRangeMax
                    amount={maxCalculatedPrice}
                    title="Оценка минимальной цены при максимальном тарифе Ozon; в расчёт берётся минимум"
                  />
                )}
              </span>
              <div className="price-details-final-hint">
                {marketplace === 'wb'
                  ? `Цена для маркетплейса (до СПП). Цена продажи после СПП ${sppPercent.toFixed(2)}%: ${sellingPriceAfterSpp.toFixed(2)} ₽. Налоги считаются от цены продажи.`
                  : maxCalculatedPrice != null
                    ? 'В расчёт берётся минимальный тариф Ozon. Серым — оценка при максимальном тарифе из API.'
                    : 'Цена для маркетплейса. Рассчитана по формуле: себестоимость + расходы + целевая чистая прибыль (после налогов), с учётом комиссий и тарифов маркетплейса'}
              </div>
            </span>
          </div>
        </div>

        {resolvedCalculatorData.categoryCommission && (
          <div className="price-details-section">
            <h3 className="price-details-subtitle">📋 Информация о категории</h3>
            <div className="price-details-grid">
              <div className="price-details-item">
                <span className="price-details-label">Категория:</span>
                <span className="price-details-value">
                  {resolvedCalculatorData.categoryCommission.subjectName || 'Не указана'}
                </span>
              </div>
              <div className="price-details-item">
                <span className="price-details-label">ID категории:</span>
                <span className="price-details-value">
                  {resolvedCalculatorData.categoryCommission.subjectID || '—'}
                </span>
              </div>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

