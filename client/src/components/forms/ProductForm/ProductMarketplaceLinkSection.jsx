/**
 * Блок «Связь с маркетплейсом» на вкладке Ozon / WB / Яндекс.Маркет в карточке товара.
 */

import React, { useState } from 'react';
import { MP_LINK_MAX, MP_LINK_PANEL_STYLE } from '../../../constants/marketplaceLinks.js';
import { productsApi } from '../../../services/products.api.js';
import { getMpDraft, isMpFieldLinked } from '../../../utils/productMpFieldLinks.js';
import { MP_CATEGORY_LINK_ICON_TITLE, dedicatedMainFieldForMpTarget, resolveLinkedErpAttrMirror } from '../../../utils/productAttributeMpLinks.js';
import { sanitizeWbVendorCode } from '../../../utils/wbVendorCode.js';
import { Button } from '../../common/Button/Button.jsx';
import { MpFromMainLinkIcon } from '../../common/MpFieldLinkToggles/MpFieldLinkToggles.jsx';

function isMarketplaceLinked(marketplace, formData) {
  if (marketplace === 'ozon') {
    return !!(
      String(formData?.sku_ozon || '').trim() || String(formData?.ozon_product_id || '').trim()
    );
  }
  if (marketplace === 'wb') {
    return !!(
      String(formData?.sku_wb || '').trim() || String(formData?.mp_wb_vendor_code || '').trim()
    );
  }
  if (marketplace === 'ym') {
    return !!String(formData?.sku_ym || '').trim();
  }
  return false;
}

function sellerSkuValue(marketplace, formData, categoryAttributes, attrLabelMaps) {
  if (isMpFieldLinked(formData?.mp_field_links, 'sku', marketplace)) {
    return formData?.sku || '';
  }
  const offerId =
    marketplace === 'ozon'
      ? '__ozon_offer_id__'
      : marketplace === 'wb'
        ? '__wb_vendor_code__'
        : marketplace === 'ym'
          ? '__ym_shop_sku__'
          : '';
  if (offerId && categoryAttributes?.length) {
    const mirror = resolveLinkedErpAttrMirror(
      formData,
      categoryAttributes,
      marketplace,
      { kind: 'offer', offerId },
      attrLabelMaps
    );
    if (mirror != null) return mirror;
  }
  if (marketplace === 'ozon') return formData?.sku_ozon || '';
  if (marketplace === 'wb') return formData?.mp_wb_vendor_code || '';
  if (marketplace === 'ym') return formData?.sku_ym || '';
  return '';
}

function manufacturerArticleValue(formData, categoryAttributes, attrLabelMaps, dedicatedLinks) {
  const dedicatedSku =
    dedicatedMainFieldForMpTarget(
      dedicatedLinks,
      'ozon',
      { kind: 'offer', offerId: '__ozon_vendor_code__' },
      attrLabelMaps
    ) === 'sku';
  if (dedicatedSku && isMpFieldLinked(formData?.mp_field_links, 'sku', 'ozon')) {
    return String(formData?.sku || '');
  }
  const mirror = categoryAttributes?.length
    ? resolveLinkedErpAttrMirror(
        formData,
        categoryAttributes,
        'ozon',
        { kind: 'offer', offerId: '__ozon_vendor_code__' },
        attrLabelMaps
      )
    : null;
  if (mirror != null && !dedicatedSku) return mirror;
  return String(getMpDraft(formData, 'ozon').vendorCode || '');
}

export function ProductMarketplaceLinkSection({
  marketplace,
  formData,
  errors,
  handleChange,
  onSkuChange,
  onLinkToggle,
  productId,
  organizationId,
  erpSku,
  onLinked,
  vendorCodeClassName,
  onManufacturerArticleChange,
  sellerSkuCategoryLinked = false,
  manufacturerArticleCategoryLinked = false,
  categoryAttributes = [],
  attrLabelMaps = {},
  dedicatedLinks = null,
}) {
  const panelStyle = MP_LINK_PANEL_STYLE[marketplace] || MP_LINK_PANEL_STYLE.ozon;
  const [linking, setLinking] = useState(false);
  const [linkError, setLinkError] = useState('');
  const [linkSuccess, setLinkSuccess] = useState('');

  const linked = isMarketplaceLinked(marketplace, formData);
  const skuLinked = isMpFieldLinked(formData?.mp_field_links, 'sku', marketplace);
  const skuTrim = erpSku != null ? String(erpSku).trim() : '';
  const orgTrim = organizationId != null ? String(organizationId).trim() : '';
  const wbVendorTrim = sanitizeWbVendorCode(formData?.mp_wb_vendor_code || '');
  const ozonOfferTrim = String(formData?.sku_ozon || '').trim();
  const ymOfferTrim = String(formData?.sku_ym || '').trim();
  const hasLinkIdentifiers =
    marketplace === 'wb'
      ? !!(wbVendorTrim || skuTrim)
      : marketplace === 'ozon'
        ? !!(ozonOfferTrim || skuTrim)
        : marketplace === 'ym'
          ? !!(ymOfferTrim || skuTrim)
          : !!skuTrim;
  const canLink = !!productId && !!orgTrim && hasLinkIdentifiers && !linking;

  const linkDisabledReason = !productId
    ? 'Сначала сохраните товар'
    : !orgTrim
      ? 'Выберите организацию'
      : !hasLinkIdentifiers
        ? 'Укажите артикул продавца или артикул на «Основном»'
        : '';

  const handleSellerSkuChange = (raw) => {
    const value =
      marketplace === 'wb' && !skuLinked
        ? sanitizeWbVendorCode(raw).slice(0, MP_LINK_MAX.WB_VENDOR_CODE)
        : marketplace === 'ozon'
          ? String(raw).slice(0, MP_LINK_MAX.OZON_OFFER_ID)
          : marketplace === 'ym'
            ? String(raw).slice(0, MP_LINK_MAX.YM_OFFER_ID)
            : raw;
    if (typeof onSkuChange === 'function') {
      onSkuChange(marketplace, value);
      return;
    }
    if (marketplace === 'ozon') handleChange('sku_ozon', value);
    else if (marketplace === 'wb') handleChange('mp_wb_vendor_code', value);
    else if (marketplace === 'ym') handleChange('sku_ym', value);
  };

  const handleAutoLink = async () => {
    if (!canLink) return;
    setLinking(true);
    setLinkError('');
    setLinkSuccess('');
    try {
      const hints = {};
      if (marketplace === 'wb') {
        if (wbVendorTrim) hints.mp_wb_vendor_code = wbVendorTrim;
        const wbNmTrim = String(formData?.sku_wb || '').trim();
        if (wbNmTrim) hints.sku_wb = wbNmTrim;
        const ozonOffer = String(formData?.sku_ozon || '').trim();
        if (ozonOffer) hints.sku_ozon = ozonOffer;
      } else if (marketplace === 'ozon') {
        if (ozonOfferTrim) hints.sku_ozon = ozonOfferTrim;
        const ozonPidTrim = String(formData?.ozon_product_id || '').trim();
        if (ozonPidTrim) hints.ozon_product_id = ozonPidTrim;
      } else if (marketplace === 'ym' && ymOfferTrim) {
        hints.sku_ym = ymOfferTrim;
      }
      const body = await productsApi.linkMarketplace(productId, marketplace, hints);
      const payload = body?.data ?? body;
      const product = payload?.product ?? payload;
      if (!product?.id) {
        throw new Error('Сервер не вернул обновлённую карточку товара');
      }
      const display = payload?.link?.displaySku;
      setLinkSuccess(
        display
          ? `Связано: ${display}`
          : 'Связь с маркетплейсом сохранена'
      );
      onLinked?.(product);
    } catch (e) {
      const msg = e?.response?.data?.message || e?.message || 'Не удалось связать с маркетплейсом';
      setLinkError(msg);
    } finally {
      setLinking(false);
    }
  };

  const sellerSkuError =
    marketplace === 'ozon'
      ? errors.sku_ozon
      : marketplace === 'wb'
        ? errors.mp_wb_vendor_code
        : errors.sku_ym;
  const maxLen =
    marketplace === 'ozon'
      ? MP_LINK_MAX.OZON_OFFER_ID
      : marketplace === 'wb'
        ? MP_LINK_MAX.WB_VENDOR_CODE
        : MP_LINK_MAX.YM_OFFER_ID;
  const inputId = `mp-link-${marketplace}-seller-sku`;
  const inputClass =
    marketplace === 'wb' && vendorCodeClassName
      ? vendorCodeClassName
      : 'form-control form-control-sm';
  const ozonProductId = String(formData?.ozon_product_id || '').trim();
  const wbNmId = String(formData?.sku_wb || '').trim();
  const marketplaceIdHint = !linked
    ? null
    : marketplace === 'ozon' && ozonProductId
      ? { label: 'product_id', value: ozonProductId }
      : marketplace === 'wb' && wbNmId
        ? { label: 'nmId', value: wbNmId }
        : null;

  return (
    <div
      className="mb-3 p-3 rounded"
      style={panelStyle}
      data-section={`product-marketplace-links-${marketplace}`}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px', marginBottom: '4px' }}>
        <h5 style={{ fontSize: '13px', fontWeight: 600, margin: 0, color: 'var(--text)' }}>
          Связь с маркетплейсом
        </h5>
        <Button
          type="button"
          variant="secondary"
          size="small"
          className="btn-icon btn-icon-only flex-shrink-0"
          title={
            linkDisabledReason ||
            (linked
              ? 'Пересвязать с карточкой маркетплейса'
              : 'Связать с карточкой маркетплейса')
          }
          disabled={!canLink}
          onClick={handleAutoLink}
          aria-label="Связать с карточкой маркетплейса"
        >
          <i
            className="pe-7s-link"
            aria-hidden
            style={{
              fontSize: '18px',
              fontWeight: 700,
              color: linked ? '#16a34a' : 'var(--muted)',
              opacity: linking ? 0.5 : 1,
            }}
          />
        </Button>
      </div>
      <p style={{ fontSize: '11px', color: 'var(--muted)', marginBottom: '8px', lineHeight: 1.45 }}>
        Артикул продавца на площадке. Иконка справа ищет карточку в кабинете организации по этому
        артикулу или по артикулу на вкладке «Основное» (<code>{skuTrim || '—'}</code>).
      </p>
      {linkError && <div className="text-danger small mb-2">{linkError}</div>}
      {linkSuccess && <div className="text-success small mb-2">{linkSuccess}</div>}

      <div className="row g-3">
        <div className={marketplace === 'wb' ? 'col-12 col-md-7' : 'col-12 col-md-8'}>
          <label className="form-label" htmlFor={inputId} style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap' }}>
            <span>
              Артикул продавца
            </span>
            <MpFromMainLinkIcon linked={skuLinked} />
            {sellerSkuCategoryLinked ? (
              <MpFromMainLinkIcon linked={false} title={MP_CATEGORY_LINK_ICON_TITLE} />
            ) : null}
          </label>
          <input
            id={inputId}
            type="text"
            className={inputClass}
            maxLength={maxLen}
            placeholder="Артикул продавца на площадке"
            autoComplete="off"
            value={sellerSkuValue(marketplace, formData, categoryAttributes, attrLabelMaps)}
            onChange={(e) => handleSellerSkuChange(e.target.value)}
            onBlur={
              marketplace === 'wb' && !skuLinked
                ? (e) => handleSellerSkuChange(e.target.value)
                : undefined
            }
          />
          {sellerSkuError && <div className="text-danger small mt-1">{sellerSkuError}</div>}
          {marketplaceIdHint && marketplace !== 'wb' ? (
            <div
              style={{
                marginTop: 4,
                fontSize: 11,
                lineHeight: 1.35,
                color: 'var(--muted)',
                userSelect: 'text',
              }}
              title="Идентификатор карточки в кабинете, только для просмотра"
            >
              {marketplaceIdHint.label}: {marketplaceIdHint.value}
            </div>
          ) : null}
        </div>
        {marketplace === 'wb' ? (
          <div className="col-12 col-md-5">
            <label className="form-label" htmlFor="mp-link-wb-nmid">
              nmId
            </label>
            <input
              id="mp-link-wb-nmid"
              type="text"
              className="form-control form-control-sm"
              readOnly
              value={wbNmId}
              placeholder="После отправки на WB"
              title="Номенклатура Wildberries. Появится после создания карточки на WB"
            />
          </div>
        ) : null}
        {marketplace === 'ozon' ? (
          <div className="col-12 col-md-8">
            <label className="form-label" htmlFor="mp-link-ozon-manufacturer-sku" style={{ display: 'inline-flex', alignItems: 'center', flexWrap: 'wrap', gap: 4 }}>
              Артикул производителя
              {manufacturerArticleCategoryLinked ? (
                <MpFromMainLinkIcon linked={false} title={MP_CATEGORY_LINK_ICON_TITLE} />
              ) : null}
            </label>
            <input
              id="mp-link-ozon-manufacturer-sku"
              type="text"
              className="form-control form-control-sm"
              autoComplete="off"
              placeholder="Партномер / OEM"
              value={manufacturerArticleValue(formData, categoryAttributes, attrLabelMaps, dedicatedLinks)}
              onChange={(e) => onManufacturerArticleChange?.(e.target.value)}
            />
            <div style={{ marginTop: 4, fontSize: 11, lineHeight: 1.35, color: 'var(--muted)' }}>
              Не путать с артикулом продавца (offer_id). Если в категории есть «Партномер» или «Артикул»,
              значение уйдёт туда при сохранении.
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
