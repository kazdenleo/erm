/**
 * Warehouse Mappings API
 */

import api from './api';

export const warehouseMappingsApi = {
  list: async (params = {}) => {
    const response = await api.get('/warehouse-mappings', { params });
    return response.data?.data ?? response.data;
  },
  create: async (payload) => {
    const response = await api.post('/warehouse-mappings', payload);
    return response.data?.data ?? response.data;
  },
  update: async (id, payload) => {
    const response = await api.put(`/warehouse-mappings/${id}`, payload);
    return response.data?.data ?? response.data;
  },
  delete: async (id) => {
    const response = await api.delete(`/warehouse-mappings/${id}`);
    return response.data?.data ?? response.data;
  },
};

