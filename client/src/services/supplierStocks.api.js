/**
 * Supplier Stocks API
 * Обращение к /api/supplier-stocks (упрощённая версия: только кэш).
 */

import api from './api';

export const supplierStocksApi = {
  /** Разбивка остатков по поставщикам для списка product id (из кэша БД). */
  getBreakdown: async (productIds, { mainWarehouseId } = {}) => {
    const ids = (Array.isArray(productIds) ? productIds : [])
      .map((id) => String(id).trim())
      .filter(Boolean);
    if (ids.length === 0) return { ok: true, data: [] };
    const params = new URLSearchParams();
    params.set('productIds', ids.join(','));
    if (mainWarehouseId != null && String(mainWarehouseId).trim() !== '') {
      params.set('mainWarehouseId', String(mainWarehouseId).trim());
    }
    const response = await api.get(`/supplier-stocks/breakdown?${params.toString()}`);
    return response.data;
  },

  getStock: async ({ supplier, sku, brand, cities }) => {
    const params = new URLSearchParams();
    if (supplier) params.append('supplier', supplier);
    if (sku) params.append('sku', sku);
    if (brand) params.append('brand', brand);
    if (cities) params.append('cities', cities);

    const response = await api.get(`/supplier-stocks?${params.toString()}`);
    return response.data;
  }
};


