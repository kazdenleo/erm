/**
 * User Categories API Service
 * Сервис для работы с пользовательскими категориями через API
 */

import api from './api.js';

export const userCategoriesApi = {
  async getAll() {
    const response = await api.get('/user-categories');
    return response.data;
  },

  async getById(id) {
    const response = await api.get(`/user-categories/${id}`);
    return response.data;
  },

  /**
   * Атрибуты маркетплейса для пользовательской категории (по marketplace_mappings на backend).
   * @param {string|number} id user_category_id
   * @param {'ozon'|'wb'|'ym'} marketplace
   * @param {{ forceRefresh?: boolean }} [opts]
   */
  async getMarketplaceAttributes(id, marketplace, opts = {}) {
    const params = { marketplace };
    if (opts.forceRefresh) params.force_refresh = '1';
    if (opts.organizationId != null && String(opts.organizationId).trim() !== '') {
      params.organization_id = String(opts.organizationId).trim();
    }
    if (opts.subjectId != null && Number(opts.subjectId) > 0) {
      params.subject_id = String(Number(opts.subjectId));
    }
    const response = await api.get(`/user-categories/${id}/marketplace-attributes`, {
      params,
      /** Нет ключа МП / сопоставления — ожидаемый 400; не засоряем консоль при массовых запросах */
      silentConsole: true,
    });
    return response.data;
  },

  async create(categoryData) {
    const response = await api.post('/user-categories', categoryData);
    return response.data;
  },

  async update(id, updates) {
    const response = await api.put(`/user-categories/${id}`, updates);
    return response.data;
  },

  /**
   * Связь ERP-атрибута с характеристиками Ozon/WB/ЯМ для конкретной категории.
   * @param {string|number} categoryId
   * @param {string|number} attributeId
   * @param {{ ozon?: object|null, wb?: object|null, ym?: object|null }} mpLinks
   */
  async updateAttributeMpLinks(categoryId, attributeId, mpLinks) {
    const response = await api.put(
      `/user-categories/${categoryId}/attributes/${attributeId}/mp-links`,
      { mp_links: mpLinks }
    );
    return response.data;
  },

  async delete(id) {
    const response = await api.delete(`/user-categories/${id}`);
    return response.data;
  },

  /**
   * Комиссии Ozon/YM по id сопоставленных категорий (для списка категорий ERP).
   * @param {{ ozon?: Array<string|{ id: string, userCategoryId?: number|string }>, ym?: string[], dbOnly?: boolean }} ids
   */
  async previewMarketplaceCommissions(ids = {}) {
    const params = ids.dbOnly ? { db_only: '1' } : undefined;
    const { dbOnly, ...body } = ids;
    const response = await api.post('/user-categories/marketplace-commissions-preview', body, { params });
    return response.data;
  },

  /** Обновить кэш комиссий Ozon/YM в БД (запросы к API маркетплейсов). */
  async refreshMarketplaceCommissions() {
    const response = await api.post('/user-categories/marketplace-commissions-refresh');
    return response.data;
  },
};

