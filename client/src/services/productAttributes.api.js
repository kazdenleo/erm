/**
 * Product Attributes API
 */

import api from './api.js';

export const productAttributesApi = {
  async getAll() {
    const response = await api.get('/product-attributes');
    return response.data;
  },

  async getById(id) {
    const response = await api.get(`/product-attributes/${id}`);
    return response.data;
  },

  async create(data) {
    const response = await api.post('/product-attributes', data);
    return response.data;
  },

  async update(id, data) {
    const response = await api.put(`/product-attributes/${id}`, data);
    return response.data;
  },

  async delete(id) {
    const response = await api.delete(`/product-attributes/${id}`);
    return response.data;
  }
};
