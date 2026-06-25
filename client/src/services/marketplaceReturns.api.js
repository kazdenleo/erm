/**
 * Возвраты с маркетплейсов (Ozon, WB, Яндекс)
 */

import api from './api';

export const marketplaceReturnsApi = {
  /**
   * @param {object} [params] marketplace, filter, dateFrom, dateTo, days
   */
  getAll: async (params = {}) => {
    const response = await api.get('/marketplace-returns', { params });
    const payload = response.data;
    return {
      items: Array.isArray(payload?.data) ? payload.data : [],
      meta: payload?.meta ?? {},
    };
  },

  getStats: async (params = {}) => {
    const response = await api.get('/marketplace-returns/stats', { params });
    const payload = response.data?.data ?? response.data;
    const byMp = payload?.countsByMarketplace ?? {};
    return {
      waitingCount: typeof payload?.waitingCount === 'number' ? payload.waitingCount : 0,
      totalCount: typeof payload?.totalCount === 'number' ? payload.totalCount : 0,
      completedCount: typeof payload?.completedCount === 'number' ? payload.completedCount : 0,
      countsByMarketplace: {
        ozon: typeof byMp.ozon === 'number' ? byMp.ozon : 0,
        wildberries: typeof byMp.wildberries === 'number' ? byMp.wildberries : 0,
        yandex: typeof byMp.yandex === 'number' ? byMp.yandex : 0,
      },
      errors: payload?.errors,
    };
  },
};

/** @deprecated используйте marketplaceReturnsApi */
export const wbReturnsApi = marketplaceReturnsApi;
