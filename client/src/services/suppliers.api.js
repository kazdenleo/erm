/**
 * Suppliers API Service
 * API сервис для работы с поставщиками
 */

import api from './api';

export const suppliersApi = {
  /**
   * Получить всех поставщиков
   */
  getAll: async () => {
    const response = await api.get('/suppliers');
    return response.data;
  },

  /**
   * Создать поставщика
   */
  create: async (supplierData) => {
    const response = await api.post('/suppliers', supplierData);
    return response.data;
  },

  /**
   * Обновить поставщика
   */
  update: async (id, updates) => {
    const response = await api.put(`/suppliers/${id}`, updates);
    return response.data;
  },

  /**
   * Удалить поставщика
   */
  delete: async (id) => {
    const response = await api.delete(`/suppliers/${id}`);
    return response.data;
  }
};


