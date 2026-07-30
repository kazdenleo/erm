import api from './api.js';

export const pricingStrategiesApi = {
  async list() {
    const response = await api.get('/pricing-strategies');
    return response.data;
  },

  async getSettings() {
    const response = await api.get('/pricing-strategies/settings');
    return response.data;
  },

  async updateSettings({ enabled }) {
    const response = await api.put('/pricing-strategies/settings', { enabled });
    return response.data;
  },

  async getDefaults() {
    const response = await api.get('/pricing-strategies/defaults');
    return response.data;
  },

  async getOne(id) {
    const response = await api.get(`/pricing-strategies/${id}`);
    return response.data;
  },

  async create(payload) {
    const response = await api.post('/pricing-strategies', payload);
    return response.data;
  },

  async update(id, payload) {
    const response = await api.put(`/pricing-strategies/${id}`, payload);
    return response.data;
  },

  async remove(id) {
    const response = await api.delete(`/pricing-strategies/${id}`);
    return response.data;
  },

  async recalculateProduct(productId, marketplace = null) {
    const response = await api.post('/pricing-strategies/recalculate-product', {
      productId,
      marketplace,
    });
    return response.data;
  },

  async preview(payload) {
    const response = await api.post('/pricing-strategies/preview', payload);
    return response.data;
  },

  async priceChanges({ days = 7, marketplace = '', productId = '', limit = 150, offset = 0 } = {}) {
    const response = await api.get('/pricing-strategies/price-changes', {
      params: {
        days,
        limit,
        offset,
        ...(marketplace ? { marketplace } : {}),
        ...(productId ? { productId } : {}),
      },
    });
    return response.data;
  },
};
