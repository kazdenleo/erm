/**
 * Receipts API — приёмки товаров на склад
 */

import api from './api';

export const receiptsApi = {
  getList: async (params = {}) => {
    const response = await api.get('/receipts', { params });
    const body = response.data || {};
    const list = Array.isArray(body.data) ? body.data : [];
    const total = typeof body.total === 'number' ? body.total : list.length;
    return { list, total };
  },

  getById: async (id) => {
    const response = await api.get(`/receipts/${id}`);
    return response.data;
  },

  create: async (payload) => {
    const response = await api.post('/receipts', payload);
    return response.data;
  },

  delete: async (id) => {
    const response = await api.delete(`/receipts/${id}`, { timeout: 120000 });
    return response.data;
  },

  // Общая "живая" приёмка (несколько устройств)
  createSession: async (payload) => {
    const response = await api.post('/receipts/sessions', payload);
    return response.data;
  },
  getSession: async (id) => {
    const response = await api.get(`/receipts/sessions/${id}`);
    return response.data;
  },
  addSessionQuantity: async (id, payload) => {
    const response = await api.post(`/receipts/sessions/${id}/add-quantity`, payload);
    return response.data;
  },
  completeSession: async (id, payload) => {
    const response = await api.post(`/receipts/sessions/${id}/complete`, payload);
    return response.data;
  },
  inviteToSession: async (id, payload) => {
    const response = await api.post(`/receipts/sessions/${id}/invite`, payload);
    return response.data;
  },
};
