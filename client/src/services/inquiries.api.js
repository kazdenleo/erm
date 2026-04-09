/**
 * Обращения в поддержку
 */

import api from './api.js';

export const inquiriesApi = {
  async list(params = {}) {
    const response = await api.get('/inquiries', { params });
    return response.data;
  },

  async getById(id) {
    const response = await api.get(`/inquiries/${id}`);
    return response.data;
  },

  async create(formData) {
    const response = await api.post('/inquiries', formData);
    return response.data;
  },

  async updateStatus(id, status) {
    const response = await api.patch(`/inquiries/${id}`, { status });
    return response.data;
  },
};
