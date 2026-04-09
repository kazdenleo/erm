/**
 * Supplier Stocks API
 * Обращение к /api/supplier-stocks (упрощённая версия: только кэш).
 */

import api from './api';

export const supplierStocksApi = {
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


