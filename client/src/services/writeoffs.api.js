/**
 * API реестра списаний со склада
 */

import api from './api';

export const writeoffsApi = {
  getList: async ({ limit = 200, offset = 0, organizationId, warehouseId } = {}) => {
    const params = { limit, offset };
    if (organizationId != null && String(organizationId).trim() !== '') {
      params.organizationId = organizationId;
    }
    if (warehouseId != null && String(warehouseId).trim() !== '') {
      params.warehouseId = warehouseId;
    }
    const response = await api.get('/stock-writeoffs', { params });
    return response.data?.data ?? response.data ?? [];
  },
};
