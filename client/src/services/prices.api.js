/**
 * Prices API Service
 * Сервис для работы с расчетом цен через API
 */

import api from './api.js';

export const pricesApi = {
  async getOzonPrice(offerId) {
    const response = await api.get('/product/prices/ozon', {
      params: { offer_id: offerId }
    });
    return response.data;
  },

  async getWBPrice(offerId, categoryId, wbWarehouseName = null, userCategoryId = null) {
    const params = { offer_id: offerId, category_id: categoryId };
    if (wbWarehouseName) params.wb_warehouse_name = wbWarehouseName;
    if (userCategoryId) params.user_category_id = userCategoryId;
    const response = await api.get('/product/prices/wb', { params });
    return response.data;
  },

  async getYMPrice(offerId, categoryId = null, userCategoryId = null) {
    const params = { offer_id: offerId };
    if (categoryId) params.category_id = categoryId;
    if (userCategoryId) params.user_category_id = userCategoryId;
    const response = await api.get('/product/prices/ym', { params });
    return response.data;
  },

  /** Пересчитать все минимальные цены и сохранить в БД (фоновый запуск на сервере) */
  async recalculateAll() {
    const response = await api.post('/product/prices/recalculate-all');
    return response.data;
  },

  /** Пересчитать минимальные цены для одного товара и сохранить в БД */
  async recalculateForProduct(productId) {
    const response = await api.post('/product/prices/recalculate-one', { productId });
    return response.data;
  },

  /** Отправить сохранённые мин. цены одного товара на маркетплейсы */
  async pushForProduct(productId) {
    const response = await api.post('/product/prices/push-one', { productId });
    return response.data;
  },

  /** Настройки отправки цен на маркетплейсы */
  async getPushSettings() {
    const response = await api.get('/product/prices/push-settings');
    return response.data;
  },

  async updatePushSettings(payload) {
    const response = await api.patch('/product/prices/push-settings', payload);
    return response.data;
  },

  /**
   * Отправить мин. цены на маркетплейсы (фон).
   * По умолчанию использует сохранённые настройки аккаунта.
   * @param {{
   *   organizationId?: number|string|null,
   *   brandId?: number|string|null,
   *   categoryIds?: Array<string|number>,
   *   productIds?: Array<number|string>,
   *   useSavedSettings?: boolean,
   * }} [opts]
   */
  async pushAll(opts = {}) {
    const body = {};
    if (opts.useSavedSettings === false) body.useSavedSettings = false;
    if (opts.organizationId != null && String(opts.organizationId).trim() !== '') {
      body.organizationId = Number(opts.organizationId);
    }
    if (opts.brandId != null && String(opts.brandId).trim() !== '') {
      body.brandId = Number(opts.brandId);
    }
    if (Array.isArray(opts.categoryIds) && opts.categoryIds.length) {
      body.categoryIds = opts.categoryIds;
    }
    if (Array.isArray(opts.productIds) && opts.productIds.length) {
      body.productIds = opts.productIds.map((id) => Number(id)).filter((n) => Number.isFinite(n) && n > 0);
    }
    const response = await api.post('/product/prices/push-all', body);
    return response.data;
  },

  /**
   * Скачать Excel с таблицей цен (текущие фильтры страницы «Цены»).
   * @returns {Promise<{ buffer: ArrayBuffer, exportedCount: number, filename: string }>}
   */
  async exportExcel(options = {}) {
    const params = {};
    if (options.organizationId != null && options.organizationId !== '') {
      params.organizationId = options.organizationId;
    }
    if (options.brandId != null && options.brandId !== '') params.brandId = options.brandId;
    if (options.categoryId != null && options.categoryId !== '') {
      params.categoryId = options.categoryId;
    }
    if (options.productType != null && options.productType !== '') {
      params.productType = options.productType;
    }
    if (options.search != null && String(options.search).trim() !== '') {
      params.search = String(options.search).trim();
    }
    if (options.includeArchived) params.includeArchived = '1';
    if (options.archivedOnly) params.archivedOnly = '1';
    if (Array.isArray(options.unlinkedMp) && options.unlinkedMp.length) {
      params.unlinkedMp = options.unlinkedMp.join(',');
    }
    if (Array.isArray(options.linkedMp) && options.linkedMp.length) {
      params.linkedMp = options.linkedMp.join(',');
    }
    if (options.requireAnyMarketplaceLink) params.requireAnyMarketplaceLink = '1';
    if (options.showFbs === false) params.showFbs = '0';
    if (options.showFbo === false) params.showFbo = '0';
    if (options.includePrivate === false) params.includePrivate = '0';

    const response = await api.get('/product/prices/export/excel', {
      params: Object.keys(params).length ? params : undefined,
      responseType: 'arraybuffer',
    });
    const raw = response.headers?.['x-prices-exported'] ?? response.headers?.['X-Prices-Exported'];
    const exportedCount = raw != null ? parseInt(String(raw), 10) : NaN;
    const cd = String(response.headers?.['content-disposition'] || '');
    let filename = `prices_export_${new Date().toISOString().slice(0, 10)}.xlsx`;
    const mStar = /filename\*=UTF-8''([^;]+)/i.exec(cd);
    const mPlain = /filename="([^"]+)"/i.exec(cd);
    if (mStar?.[1]) {
      try {
        filename = decodeURIComponent(mStar[1]);
      } catch {
        /* keep default */
      }
    } else if (mPlain?.[1]) {
      filename = mPlain[1];
    }
    return {
      buffer: response.data,
      exportedCount: Number.isFinite(exportedCount) ? exportedCount : -1,
      filename,
    };
  },

  /** Применить запрет авто-добавления товаров в акции Ozon для текущей организации */
  async enforceOzonBlockAutoPromotions() {
    const response = await api.post('/product/prices/ozon/block-auto-promotions/enforce');
    return response.data;
  },

  /** Выгрузить ДРР рекламы Ozon Performance за период */
  async syncOzonAdsStats(days = 14) {
    const response = await api.post('/product/prices/ozon/ads-stats/sync', { days });
    return response.data;
  },

  /** Получить список акций Ozon */
  async getOzonActions() {
    const response = await api.get('/product/prices/actions/ozon');
    return response.data;
  },

  /** Товары, участвующие в акции Ozon (из кэша) */
  async getOzonActionProducts(actionId) {
    const response = await api.get(`/product/prices/actions/ozon/${actionId}/products`);
    return response.data;
  },

  /** Товары, доступные к добавлению в акцию Ozon */
  async getOzonActionCandidates(actionId) {
    const response = await api.get(`/product/prices/actions/ozon/${actionId}/candidates`);
    return response.data;
  },

  async joinOzonAction(actionId, products) {
    const response = await api.post(`/product/prices/actions/ozon/${actionId}/join`, { products });
    return response.data;
  },

  async setOzonActionPrice(actionId, products) {
    const response = await api.post(`/product/prices/actions/ozon/${actionId}/price`, { products });
    return response.data;
  },

  async leaveOzonAction(actionId, payload) {
    const body = Array.isArray(payload)
      ? { products: payload }
      : { ozonProductIds: payload };
    const response = await api.post(`/product/prices/actions/ozon/${actionId}/leave`, body);
    return response.data;
  },

  /** Список акций Wildberries (календарь + детали) */
  async getWBActions() {
    const response = await api.get('/product/prices/actions/wb');
    return response.data;
  },

  /** Детали одной акции WB (GET .../promotions/details?promotionIDs=id) */
  async getWBPromotionDetails(promotionId) {
    const response = await api.get(`/product/prices/actions/wb/${promotionId}/details`);
    return response.data;
  },

  /** Товары по акции WB: inAction=true — в акции, inAction=false — доступные к добавлению */
  async getWBPromotionNomenclatures(promotionId, inAction, limit = 1000, offset = 0) {
    const params = new URLSearchParams({ inAction: inAction ? 'true' : 'false', limit: String(limit), offset: String(offset) });
    const response = await api.get(`/product/prices/actions/wb/${promotionId}/nomenclatures?${params.toString()}`);
    return response.data;
  },

  async joinWbPromotion(promotionId, items) {
    const response = await api.post(`/product/prices/actions/wb/${promotionId}/join`, { items });
    return response.data;
  },

  async getYmPromos() {
    const response = await api.get('/product/prices/actions/ym');
    return response.data;
  },

  async getYmPromoOffers(promoId) {
    const response = await api.get(`/product/prices/actions/ym/${encodeURIComponent(promoId)}/offers`);
    return response.data;
  },

  async joinYmPromo(promoId, offers) {
    const response = await api.post(`/product/prices/actions/ym/${encodeURIComponent(promoId)}/join`, { offers });
    return response.data;
  },

  async leaveYmPromo(promoId, offerIds) {
    const response = await api.post(`/product/prices/actions/ym/${encodeURIComponent(promoId)}/leave`, { offerIds });
    return response.data;
  },

  /** Сохранить рассчитанные цены в БД (массив { productId, ozon?, wb?, ym?, ozonFbs?, ozonFbo?, wbFbs?, wbFbo?, ... }) */
  async saveBulk(pricesList) {
    const response = await api.post('/product/prices/save-bulk', { prices: pricesList });
    return response.data;
  },

  /**
   * Сохранить фактическую цену / до скидки / % по МП.
   * @param {Array<{ productId, marketplace, sellingPrice?, priceBeforeDiscount?, discountPercent?, maxPrice? }>} items
   */
  async saveCommercial(items) {
    const response = await api.post('/product/prices/save-commercial', { items });
    return response.data;
  }
};

