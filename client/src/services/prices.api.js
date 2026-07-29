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

  /**
   * Отправить мин. цены на маркетплейсы (фон).
   * @param {{ organizationId?: number|string|null }} [opts]
   */
  async pushAll(opts = {}) {
    const body = {};
    if (opts.organizationId != null && String(opts.organizationId).trim() !== '') {
      body.organizationId = Number(opts.organizationId);
    }
    const response = await api.post('/product/prices/push-all', body);
    return response.data;
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

  /** Сохранить рассчитанные цены в БД (массив { productId, ozon?, wb?, ym? }) */
  async saveBulk(pricesList) {
    const response = await api.post('/product/prices/save-bulk', { prices: pricesList });
    return response.data;
  },

  /**
   * Сохранить фактическую цену / до скидки / % по МП.
   * @param {Array<{ productId, marketplace, sellingPrice?, priceBeforeDiscount?, discountPercent? }>} items
   */
  async saveCommercial(items) {
    const response = await api.post('/product/prices/save-commercial', { items });
    return response.data;
  }
};

