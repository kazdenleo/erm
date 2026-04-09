/**
 * Organizations API Service
 */

import api from './api.js';

export const organizationsApi = {
  async getAll() {
    const response = await api.get('/organizations');
    return response.data;
  },

  async getById(id) {
    const response = await api.get(`/organizations/${id}`);
    return response.data;
  },

  async create(data) {
    const response = await api.post('/organizations', data);
    return response.data;
  },

  async update(id, data) {
    const response = await api.put(`/organizations/${id}`, data);
    return response.data;
  },

  async delete(id) {
    const response = await api.delete(`/organizations/${id}`);
    return response.data;
  }
};
