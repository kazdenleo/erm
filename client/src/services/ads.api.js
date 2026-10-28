import api from './api';

const adsApi = {
  getDashboard: async ({ marketplace, days, organizationId } = {}) => {
    const params = {};
    if (marketplace) params.marketplace = marketplace;
    if (days) params.days = days;
    if (organizationId) params.organizationId = organizationId;
    const response = await api.get('/ads/dashboard', { params });
    return response.data;
  },

  sync: async ({ marketplace, days, organizationId } = {}) => {
    const response = await api.post('/ads/sync', { marketplace, days, organizationId });
    return response.data;
  },

  testConnection: async (marketplace, { organizationId } = {}) => {
    const response = await api.post(`/ads/test/${encodeURIComponent(marketplace)}`, {
      organizationId,
    });
    return response.data;
  },

  listCampaigns: async ({ marketplace, organizationId } = {}) => {
    const params = {};
    if (marketplace) params.marketplace = marketplace;
    if (organizationId) params.organizationId = organizationId;
    const response = await api.get('/ads/campaigns', { params });
    return response.data;
  },

  getCampaign: async (id) => {
    const response = await api.get(`/ads/campaigns/${id}`);
    return response.data;
  },

  patchCampaign: async (id, body) => {
    const response = await api.patch(`/ads/campaigns/${id}`, body);
    return response.data;
  },

  patchCampaignProduct: async (campaignId, productId, body) => {
    const response = await api.patch(
      `/ads/campaigns/${campaignId}/products/${productId}`,
      body
    );
    return response.data;
  },

  listActions: async () => {
    const response = await api.get('/ads/actions');
    return response.data;
  },

  listRules: async () => {
    const response = await api.get('/ads/automation/rules');
    return response.data;
  },

  createRule: async (body) => {
    const response = await api.post('/ads/automation/rules', body);
    return response.data;
  },

  updateRule: async (id, body) => {
    const response = await api.put(`/ads/automation/rules/${id}`, body);
    return response.data;
  },

  deleteRule: async (id) => {
    const response = await api.delete(`/ads/automation/rules/${id}`);
    return response.data;
  },

  listAutomationRuns: async () => {
    const response = await api.get('/ads/automation/runs');
    return response.data;
  },

  runRule: async (id) => {
    const response = await api.post(`/ads/automation/rules/${id}/run`);
    return response.data;
  },

  runAutomation: async () => {
    const response = await api.post('/ads/automation/run');
    return response.data;
  },
};

export default adsApi;
