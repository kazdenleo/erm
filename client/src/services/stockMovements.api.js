/**
 * Stock Movements API
 * Журнал движений остатков по товарам
 */

import api from './api';

export const stockMovementsApi = {
  /**
   * Получить историю движений по товару
   */
  getHistory: async (productId, { limit } = {}) => {
    const params = {};
    if (limit) params.limit = limit;
    const response = await api.get(`/products/${productId}/stock-movements`, { params });
    return response.data;
  },

  /**
   * Применить изменение остатка и записать движение
   * @param {number|string} productId
   * @param {object} payload - { delta, type, reason, meta }
   */
  applyChange: async (productId, payload) => {
    const response = await api.post(`/products/${productId}/stock-movements`, payload);
    return response.data;
  },

  /**
   * Перемещение товара между складами
   * @param {number|string} productId
   * @param {{ fromWarehouseId: number|string, toWarehouseId: number|string, quantity: number, reason?: string, meta?: object }} payload
   */
  transfer: async (productId, payload) => {
    const response = await api.post(`/products/${productId}/stock-transfer`, payload);
    return response.data;
  }
};

