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
    const response = await api.post('/inventory-sessions/apply', payload);
    return response.data?.data ?? response.data;
  },

  delete: async (id) => {
    const response = await api.delete(`/inventory-sessions/${id}`);
    return response.data?.data ?? response.data;
  },
};
