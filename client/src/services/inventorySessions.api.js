/**
 * API инвентаризаций (документы пересчёта)
 */

import api from './api';

export const inventorySessionsApi = {
  list: async (params = {}) => {
    const response = await api.get('/inventory-sessions', { params });
    return response.data?.data ?? response.data;
  },

  getById: async (id) => {
    const response = await api.get(`/inventory-sessions/${id}`);
    return response.data?.data ?? response.data;
  },

  apply: async (payload) => {
    const response = await api.post('/inventory-sessions/apply', payload, { timeout: 300000 });
    return response.data?.data ?? response.data;
  },

  update: async (id, payload) => {
    const response = await api.put(`/inventory-sessions/${id}`, payload, { timeout: 300000 });
    return response.data?.data ?? response.data;
  },

  delete: async (id) => {
    const response = await api.delete(`/inventory-sessions/${id}`);
    return response.data?.data ?? response.data;
  },
};
