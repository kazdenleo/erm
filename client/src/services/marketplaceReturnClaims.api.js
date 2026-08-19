/**
 * Заявки на возврат с маркетплейсов (решение продавца)
 */

import api from './api';

export const marketplaceReturnClaimsApi = {
  getAll: async (params = {}) => {
    const response = await api.get('/marketplace-return-claims', { params });
    const payload = response.data;
    if (Array.isArray(payload?.data)) return payload.data;
    if (Array.isArray(payload)) return payload;
    return [];
  },

  getOne: async (id, { refresh = true } = {}) => {
    const response = await api.get(`/marketplace-return-claims/${encodeURIComponent(id)}`, {
      params: refresh ? {} : { refresh: '0' },
    });
    const payload = response.data;
    return payload?.data ?? payload ?? null;
  },

  getStats: async (params = {}) => {
    const response = await api.get('/marketplace-return-claims/stats', { params });
    const payload = response.data?.data ?? response.data;
    const byMp = payload?.countsByMarketplace ?? {};
    const c = payload?.counts ?? {};
    return {
      pendingCount: typeof payload?.pendingCount === 'number' ? payload.pendingCount : 0,
      counts: {
        all: typeof c.all === 'number' ? c.all : 0,
        pending: typeof c.pending === 'number' ? c.pending : 0,
        done: typeof c.done === 'number' ? c.done : 0,
      },
      countsByMarketplace: {
        ozon: typeof byMp.ozon === 'number' ? byMp.ozon : 0,
        wildberries: typeof byMp.wildberries === 'number' ? byMp.wildberries : 0,
        yandex: typeof byMp.yandex === 'number' ? byMp.yandex : 0,
      },
    };
  },

  sync: async (params = {}) => {
    const response = await api.post('/marketplace-return-claims/sync', {}, { params });
    const payload = response.data;
    return payload?.data ?? payload;
  },

  /**
   * @param {string|number} id
   * @param {object} body action, comment, rejectionReasonId, decisionReasonType, compensationAmount, returnForBackWay, returnItemDecisions
   */
  decide: async (id, body) => {
    const response = await api.post(`/marketplace-return-claims/${encodeURIComponent(id)}/decide`, body);
    const payload = response.data;
    return payload?.data ?? payload;
  },
};
