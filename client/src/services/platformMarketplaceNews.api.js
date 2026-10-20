/**
 * Новости маркетплейсов — супер-админ (автосбор changelog / API).
 */

import api from './api.js';

export const platformMarketplaceNewsApi = {
  async list({ limit = 50, offset = 0, source, unreadOnly } = {}) {
    const response = await api.get('/platform/marketplace-news', {
      params: {
        limit,
        offset,
        ...(source ? { source } : {}),
        ...(unreadOnly ? { unread: '1' } : {}),
      },
    });
    return response.data;
  },

  async get(id) {
    const response = await api.get(`/platform/marketplace-news/${id}`);
    return response.data;
  },

  async sync() {
    const response = await api.post('/platform/marketplace-news/sync');
    return response.data;
  },

  async markRead(id) {
    const response = await api.post(`/platform/marketplace-news/${id}/read`);
    return response.data;
  },

  async markAllRead({ source } = {}) {
    const response = await api.post('/platform/marketplace-news/read-all', {
      ...(source ? { source } : {}),
    });
    return response.data;
  },
};
