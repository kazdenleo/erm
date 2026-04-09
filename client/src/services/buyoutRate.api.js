/**
 * Buyout Rate API Service
 * Сервис для синхронизации процента выкупа с маркетплейсами
 */

import api from './api.js';

export const buyoutRateApi = {
  /**
   * Синхронизировать процент выкупа для одного товара
   * @param {number} productId - ID товара
   * @param {string} sku - SKU товара (опционально, для поиска если ID не найден)
   * @returns {Promise<Object>} - Результат синхронизации
   */
  async syncForProduct(productId, sku = null) {
    const url = sku 
      ? `/buyout-rate/sync/${productId}?sku=${encodeURIComponent(sku)}`
      : `/buyout-rate/sync/${productId}`;
    const response = await api.get(url);
    return response.data;
  },

  /**
   * Синхронизировать процент выкупа для всех товаров
   * @param {Object} options - Опции синхронизации (limit, offset)
   * @returns {Promise<Object>} - Результат синхронизации
   */
  async syncForAll(options = {}) {
    const response = await api.post('/buyout-rate/sync/all', options);
    return response.data;
  }
};

