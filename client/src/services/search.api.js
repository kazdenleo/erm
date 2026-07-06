import api from './api';

export const searchApi = {
  global: async (q, { limit = 12 } = {}) => {
    const response = await api.get('/search', {
      params: { q: String(q || '').trim(), limit },
    });
    return response.data?.data ?? response.data;
  },
};
