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

function uniqueNonEmpty(values) {
  const seen = new Set();
  const out = [];
  for (const v of values) {
    const s = v != null ? String(v).trim() : '';
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

function parsePositiveInt(raw) {
  const s = raw != null ? String(raw).trim() : '';
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Кандидаты vendorCode для поиска карточки WB (поля формы, product_skus, Ozon offer_id, ERP). */
export function collectWbVendorCandidates({ hints = {}, product = null, erpSku = '' }) {
  const h = hints && typeof hints === 'object' ? hints : {};
  const skuWbRaw = [h.sku_wb, product?.sku_wb]
    .map((v) => (v != null ? String(v).trim() : ''))
    .find(Boolean);
  const nmId = parsePositiveInt(skuWbRaw);
  return uniqueNonEmpty([
    h.mp_wb_vendor_code,
    h.wbVendorCode,
    product?.mp_wb_vendor_code,
    product?.marketplace_skus?.wb,
    h.sku_ozon,
    product?.sku_ozon,
    skuWbRaw && !nmId ? skuWbRaw : null,
    erpSku != null ? String(erpSku).trim() : ''
  ]);
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
 * Найти карточку на маркетплейсе (сначала по полям связи / подсказкам, затем по артикулу ERP).
 * @param {object} params
 * @param {object} [params.hints] sku_ozon, ozon_product_id, mp_wb_vendor_code, sku_wb, sku_ym
 * @returns {Promise<{ marketplace: string, sku_ozon?: string, marketplace_ozon_product_id?: number|null, sku_wb?: string, mp_wb_vendor_code?: string, sku_ym?: string, displaySku: string }>}
 */
export async function resolveMarketplaceListingByErpSku({
  marketplace,
  erpSku,
  profileId,
  organizationId,
  hints = {}
}) {
  const mp = normalizeMp(marketplace);
  const sku = erpSku != null ? String(erpSku).trim() : '';
  const h = hints && typeof hints === 'object' ? hints : {};
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
    const ozonProductId = parsePositiveInt(h.ozon_product_id ?? h.marketplace_ozon_product_id);
    const offerCandidates = uniqueNonEmpty([h.sku_ozon, sku]);
    let item = null;
    if (ozonProductId) {
      item = await integrationsService.getOzonProductInfo({
        product_id: ozonProductId,
        profileId,
        organizationId,
        ozonOverride: cfg
      });
    }
    for (const offerId of offerCandidates) {
      if (item) break;
      item = await integrationsService.getOzonProductInfo({
        offer_id: offerId,
        profileId,
        organizationId,
        ozonOverride: cfg
      });
    }
    if (!item) {
      const tried = [
        ozonProductId ? `product_id ${ozonProductId}` : null,
        ...offerCandidates.map((o) => `offer_id «${o}»`)
      ].filter(Boolean);
      const err = new Error(
        `Товар не найден в кабинете Ozon организации (проверено: ${tried.join(', ') || '—'}).`
      );
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
    const nmId = parsePositiveInt(h.sku_wb ?? h.wbNmId);
    const vendorCandidates = collectWbVendorCandidates({
      hints: h,
      product: h._product ?? null,
      erpSku: sku
    });
    const wbOpts = { profileId, organizationId, wbOverride: cfg };
    let card = null;
    for (const vc of vendorCandidates) {
      const hit = await integrationsService.getWildberriesProductByVendorCode(vc, wbOpts);
      if (hit?.nmId != null) {
        card = hit;
        break;
      }
    }
    if (!card && nmId) {
      const info = await integrationsService.getWildberriesProductInfo({
        nm_id: nmId,
        profileId,
        organizationId,
        wbOverride: cfg
      });
      if (info) {
        card = {
          nmId,
          vendorCode: String(info.vendorCode ?? info.vendor_code ?? vendorCandidates[0] ?? sku).trim()
        };
      }
    }
    if (!card || card.nmId == null) {
      const tried = [
        ...vendorCandidates.map((v) => `vendorCode «${v}»`),
        nmId ? `nmId ${nmId}` : null
      ].filter(Boolean);
      const err = new Error(
        `Товар не найден в кабинете Wildberries организации (проверено: ${tried.join(', ') || '—'}).`
      );
      err.statusCode = 404;
      throw err;
    }
    return {
      marketplace: mp,
      sku_wb: String(card.nmId),
      mp_wb_vendor_code: card.vendorCode || vendorCandidates[0] || sku,
      displaySku: String(card.nmId)
    };
  }

  const ymCandidates = uniqueNonEmpty([h.sku_ym, sku]);
  let ym = null;
  for (const offerId of ymCandidates) {
    ym = await integrationsService.getYandexOfferByOfferId(offerId, { profileId, organizationId });
    if (ym?.offerId) break;
  }
  if (!ym?.offerId) {
    const err = new Error(
      `Предложение не найдено в кабинете Яндекс.Маркета организации (проверено: ${ymCandidates.map((o) => `«${o}»`).join(', ') || '—'}).`
    );
    err.statusCode = 404;
    throw err;
  }
  return {
    marketplace: mp,
    sku_ym: ym.offerId,
    displaySku: ym.offerId
  };
}
