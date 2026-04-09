/**
 * Stock Problems API
 */

import api from './api';

export const stockProblemsApi = {
  getProblemOrders: async (params = {}) => {
    const response = await api.get('/stock-problems/orders', { params });
    return response.data?.data ?? response.data;
  },

  refreshFlags: async () => {
    const response = await api.post('/stock-problems/orders/refresh-flags', {});
    return response.data?.data ?? response.data;
  },
};

