/**
 * Integrations API Service
 * API сервис для работы с настройками интеграций
 */

import api from './api';

export const integrationsApi = {
  /**
   * Получить настройки маркетплейса
   */
  getMarketplace: async (type) => {
    const response = await api.get(`/integrations/marketplaces/${type}`);
    return response.data;
  },

  /**
   * Сохранить настройки маркетплейса
   */
  saveMarketplace: async (type, config) => {
    const response = await api.put(`/integrations/marketplaces/${type}`, config);
    return response.data;
  },

  /**
   * Получить настройки поставщика
   */
  getSupplier: async (type) => {
    const response = await api.get(`/integrations/suppliers/${type}`);
    return response.data;
  },

  /**
   * Сохранить настройки поставщика
   */
  saveSupplier: async (type, config) => {
    const response = await api.put(`/integrations/suppliers/${type}`, config);
    return response.data;
  },

  /** Проверить настройки поставщика (portal + v1). */
  testSupplier: async (type) => {
    const response = await api.post(`/integrations/suppliers/${type}/test`);
    return response.data;
  },

  /**
   * Получить все настройки интеграций
   */
  getAll: async () => {
    const response = await api.get('/integrations/all');
    return response.data;
  },

  /**
   * Проверить токен маркетплейса (ozon/wildberries/yandex)
   */
  getMarketplaceTokenStatus: async (type) => {
    const response = await api.get(`/integrations/marketplaces/${type}/token-status`);
    return response.data?.data ?? response.data;
  },

  /**
   * Уведомления по интеграциям (токены)
   */
  getNotifications: async (opts = {}) => {
    const params = {};
    if (opts.warn_days != null) params.warn_days = opts.warn_days;
    const response = await api.get('/integrations/notifications', { params: Object.keys(params).length ? params : undefined });
    return response.data?.data ?? response.data;
  },

  /** Очистить runtime-уведомления (ошибки фоновых задач). */
  clearRuntimeNotifications: async () => {
    const response = await api.post('/integrations/runtime-notifications/clear', {});
    return response.data?.data ?? response.data;
  },

  /**
   * Балансы на маркетплейсах (дашборд).
   * @returns {Promise<{ no_profile?: boolean, ozon?: object, wildberries?: object, yandex?: object }>}
   */
  getMarketplaceAccountBalances: async () => {
    const response = await api.get('/integrations/marketplaces/account-balances');
    return response.data?.data ?? response.data;
  },

  /**
   * Получить тарифы Wildberries
   */
  getWildberriesTariffs: async (date = null, { organizationId } = {}) => {
    const params = { ...(date ? { date } : {}) };
    if (organizationId != null && String(organizationId).trim() !== '') {
      params.organizationId = String(organizationId).trim();
    }
    const response = await api.get('/integrations/marketplaces/wildberries/tariffs', { params });
    return response.data;
  },

  /**
   * Список офисов WB для FBS (значения совпадают с order.offices[])
   */
  getWildberriesOffices: async ({ organizationId } = {}) => {
    const params = {};
    if (organizationId != null && String(organizationId).trim() !== '') {
      params.organizationId = String(organizationId).trim();
    }
    const response = await api.get('/integrations/marketplaces/wildberries/offices', { params });
    return response.data;
  },

  /**
   * Список складов продавца WB (FBS)
   */
  getWildberriesSellerWarehouses: async ({ organizationId } = {}) => {
    const params = {};
    if (organizationId != null && String(organizationId).trim() !== '') {
      params.organizationId = String(organizationId).trim();
    }
    const response = await api.get('/integrations/marketplaces/wildberries/warehouses', { params });
    return response.data;
  },

  /**
   * Получить склады Ozon (для сопоставления с фактическим складом)
   */
  getOzonWarehouses: async ({ organizationId } = {}) => {
    const params = {};
    if (organizationId != null && String(organizationId).trim() !== '') {
      params.organizationId = String(organizationId).trim();
    }
    const response = await api.get('/integrations/marketplaces/ozon/warehouses', { params });
    return response.data;
  },

  /**
   * Получить кампании Яндекс.Маркета (campaignId) для сопоставления с фактическим складом
   */
  getYandexCampaigns: async ({ organizationId } = {}) => {
    const params = {};
    if (organizationId != null && String(organizationId).trim() !== '') {
      params.organizationId = String(organizationId).trim();
    }
    const response = await api.get('/integrations/marketplaces/yandex/campaigns', { params });
    return response.data;
  },

  /**
   * FBS-склады Яндекс.Маркета: id = «ID склада» из личного кабинета
   */
  getYandexWarehouses: async ({ organizationId } = {}) => {
    const params = {};
    if (organizationId != null && String(organizationId).trim() !== '') {
      params.organizationId = String(organizationId).trim();
    }
    const response = await api.get('/integrations/marketplaces/yandex/warehouses', { params });
    return response.data;
  },

  /**
   * Данные предложения Яндекс.Маркета по offer_id (артикул продавца).
   * @param {{ offer_id?: string, organizationId?: number|string }} params
   */
  getYandexProductInfo: async (params = {}) => {
    const q = new URLSearchParams();
    if (params.offer_id != null && String(params.offer_id).trim() !== '') {
      q.set('offer_id', String(params.offer_id).trim());
    }
    if (params.organizationId != null && String(params.organizationId).trim() !== '') {
      q.set('organizationId', String(params.organizationId).trim());
    }
    const response = await api.get(`/integrations/marketplaces/yandex/product-info?${q.toString()}`);
    return response.data?.data ?? response.data;
  },

  /**
   * Получить комиссии Wildberries
   */
  getWildberriesCommissions: async (locale = 'ru') => {
    const params = { locale };
    const response = await api.get('/integrations/marketplaces/wildberries/commissions', { params });
    return response.data;
  },

  /**
   * Получить категории Wildberries из комиссий
   */
  getWildberriesCategories: async () => {
    try {
      const response = await api.get('/integrations/marketplaces/wildberries/categories');
      return response.data;
    } catch (error) {
      if (error.response?.status === 500 || error.response?.status === 404) {
        console.warn('[Integrations API] WB categories not available, returning empty array');
        return { ok: true, data: [] };
      }
      throw error;
    }
  },

  /**
   * Справочник брендов МП (WB / Ozon / YM).
   * @param {{ marketplace?: string, q?: string, subjectId?: number|string, organizationId?: number|string }} params
   */
  getMarketplaceBrands: async (params = {}) => {
    const q = new URLSearchParams();
    const mp = String(params.marketplace ?? params.mp ?? 'wb').trim().toLowerCase();
    q.set('marketplace', mp);
    if (params.q != null && String(params.q).trim() !== '') q.set('q', String(params.q).trim());
    if (params.subjectId != null && String(params.subjectId).trim() !== '') {
      q.set('subjectId', String(params.subjectId).trim());
    }
    if (params.organizationId != null && String(params.organizationId).trim() !== '') {
      q.set('organizationId', String(params.organizationId).trim());
    }
    const response = await api.get(`/integrations/marketplaces/brands?${q.toString()}`);
    const list = response.data?.data ?? response.data;
    return Array.isArray(list) ? list : [];
  },

  /**
   * Справочник брендов WB (Miles → MILES).
   * @param {{ q?: string, subjectId?: number|string, organizationId?: number|string }} params
   */
  getWildberriesBrands: async (params = {}) => {
    return integrationsApi.getMarketplaceBrands({ ...params, marketplace: 'wb' });
  },

  /**
   * Данные товара Wildberries по nm_id (ID номенклатуры).
   * @param {{ nm_id: number|string }} params
   */
  getWildberriesProductInfo: async (params = {}) => {
    const q = new URLSearchParams();
    if (params.nm_id != null && params.nm_id !== '') q.set('nm_id', String(params.nm_id));
    const vendorCode = params.vendor_code ?? params.vendorCode;
    if (vendorCode != null && String(vendorCode).trim() !== '') {
      q.set('vendor_code', String(vendorCode).trim());
    }
    if (params.organizationId != null && String(params.organizationId).trim() !== '') {
      q.set('organizationId', String(params.organizationId).trim());
    }
    const response = await api.get(`/integrations/marketplaces/wildberries/product-info?${q.toString()}`);
    return response.data?.data ?? response.data;
  },

  /**
   * Получить категории Ozon
   * @param {Object} [opts]
   * @param {boolean} [opts.forceRefresh] — загрузить из API Ozon
   * @param {boolean} [opts.dbOnly] — только из БД, без вызова API (быстрая загрузка)
   */
  getOzonCategories: async (opts = {}) => {
    const params = {};
    if (opts.forceRefresh) params.force_refresh = '1';
    if (opts.dbOnly) params.db_only = '1';
    const response = await api.get('/integrations/marketplaces/ozon/categories', { params: Object.keys(params).length ? params : undefined });
    return response.data;
  },

  /**
   * Характеристики категории Ozon для карточки товара.
   * @param {string|number} description_category_id
   * @param {string|number} [type_id=0]
   */
  /**
   * Данные товара из Ozon по product_id (Ozon) или offer_id (артикул продавца).
   * @param {{ product_id?: number, offer_id?: string }} params
   */
  getOzonProductInfo: async (params = {}) => {
    const q = new URLSearchParams();
    if (params.product_id != null && params.product_id !== '') q.set('product_id', String(params.product_id));
    if (params.offer_id != null && params.offer_id !== '') q.set('offer_id', String(params.offer_id));
    if (params.organizationId != null && String(params.organizationId).trim() !== '') {
      q.set('organizationId', String(params.organizationId).trim());
    }
    const response = await api.get(`/integrations/marketplaces/ozon/product-info?${q.toString()}`);
    return response.data?.data ?? response.data;
  },

  getOzonCategoryAttributes: async (description_category_id, type_id = 0) => {
    const response = await api.get('/integrations/marketplaces/ozon/category-attributes', {
      params: { description_category_id, type_id }
    });
    return response.data?.data ?? response.data ?? [];
  },

  /**
   * Справочник значений характеристики Ozon.
   */
  getOzonAttributeValues: async (attribute_id, description_category_id, type_id = 0, options = {}) => {
    const params = { attribute_id, description_category_id, type_id };
    if (options.last_value_id != null) params.last_value_id = options.last_value_id;
    if (options.limit != null) params.limit = options.limit;
    const response = await api.get('/integrations/marketplaces/ozon/attribute-values', { params });
    return { result: response.data?.data ?? response.data ?? [], has_next: response.data?.has_next ?? false };
  },

  /**
   * Поиск справочных значений характеристики Ozon по строке value.
   */
  searchOzonAttributeValues: async (attribute_id, description_category_id, type_id, value) => {
    const response = await api.get('/integrations/marketplaces/ozon/attribute-values/search', {
      params: { attribute_id, description_category_id, type_id: type_id ?? 0, value: value || '' }
    });
    return response.data?.data ?? response.data ?? [];
  },

  /**
   * Обновить комиссии Wildberries вручную
   */
  updateWildberriesCommissions: async () => {
    const response = await api.post('/integrations/marketplaces/wildberries/commissions/update');
    return response.data;
  },

  /**
   * Обновить категории и комиссии Wildberries из API (ночной джоб — то же самое)
   */
  updateWildberriesCategories: async () => {
    const response = await api.post('/wb-marketplace/update');
    return response.data;
  },

  /**
   * Получить категории Яндекс.Маркета
   * @param {boolean} [opts.dbOnly] — только из БД, без вызова API (быстрая загрузка)
   */
  getYandexCategories: async (opts = {}) => {
    const params = {};
    if (opts.forceRefresh) params.force_refresh = '1';
    if (opts.dbOnly) params.db_only = '1';
    const response = await api.get('/integrations/marketplaces/yandex/categories', { params: Object.keys(params).length ? params : undefined });
    return response.data;
  },

  /**
   * Обновить категории Яндекс.Маркета вручную
   */
  updateYandexCategories: async () => {
    const response = await api.post('/integrations/marketplaces/yandex/categories/update');
    return response.data;
  }
};

