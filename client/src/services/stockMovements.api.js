/**
 * Stock Movements API
 * Журнал движений остатков по товарам
 */

import api from './api';

export const stockMovementsApi = {
  /**
   * Получить историю движений по товару
   */
  getWarehouseStock: async (productId, warehouseId) => {
    const response = await api.get(`/products/${productId}/warehouse-stock`, {
      params: { warehouseId }
    });
    return response.data?.data ?? response.data;
  },

  getHistory: async (productId, { limit, warehouseId } = {}) => {
    const params = {};
    if (limit) params.limit = limit;
    if (warehouseId != null && String(warehouseId).trim() !== '') {
      params.warehouseId = warehouseId;
    }
    const response = await api.get(`/products/${productId}/stock-movements`, { params });
    return response.data;
  },

  /** Заказы с ненулевым резервом по товару (текущее состояние). */
  getReservedOrders: async (productId, { warehouseId } = {}) => {
    const params = {};
    if (warehouseId != null && String(warehouseId).trim() !== '') {
      params.warehouseId = warehouseId;
    }
    const response = await api.get(`/products/${productId}/stock-reserved-orders`, { params });
    return response.data;
  },

  /** Снять весь резерв по товару (все заказы из модалки). */
  releaseAllReserves: async (productId) => {
    const response = await api.post(`/products/${productId}/stock-reserve-release-all`);
    return response.data;
  },

  releaseOrderReserve: async (productId, orderDbId) => {
    const response = await api.post(`/products/${productId}/stock-reserve-release-order`, {
      orderDbId
    });
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
  },

  /** Сброс истории остатков и установка текущих значений (администратор аккаунта). */
  resetStockHistory: async (productId, payload) => {
    const response = await api.post(`/products/${productId}/stock-history-reset`, payload);
    return response.data;
  },
};

