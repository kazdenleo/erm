/**
 * Отзывы покупателей с маркетплейсов
 */

import api from './api';

export const reviewsApi = {
  getAll: async (params = {}) => {
    const response = await api.get('/reviews', { params });
    const payload = response.data;
    if (Array.isArray(payload?.data)) return payload.data;
    if (Array.isArray(payload)) return payload;
    return [];
  },

  getStats: async (params = {}) => {
    const response = await api.get('/reviews/stats', { params });
    const payload = response.data?.data ?? response.data;
    const toNum = (v) => {
      const n = typeof v === 'number' ? v : Number(v);
      return Number.isFinite(n) ? n : 0;
    };
    const c = payload?.counts;
    const byMp = payload?.countsByMarketplace ?? {};
    const newCount = toNum(payload?.newCount ?? c?.new);
    return {
      newCount,
      counts: {
        all: toNum(c?.all),
        new: toNum(c?.new ?? newCount),
        answered: toNum(c?.answered),
      },
      countsByMarketplace: {
        ozon: toNum(byMp.ozon),
        wildberries: toNum(byMp.wildberries),
        yandex: toNum(byMp.yandex),
      },
    };
  },

  sync: async (params = {}) => {
    const response = await api.post('/reviews/sync', {}, { params });
    return response.data?.data ?? response.data;
  },

  answer: async (id, text) => {
    const response = await api.post(`/reviews/${encodeURIComponent(String(id))}/answer`, { text });
    return response.data?.data ?? response.data;
  },
};

