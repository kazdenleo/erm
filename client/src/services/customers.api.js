/**
 * Customers API Service
 * База клиентов для частных заказов
 */

import api from './api';

export const customersApi = {
  /**
   * Список клиентов
   * @param {{ search?: string, sort?: string, dir?: 'asc'|'desc', limit?: number, offset?: number }} [params]
   * @returns {Promise<{ items: object[], total: number }>}
   */
  list: async (params = {}) => {
    const response = await api.get('/customers', { params });
    return {
      items: Array.isArray(response.data?.data) ? response.data.data : [],
      total: Number(response.data?.meta?.total ?? 0),
    };
  },

  getById: async (id) => {
    const response = await api.get(`/customers/${id}`);
    return response.data?.data ?? null;
  },

  getOrders: async (id) => {
    const response = await api.get(`/customers/${id}/orders`);
    return Array.isArray(response.data?.data) ? response.data.data : [];
  },

  create: async (data) => {
    const response = await api.post('/customers', data);
    return response.data?.data ?? null;
  },

  update: async (id, data) => {
    const response = await api.put(`/customers/${id}`, data);
    return response.data?.data ?? null;
  },

  delete: async (id) => {
    const response = await api.delete(`/customers/${id}`);
    return response.data;
  },
};
