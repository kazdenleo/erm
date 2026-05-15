/**
 * Автосвязка товара ERP с карточкой маркетплейса по артикулу ERP и кабинету организации.
 */

import integrationsService from './integrations.service.js';

const MP_CODES = {
  ozon: 'ozon',
  wb: 'wb',
  wildberries: 'wb',
  ym: 'ym',
  yandex: 'ym'
};

function normalizeMp(marketplace) {
  const mp = MP_CODES[String(marketplace || '').toLowerCase()];
  if (!mp) {
    const err = new Error('Неизвестный маркетплейс. Допустимо: ozon, wb, ym.');
    err.statusCode = 400;
    throw err;
  }
  return mp;
}

function assertCredentials(mp, cfg) {
  if (mp === 'ozon' && !integrationsService._hasOzonCredentials(cfg)) {
    const err = new Error('Кабинет Ozon не настроен для выбранной организации (Client ID и API Key).');
    err.statusCode = 400;
    throw err;
  }
  if (mp === 'wb' && !integrationsService._hasWbCredentials(cfg)) {
    const err = new Error('Кабинет Wildberries не настроен для выбранной организации (API Key).');
    err.statusCode = 400;
    throw err;
  }
  if (mp === 'ym' && !integrationsService._hasYandexCredentials(cfg)) {
    const err = new Error('Кабинет Яндекс.Маркета не настроен для выбранной организации (API Key).');
    err.statusCode = 400;
    throw err;
  }
}

/**
 * Найти карточку на маркетплейсе по артикулу ERP.
 * @returns {Promise<{ marketplace: string, sku_ozon?: string, marketplace_ozon_product_id?: number|null, sku_wb?: string, mp_wb_vendor_code?: string, sku_ym?: string, displaySku: string }>}
 */
export async function resolveMarketplaceListingByErpSku({ marketplace, erpSku, profileId, organizationId }) {
  const mp = normalizeMp(marketplace);
  const sku = erpSku != null ? String(erpSku).trim() : '';
  if (!sku) {
    const err = new Error('У товара не указан артикул ERP (sku).');
    err.statusCode = 400;
    throw err;
  }
  if (organizationId == null || organizationId === '') {
    const err = new Error('У товара не указана организация — выберите организацию в карточке.');
    err.statusCode = 400;
    throw err;
  }

  const integrationType = mp === 'wb' ? 'wildberries' : mp === 'ym' ? 'yandex' : 'ozon';
  const cfg = await integrationsService.getMarketplaceConfig(integrationType, {
    profileId: profileId ?? null,
    organizationId
  });
  assertCredentials(mp, cfg);

  if (mp === 'ozon') {
    const item = await integrationsService.getOzonProductInfo({
      offer_id: sku,
      profileId,
      organizationId,
      ozonOverride: cfg
    });
    if (!item) {
      const err = new Error(`Товар с артикулом «${sku}» не найден в кабинете Ozon организации.`);
      err.statusCode = 404;
      throw err;
    }
    const offerId = String(item.offer_id ?? item.offer_id_alt ?? item.sku ?? sku).trim();
    const productId = item.id != null ? Number(item.id) : null;
    return {
      marketplace: mp,
      sku_ozon: offerId || sku,
      marketplace_ozon_product_id: Number.isFinite(productId) ? productId : null,
      displaySku: offerId || sku
    };
  }

  if (mp === 'wb') {
    const card = await integrationsService.getWildberriesProductByVendorCode(sku, {
      profileId,
      organizationId,
      wbOverride: cfg
    });
    if (!card || card.nmId == null) {
      const err = new Error(`Товар с артикулом «${sku}» не найден в кабинете Wildberries организации.`);
      err.statusCode = 404;
      throw err;
    }
    return {
      marketplace: mp,
      sku_wb: String(card.nmId),
      mp_wb_vendor_code: card.vendorCode || sku,
      displaySku: String(card.nmId)
    };
  }

  const ym = await integrationsService.getYandexOfferByOfferId(sku, { profileId, organizationId });
  if (!ym?.offerId) {
    const err = new Error(`Предложение с offerId «${sku}» не найдено в кабинете Яндекс.Маркета организации.`);
    err.statusCode = 404;
    throw err;
  }
  return {
    marketplace: mp,
    sku_ym: ym.offerId,
    displaySku: ym.offerId
  };
}
