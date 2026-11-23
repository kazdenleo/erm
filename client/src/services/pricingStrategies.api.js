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

  async updateSettings({ enabled, defaultStrategyId } = {}) {
    const response = await api.put('/pricing-strategies/settings', {
      ...(enabled !== undefined ? { enabled } : {}),
      ...(defaultStrategyId !== undefined ? { defaultStrategyId } : {}),
    });
    return response.data;
  },

  async listRules() {
    const response = await api.get('/pricing-strategies/rules');
    return response.data;
  },

  async upsertRule(payload) {
    const response = await api.post('/pricing-strategies/rules', payload);
    return response.data;
  },

  async deleteRule(id) {
    const response = await api.delete(`/pricing-strategies/rules/${id}`);
    return response.data;
  },

  /** Назначения стратегии (дефолт + области). Обычно приходят в getOne/create/update. */
  async getAssignments(id) {
    const response = await api.get(`/pricing-strategies/${id}`);
    return response.data?.data?.assignments || response.data?.assignments || null;
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

  /** Привязать стратегию к товару (strategyId=null — снять). marketplace — только этот МП. */
  async assignProduct(productId, strategyId = null, marketplace = null) {
    const response = await api.put('/pricing-strategies/assign-product', {
      productId,
      strategyId,
      ...(marketplace ? { marketplace } : {}),
    });
    return response.data;
  },

  async preview(payload) {
    const response = await api.post('/pricing-strategies/preview', payload);
    return response.data;
  },

  async priceChanges({
    days = 30,
    marketplace = '',
    productId = '',
    search = '',
    limit = 150,
    offset = 0,
  } = {}) {
    const response = await api.get('/pricing-strategies/price-changes', {
      params: {
        days,
        limit,
        offset,
        ...(marketplace ? { marketplace } : {}),
        ...(productId ? { productId } : {}),
        ...(search ? { search } : {}),
      },
    });
    return response.data;
  },
};
