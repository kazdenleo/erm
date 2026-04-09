/**
 * Brands API Service
 * Сервис для работы с брендами через API
 */

import api from './api.js';

export const brandsApi = {
  async getAll() {
    const response = await api.get('/brands');
    return response.data;
  },

  async getById(id) {
    const response = await api.get(`/brands/${id}`);
    return response.data;
  },

  async create(brandData) {
    const response = await api.post('/brands', brandData);
    return response.data;
  },

  async update(id, updates) {
    const response = await api.put(`/brands/${id}`, updates);
    return response.data;
  },

  async delete(id) {
    const response = await api.delete(`/brands/${id}`);
    return response.data;
  }
};

