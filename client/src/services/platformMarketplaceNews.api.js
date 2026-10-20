/**
 * Новости маркетплейсов — супер-админ (автосбор changelog / API).
 */

import api from './api.js';

export const platformMarketplaceNewsApi = {
  async list({ limit = 50, offset = 0, source } = {}) {
    const response = await api.get('/platform/marketplace-news', {
      params: { limit, offset, ...(source ? { source } : {}) },
    });
    return response.data;
  },

  async sync() {
    const response = await api.post('/platform/marketplace-news/sync');
    return response.data;
  },
};
