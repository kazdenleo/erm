/**
 * API: отправка остатков («Доступно») на маркетплейсы.
 */

import api from './api.js';

export const marketplaceStockApi = {
  getAvailable: async (productId, warehouseId = null) => {
    const params = warehouseId ? { warehouseId: String(warehouseId) } : undefined;
    const response = await api.get(`/marketplace-stock/available/${productId}`, { params });
    return response.data;
  },

  syncProduct: async (productId, { warehouseId, organizationId } = {}) => {
    const response = await api.post(`/marketplace-stock/sync/product/${productId}`, {
      warehouseId: warehouseId ?? null,
      organizationId: organizationId ?? null
    });
    return response.data;
  },

  syncBulk: async ({ organizationId, productIds, warehouseId }) => {
    const response = await api.post('/marketplace-stock/sync', {
      organizationId,
      productIds: productIds ?? undefined,
      warehouseId: warehouseId ?? null
    });
    return response.data;
  }
};
