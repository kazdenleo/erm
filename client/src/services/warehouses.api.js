/**
 * Warehouses API Service
 * API сервис для работы со складами
 */

import api from './api';

export const warehousesApi = {
  /**
   * Получить все склады
   * @param {object} [options] - options.organizationId для фильтра по организации
   */
  getAll: async (options = {}) => {
    const params = options.organizationId != null && options.organizationId !== '' ? { organizationId: options.organizationId } : undefined;
    const response = await api.get('/warehouses', { params });
    return response.data;
  },

  /**
   * Создать склад
   */
  create: async (warehouseData) => {
    const response = await api.post('/warehouses', warehouseData);
    return response.data;
  },

  /**
   * Обновить склад
   */
  update: async (id, updates) => {
    const response = await api.put(`/warehouses/${id}`, updates);
    return response.data;
  },

  /**
   * Удалить склад
   */
  delete: async (id) => {
    const response = await api.delete(`/warehouses/${id}`);
    return response.data;
  }
};


