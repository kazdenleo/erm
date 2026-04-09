/**
 * Category Mappings API Service
 * Сервис для работы с маппингами категорий через API
 */

import api from './api.js';

export const categoryMappingsApi = {
  async getAll(params = {}) {
    const response = await api.get('/category-mappings', { params });
    return response.data;
  },

  async getById(id) {
    const response = await api.get(`/category-mappings/${id}`);
    return response.data;
  },

  async getByProduct(productId) {
    // Добавляем параметр для предотвращения кэширования
    const response = await api.get(`/category-mappings/product/${productId}`, {
      params: { _t: Date.now() }
    });
    return response.data;
  },

  async create(mappingData) {
    const response = await api.post('/category-mappings', mappingData);
    return response.data;
  },

  async update(id, updates) {
    const response = await api.put(`/category-mappings/${id}`, updates);
    return response.data;
  },

  async delete(id) {
    const response = await api.delete(`/category-mappings/${id}`);
    return response.data;
  }
};

