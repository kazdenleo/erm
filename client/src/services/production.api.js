/**
 * Production API — сборка комплектов.
 */

import api from './api';

export const productionApi = {
  getKitPreview: async (kitProductId, warehouseId) => {
    const response = await api.get('/production/kit-preview', {
      params: {
        kitProductId: String(kitProductId),
        warehouseId: String(warehouseId),
      },
    });
    return response.data?.data ?? response.data;
  },

  assembleKit: async ({ kitProductId, warehouseId, quantity }) => {
    const response = await api.post('/production/assemble-kit', {
      kitProductId,
      warehouseId,
      quantity,
    });
    return response.data?.data ?? response.data;
  },
};
