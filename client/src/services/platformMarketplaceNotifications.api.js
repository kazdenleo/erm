/**
 * Уведомления маркетплейсов — супер-админ (глобальный журнал и ключи приёма).
 */

import api from './api.js';

export const platformMarketplaceNotificationsApi = {
  async getSettings() {
    const response = await api.get('/platform/marketplace-notifications/settings');
    return response.data;
  },

  async putSettings(secrets) {
    const response = await api.put('/platform/marketplace-notifications/settings', { secrets });
    return response.data;
  },

  async listEvents({ limit = 50, offset = 0 } = {}) {
    const response = await api.get('/platform/marketplace-notifications/events', {
      params: { limit, offset },
    });
    return response.data;
  },
};
