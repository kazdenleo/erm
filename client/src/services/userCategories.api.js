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
    const response = await api.get(`/user-categories/${id}/marketplace-attributes`, { params });
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

  async delete(id) {
    const response = await api.delete(`/user-categories/${id}`);
    return response.data;
  }
};

