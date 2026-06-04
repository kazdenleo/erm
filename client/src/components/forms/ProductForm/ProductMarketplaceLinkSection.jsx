/**
 * Блок «Связь с маркетплейсом» на вкладке Ozon / WB / Яндекс.Маркет в карточке товара.
 */

import React, { useState } from 'react';
import { MP_LINK_MAX, MP_LINK_PANEL_STYLE } from '../../../constants/marketplaceLinks.js';
import { productsApi } from '../../../services/products.api.js';
import { sanitizeWbVendorCode } from '../../../utils/wbVendorCode.js';
import { Button } from '../../common/Button/Button.jsx';

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

export function ProductMarketplaceLinkSection({
  marketplace,
  formData,
  errors,
  handleChange,
  productId,
  organizationId,
  erpSku,
  onLinked,
}) {
  const panelStyle = MP_LINK_PANEL_STYLE[marketplace] || MP_LINK_PANEL_STYLE.ozon;
  const [linking, setLinking] = useState(false);
  const [linkError, setLinkError] = useState('');
  const [linkSuccess, setLinkSuccess] = useState('');

  const linked = isMarketplaceLinked(marketplace, formData);
  const skuTrim = erpSku != null ? String(erpSku).trim() : '';
  const orgTrim = organizationId != null ? String(organizationId).trim() : '';
  const wbVendorTrim = sanitizeWbVendorCode(formData?.mp_wb_vendor_code || '');
  const wbNmTrim = String(formData?.sku_wb || '').trim();
  const ozonOfferTrim = String(formData?.sku_ozon || '').trim();
  const ozonPidTrim = String(formData?.ozon_product_id || '').trim();
  const ymOfferTrim = String(formData?.sku_ym || '').trim();
  const hasLinkIdentifiers =
    marketplace === 'wb'
      ? !!(wbVendorTrim || wbNmTrim || skuTrim)
      : marketplace === 'ozon'
        ? !!(ozonOfferTrim || ozonPidTrim || skuTrim)
        : marketplace === 'ym'
          ? !!(ymOfferTrim || skuTrim)
          : !!skuTrim;
  const canLink = !!productId && !!orgTrim && hasLinkIdentifiers && !linking;

  const linkDisabledReason = !productId
    ? 'Сначала сохраните товар'
    : !orgTrim
      ? 'Выберите организацию'
      : !hasLinkIdentifiers
        ? marketplace === 'wb'
          ? 'Укажите vendorCode WB, nmId или артикул ERP'
          : marketplace === 'ozon'
            ? 'Укажите offer_id Ozon, product_id или артикул ERP'
            : 'Укажите offerId ЯМ или артикул ERP'
        : '';

  const handleAutoLink = async () => {
    if (!canLink) return;
    setLinking(true);
    setLinkError('');
    setLinkSuccess('');
    try {
      const hints = {};
      if (marketplace === 'wb') {
        if (wbVendorTrim) hints.mp_wb_vendor_code = wbVendorTrim;
        if (wbNmTrim) hints.sku_wb = wbNmTrim;
        const ozonOffer = String(formData?.sku_ozon || '').trim();
        if (ozonOffer) hints.sku_ozon = ozonOffer;
      } else if (marketplace === 'ozon') {
        if (ozonOfferTrim) hints.sku_ozon = ozonOfferTrim;
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
        Идентификаторы для сопоставления товара ERP с карточкой на площадке. Иконка справа ищет карточку в
        кабинете организации
        {marketplace === 'wb' ? (
          <>
            {' '}
            по vendorCode WB (<code>{wbVendorTrim || '—'}</code>), nmId (<code>{wbNmTrim || '—'}</code>) или
            артикулу ERP (<code>{skuTrim || '—'}</code>).
          </>
        ) : marketplace === 'ozon' ? (
          <>
            {' '}
            по offer_id (<code>{ozonOfferTrim || '—'}</code>), product_id или артикулу ERP (
            <code>{skuTrim || '—'}</code>).
          </>
        ) : (
          <>
            {' '}
            по offerId ЯМ (<code>{ymOfferTrim || '—'}</code>) или артикулу ERP (<code>{skuTrim || '—'}</code>).
          </>
        )}
      </p>
      {linkError && <div className="text-danger small mb-2">{linkError}</div>}
      {linkSuccess && <div className="text-success small mb-2">{linkSuccess}</div>}

      {marketplace === 'ozon' && (
        <div className="row g-3">
          <div className="col-12 col-md-6">
            <label className="form-label" htmlFor="mp-link-ozon-offer">
              offer_id (артикул продавца)
            </label>
            <input
              id="mp-link-ozon-offer"
              type="text"
              className="form-control form-control-sm"
              maxLength={MP_LINK_MAX.OZON_OFFER_ID}
              placeholder="До 50 символов (/v2/product/import)"
              autoComplete="off"
              value={formData.sku_ozon}
              onChange={(e) => handleChange('sku_ozon', e.target.value)}
            />
            {errors.sku_ozon && <div className="text-danger small mt-1">{errors.sku_ozon}</div>}
          </div>
          <div className="col-12 col-md-6">
            <label className="form-label" htmlFor="mp-link-ozon-pid">
              product_id (числовой ID карточки)
            </label>
            <input
              id="mp-link-ozon-pid"
              type="text"
              inputMode="numeric"
              className="form-control form-control-sm"
              maxLength={MP_LINK_MAX.OZON_PRODUCT_ID_DIGITS}
              placeholder="После импорта или синхронизации"
              autoComplete="off"
              value={formData.ozon_product_id}
              onChange={(e) =>
                handleChange(
                  'ozon_product_id',
                  e.target.value.replace(/\D/g, '').slice(0, MP_LINK_MAX.OZON_PRODUCT_ID_DIGITS)
                )
              }
            />
            {errors.ozon_product_id && (
              <div className="text-danger small mt-1">{errors.ozon_product_id}</div>
            )}
          </div>
        </div>
      )}

      {marketplace === 'wb' && (
        <div className="row g-3">
          <div className="col-12 col-md-6">
            <label className="form-label" htmlFor="mp-link-wb-nmid">
              nmId (номенклатура)
            </label>
            <input
              id="mp-link-wb-nmid"
              type="text"
              inputMode="numeric"
              className="form-control form-control-sm"
              maxLength={MP_LINK_MAX.WB_NMID}
              placeholder="Например: 527548163"
              autoComplete="off"
              value={formData.sku_wb}
              onChange={(e) => handleChange('sku_wb', e.target.value.slice(0, MP_LINK_MAX.WB_NMID))}
            />
            {errors.sku_wb && <div className="text-danger small mt-1">{errors.sku_wb}</div>}
          </div>
          <div className="col-12 col-md-6">
            <label className="form-label" htmlFor="mp-link-wb-vendor">
              vendorCode (артикул продавца)
            </label>
            <input
              id="mp-link-wb-vendor"
              type="text"
              className="form-control form-control-sm"
              maxLength={MP_LINK_MAX.WB_VENDOR_CODE}
              autoComplete="off"
              value={formData.mp_wb_vendor_code}
              onChange={(e) =>
                handleChange(
                  'mp_wb_vendor_code',
                  sanitizeWbVendorCode(e.target.value).slice(0, MP_LINK_MAX.WB_VENDOR_CODE)
                )
              }
              onBlur={(e) =>
                handleChange(
                  'mp_wb_vendor_code',
                  sanitizeWbVendorCode(e.target.value).slice(0, MP_LINK_MAX.WB_VENDOR_CODE)
                )
              }
            />
            {errors.mp_wb_vendor_code && (
              <div className="text-danger small mt-1">{errors.mp_wb_vendor_code}</div>
            )}
          </div>
        </div>
      )}

      {marketplace === 'ym' && (
        <div className="row g-3">
          <div className="col-12 col-md-8">
            <label className="form-label" htmlFor="mp-link-ym-offer">
              offerId / shopSku
            </label>
            <input
              id="mp-link-ym-offer"
              type="text"
              className="form-control form-control-sm"
              maxLength={MP_LINK_MAX.YM_OFFER_ID}
              placeholder="1–255 символов (offerId в вашем каталоге)"
              autoComplete="off"
              value={formData.sku_ym}
              onChange={(e) => handleChange('sku_ym', e.target.value.slice(0, MP_LINK_MAX.YM_OFFER_ID))}
            />
            {errors.sku_ym && <div className="text-danger small mt-1">{errors.sku_ym}</div>}
          </div>
        </div>
      )}
    </div>
  );
}
