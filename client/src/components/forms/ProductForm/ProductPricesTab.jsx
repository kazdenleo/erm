/**
 * Вкладка «Цены»: до/после скидки, наценки, максимумы, цены на МП при стратегии, история.
 */
import React from 'react';
import { ComputedAttributeField } from './ComputedAttributeField.jsx';
import { ProductPriceHistoryTab } from './ProductPriceHistoryTab.jsx';
import {
  evaluateFormula,
  SYSTEM_ATTR_KEYS,
  SYSTEM_ATTR_LABELS,
} from '../../../utils/attributeFormula.js';

const MP_META = [
  { key: 'ozon', label: 'Ozon', color: '#0b91ff' },
  { key: 'wb', label: 'Wildberries', color: '#cb11ab' },
  { key: 'ym', label: 'Яндекс.Маркет', color: '#c9a000' },
];

function formatRub(n) {
  if (n == null || n === '' || !Number.isFinite(Number(n))) return '—';
  return `${Math.round(Number(n))} ₽`;
}

function mpPack(product, marketplace) {
  return product?.marketplacePrices?.[marketplace] || {};
}

function mpStoredMin(product, marketplace) {
  if (marketplace === 'ozon') {
    return product?.storedMinPriceOzon ?? product?.stored_min_price_ozon ?? null;
  }
  if (marketplace === 'wb') {
    return product?.storedMinPriceWb ?? product?.stored_min_price_wb ?? null;
  }
  if (marketplace === 'ym') {
    return product?.storedMinPriceYm ?? product?.stored_min_price_ym ?? null;
  }
  return null;
}

function MpLivePricesPanel({ product, strategyName }) {
  return (
    <div
      className="col-12"
      style={{
        marginTop: '4px',
        padding: '12px 14px',
        borderRadius: '8px',
        border: '1px solid rgba(217,119,6,0.35)',
        background: 'rgba(217,119,6,0.08)',
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: '6px' }}>
        Цены на маркетплейсах
        {strategyName ? (
          <span style={{ fontWeight: 400, color: '#d97706', marginLeft: '8px', fontSize: '12px' }}>
            стратегия: {strategyName}
          </span>
        ) : null}
      </div>
      <p className="text-muted small mb-2" style={{ marginBottom: '8px' }}>
        «Цена после скидки» задаётся стратегией — поле недоступно для правки. Ниже — актуальные
        сохранённые цены продажи по маркетплейсам.
      </p>
      <div className="row g-2">
        {MP_META.map(({ key, label, color }) => {
          const pack = mpPack(product, key);
          const selling = pack.sellingPrice ?? pack.selling_price ?? null;
          const before = pack.priceBeforeDiscount ?? pack.price_before_discount ?? null;
          const min = mpStoredMin(product, key);
          return (
            <div key={key} className="col-md-4">
              <div
                style={{
                  padding: '8px 10px',
                  borderRadius: '6px',
                  background: 'rgba(255,255,255,0.04)',
                  border: '1px solid rgba(255,255,255,0.08)',
                }}
              >
                <div style={{ color, fontWeight: 600, fontSize: '13px', marginBottom: '4px' }}>
                  {label}
                </div>
                <div style={{ fontSize: '15px', fontWeight: 600 }}>{formatRub(selling)}</div>
                {before != null && Number(before) > Number(selling || 0) ? (
                  <div
                    className="text-muted"
                    style={{ fontSize: '12px', textDecoration: 'line-through' }}
                  >
                    {formatRub(before)}
                  </div>
                ) : null}
                {min != null ? (
                  <div className="text-muted" style={{ fontSize: '11px', marginTop: '2px' }}>
                    мин. {formatRub(min)}
                  </div>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * @param {object} props
 */
export function ProductPricesTab({
  productId,
  currentProduct,
  systemPriceAttributes = [],
  formData,
  allAttributes,
  productFormulaContext,
  getLinkedAttrMpDiffs,
  ozonAttributes,
  ozonAttributeValues,
  wbCategoryAttributes,
  wbAttributeValues,
  wbAttrKey,
  wbAttrName,
  ymFormAttributes,
  ymAttributeValues,
  ErpAttrFieldHeading,
  handleMpFieldLinkToggle,
  handleAttributeChange,
  handleComputedResetToFormula,
  handleChange,
  errors = {},
  parsePositiveCost,
}) {
  const strategyLocked = currentProduct?.hasPricingStrategy === true;
  const strategyName =
    currentProduct?.effectivePricingStrategyName ||
    currentProduct?.pricing_strategy_name ||
    null;

  return (
    <>
      <div className="row g-3">
        <div className="col-12">
          <h3 className="h6 mb-0">Себестоимость</h3>
        </div>
        <div className="col-md-3">
          <label className="form-label" htmlFor="cost">Себестоимость</label>
          <input
            id="cost"
            type="number"
            className="form-control form-control-sm"
            style={{ maxWidth: 200 }}
            step="0.01"
            min="0"
            placeholder="0.00"
            value={formData.cost}
            onChange={(e) => handleChange('cost', e.target.value)}
            disabled={formData.product_type === 'kit'}
            readOnly={formData.product_type === 'kit'}
            title={
              formData.product_type === 'kit'
                ? 'Для комплекта считается по комплектующим'
                : undefined
            }
          />
          <div style={{ fontSize: '11px', color: 'var(--muted)', marginTop: '4px' }}>
            {formData.product_type === 'kit'
              ? 'Считается автоматически по комплектующим — вручную не сохраняется.'
              : 'Сохраняется вручную. Цена поставщиков подставляется только если поле пустое.'}
          </div>
          {errors.cost && <div className="error">{errors.cost}</div>}
        </div>
        <div className="col-md-3">
          <label className="form-label" htmlFor="additionalExpenses">Дополнительные расходы</label>
          <input
            id="additionalExpenses"
            type="number"
            className="form-control form-control-sm"
            style={{ maxWidth: 200 }}
            step="0.01"
            min="0"
            placeholder="0.00"
            value={formData.additionalExpenses}
            onChange={(e) => handleChange('additionalExpenses', e.target.value)}
          />
          <div style={{ fontSize: '11px', color: 'var(--muted)', marginTop: '4px' }}>
            Упаковка, логистика и т.п. (не себестоимость)
          </div>
          {errors.additionalExpenses && <div className="error">{errors.additionalExpenses}</div>}
        </div>
      </div>

      <div className="row g-3 mt-2">
        <div className="col-12">
          <h3 className="h6 mb-0">Цены карточки</h3>
          <p className="text-muted small mb-0">
            Рассчитываемые поля «до скидки» и «после скидки». При отправке на маркетплейсы обе
            цены уходят вместе (цена продажи и зачёркнутая).
          </p>
        </div>

        {systemPriceAttributes.map((attr) => {
          const systemKey = String(attr.system_key || '');
          const isAfter = systemKey === SYSTEM_ATTR_KEYS.PRICE_AFTER_DISCOUNT;
          if (isAfter && strategyLocked) return null;

          const key = String(attr.id);
          const rawValue =
            formData.attributeValues[key] !== undefined && formData.attributeValues[key] !== null
              ? formData.attributeValues[key]
              : '';
          const formulaResult = String(attr.formula || '').trim()
            ? evaluateFormula(attr.formula, {
                product: productFormulaContext(formData),
                attributes: allAttributes,
                values: formData.attributeValues,
              })
            : { ok: true };
          const attrDiffs = getLinkedAttrMpDiffs(attr, rawValue, {
            formData,
            ozonAttributes,
            ozonAttributeValues,
            wbAttributes: wbCategoryAttributes,
            wbAttributeValues,
            wbAttrKey,
            wbAttrName,
            ymAttributes: ymFormAttributes,
            ymAttributeValues,
          });
          const locked = isAfter && strategyLocked;
          return (
            <div key={attr.id} className="col-md-3">
              <ComputedAttributeField
                attr={attr}
                value={rawValue}
                htmlFor={`attr-${attr.id}`}
                disabled={locked}
                lockedReason={
                  locked
                    ? `Задаётся стратегией${strategyName ? ` «${strategyName}»` : ''}. См. цены на МП ниже.`
                    : ''
                }
                heading={(
                  <ErpAttrFieldHeading
                    attr={attr}
                    htmlFor={`attr-${attr.id}`}
                    diffs={attrDiffs}
                    links={formData.mp_field_links}
                    onToggle={handleMpFieldLinkToggle}
                  />
                )}
                isManual={formData.attributeValuesManual?.[key] === true}
                changedByTool={formData.attributeValuesTool?.[key] === true}
                formulaError={
                  formData.attributeValuesManual?.[key] ||
                  formData.attributeValuesTool?.[key] ||
                  formulaResult.ok
                    ? ''
                    : formulaResult.error
                }
                onChange={(v) => handleAttributeChange(attr.id, v)}
                onResetToFormula={() => handleComputedResetToFormula(attr.id)}
              />
            </div>
          );
        })}

        {strategyLocked ? (
          <MpLivePricesPanel product={currentProduct} strategyName={strategyName} />
        ) : null}

        {!systemPriceAttributes.length ? (
          <div className="col-12">
            <p className="text-muted small mb-0">
              Системные атрибуты «
              {SYSTEM_ATTR_LABELS[SYSTEM_ATTR_KEYS.PRICE_BEFORE_DISCOUNT]}
              » / «
              {SYSTEM_ATTR_LABELS[SYSTEM_ATTR_KEYS.PRICE_AFTER_DISCOUNT]}
              » не найдены. Добавьте их в настройках атрибутов.
            </p>
          </div>
        ) : null}
      </div>

      <div className="row g-3 mt-2">
        <div className="col-12">
          <h3 className="h6 mb-0">Мин. наценки</h3>
        </div>

        <div className="col-md-3">
          <label className="form-label" htmlFor="minPrice">
            Мин. наценка (частные), ₽
          </label>
          <input
            id="minPrice"
            type="number"
            className="form-control form-control-sm"
            style={{ maxWidth: 200 }}
            step="0.01"
            min="0"
            placeholder="50"
            value={formData.minPrice}
            onChange={(e) => handleChange('minPrice', e.target.value)}
          />
          <div style={{ fontSize: '11px', color: 'var(--muted)', marginTop: '4px' }}>
            Целевая прибыль для частных (ручных) заказов
          </div>
        </div>

        <div className="col-md-3">
          <label className="form-label" htmlFor="minMarkupPercent">
            Мин. наценка (частные), %
          </label>
          <input
            id="minMarkupPercent"
            type="number"
            className="form-control form-control-sm"
            style={{ maxWidth: 200 }}
            step="0.01"
            min="0"
            placeholder={parsePositiveCost(formData.cost) == null ? '—' : '0'}
            value={formData.minMarkupPercent}
            disabled={parsePositiveCost(formData.cost) == null}
            onChange={(e) => handleChange('minMarkupPercent', e.target.value)}
          />
          <div style={{ fontSize: '11px', color: 'var(--muted)', marginTop: '4px' }}>
            {parsePositiveCost(formData.cost) == null
              ? 'Укажите себестоимость, чтобы задать %'
              : '% от себестоимости (для частных заказов)'}
          </div>
        </div>

        <div className="col-md-3">
          <label className="form-label" htmlFor="minProfitOzon">
            Мин. наценка Ozon, ₽
          </label>
          <input
            id="minProfitOzon"
            type="number"
            className="form-control form-control-sm"
            style={{ maxWidth: 200 }}
            step="0.01"
            min="0"
            placeholder="как общая"
            value={formData.minProfitOzon}
            onChange={(e) => handleChange('minProfitOzon', e.target.value)}
          />
          <div style={{ fontSize: '11px', color: 'var(--muted)', marginTop: '4px' }}>
            Для расчёта мин. цены Ozon (пусто — общая)
          </div>
        </div>

        <div className="col-md-3">
          <label className="form-label" htmlFor="minProfitWb">
            Мин. наценка WB, ₽
          </label>
          <input
            id="minProfitWb"
            type="number"
            className="form-control form-control-sm"
            style={{ maxWidth: 200 }}
            step="0.01"
            min="0"
            placeholder="как общая"
            value={formData.minProfitWb}
            onChange={(e) => handleChange('minProfitWb', e.target.value)}
          />
          <div style={{ fontSize: '11px', color: 'var(--muted)', marginTop: '4px' }}>
            Для расчёта мин. цены Wildberries (пусто — общая)
          </div>
        </div>

        <div className="col-md-3">
          <label className="form-label" htmlFor="minProfitYm">
            Мин. наценка Я.Маркет, ₽
          </label>
          <input
            id="minProfitYm"
            type="number"
            className="form-control form-control-sm"
            style={{ maxWidth: 200 }}
            step="0.01"
            min="0"
            placeholder="как общая"
            value={formData.minProfitYm}
            onChange={(e) => handleChange('minProfitYm', e.target.value)}
          />
          <div style={{ fontSize: '11px', color: 'var(--muted)', marginTop: '4px' }}>
            Для расчёта мин. цены Яндекс.Маркет (пусто — общая)
          </div>
        </div>
      </div>

      <div className="row g-3 mt-2">
        <div className="col-12">
          <h3 className="h6 mb-0">Макс. цены</h3>
        </div>
        <div className="col-md-3">
          <label className="form-label" htmlFor="maxPriceOzon">
            Макс. цена Ozon, ₽
          </label>
          <input
            id="maxPriceOzon"
            type="number"
            className="form-control form-control-sm"
            style={{ maxWidth: 200 }}
            step="0.01"
            min="0"
            placeholder="не задана"
            value={formData.maxPriceOzon}
            onChange={(e) => handleChange('maxPriceOzon', e.target.value)}
          />
          <div style={{ fontSize: '11px', color: 'var(--muted)', marginTop: '4px' }}>
            Потолок продажи на Ozon
          </div>
        </div>

        <div className="col-md-3">
          <label className="form-label" htmlFor="maxPriceWb">
            Макс. цена WB, ₽
          </label>
          <input
            id="maxPriceWb"
            type="number"
            className="form-control form-control-sm"
            style={{ maxWidth: 200 }}
            step="0.01"
            min="0"
            placeholder="не задана"
            value={formData.maxPriceWb}
            onChange={(e) => handleChange('maxPriceWb', e.target.value)}
          />
          <div style={{ fontSize: '11px', color: 'var(--muted)', marginTop: '4px' }}>
            Потолок продажи на Wildberries
          </div>
        </div>

        <div className="col-md-3">
          <label className="form-label" htmlFor="maxPriceYm">
            Макс. цена Я.Маркет, ₽
          </label>
          <input
            id="maxPriceYm"
            type="number"
            className="form-control form-control-sm"
            style={{ maxWidth: 200 }}
            step="0.01"
            min="0"
            placeholder="не задана"
            value={formData.maxPriceYm}
            onChange={(e) => handleChange('maxPriceYm', e.target.value)}
          />
          <div style={{ fontSize: '11px', color: 'var(--muted)', marginTop: '4px' }}>
            Потолок продажи на Яндекс.Маркет
          </div>
        </div>
      </div>

      {Object.keys(errors).length > 0 && (
        <div className="error" style={{ marginTop: '12px' }}>
          {Object.values(errors)[0]}
        </div>
      )}

      <div className="mt-4">
        <h3 className="h6 mb-2">История изменений цен</h3>
        <ProductPriceHistoryTab productId={productId} />
      </div>
    </>
  );
}
