/**
 * Warehouses API Service
 * API сервис для работы со складами
 */

import api from './api';
import {
  getCachedWarehouseList,
  getInflightWarehouseList,
  setCachedWarehouseList,
  setInflightWarehouseList,
  warehouseListCacheKey,
} from './warehouseListCache.js';

export const warehousesApi = {
  /**
   * Получить все склады
   * @param {object} [options] - options.organizationId для фильтра по организации
   */
  getAll: async (options = {}) => {
    const key = warehouseListCacheKey(options.organizationId);
    const cached = getCachedWarehouseList(key);
    if (cached != null) {
      return cached;
    }
    const existing = getInflightWarehouseList(key);
    if (existing) {
      return existing;
    }
    const params =
      options.organizationId != null && options.organizationId !== ''
        ? { organizationId: options.organizationId }
        : undefined;
    const promise = api.get('/warehouses', { params }).then((response) => {
      const data = response.data;
      setCachedWarehouseList(key, data);
      return data;
    });
    return setInflightWarehouseList(key, promise);
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
  },

  listStockSyncExclusions: async (id) => {
    const response = await api.get(`/warehouses/${id}/stock-sync-exclusions`);
    return response.data?.data ?? response.data;
  },

  addStockSyncExclusion: async (id, payload) => {
    const response = await api.post(`/warehouses/${id}/stock-sync-exclusions`, payload);
    return response.data?.data ?? response.data;
  },

  removeStockSyncExclusion: async (id, exclusionId) => {
    const response = await api.delete(`/warehouses/${id}/stock-sync-exclusions/${exclusionId}`);
    return response.data?.data ?? response.data;
  },
};


