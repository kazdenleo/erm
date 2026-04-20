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
    const n = payload?.newCount;
    const c = payload?.counts;
    const byMp = payload?.countsByMarketplace ?? {};
    return {
      newCount: typeof n === 'number' && Number.isFinite(n) ? n : 0,
      counts: {
        all: typeof c?.all === 'number' && Number.isFinite(c.all) ? c.all : 0,
        new: typeof c?.new === 'number' && Number.isFinite(c.new) ? c.new : 0,
        answered: typeof c?.answered === 'number' && Number.isFinite(c.answered) ? c.answered : 0,
      },
      countsByMarketplace: {
        ozon: typeof byMp.ozon === 'number' && Number.isFinite(byMp.ozon) ? byMp.ozon : 0,
        wildberries:
          typeof byMp.wildberries === 'number' && Number.isFinite(byMp.wildberries) ? byMp.wildberries : 0,
        yandex: typeof byMp.yandex === 'number' && Number.isFinite(byMp.yandex) ? byMp.yandex : 0,
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

