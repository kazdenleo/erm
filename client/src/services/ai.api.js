import api from './api';

export const aiApi = {
  getConfig: async () => {
    const response = await api.get('/ai/config');
    return response.data?.data ?? response.data;
  },

  saveConfig: async (payload) => {
    const response = await api.put('/ai/config', payload);
    return response.data?.data ?? response.data;
  },

  test: async () => {
    const response = await api.post('/ai/test', {}, { timeout: 30000 });
    return response.data?.data ?? response.data;
  },

  chat: async ({ messages, context }) => {
    const response = await api.post(
      '/ai/chat',
      { messages, context },
      { timeout: 120000 }
    );
    return response.data?.data ?? response.data;
  },

  proposeProductCard: async (payload) => {
    const response = await api.post('/ai/product-card/propose', payload, { timeout: 120000 });
    return response.data?.data ?? response.data;
  },

  proposeProductCardsBulk: async (payload) => {
    const response = await api.post('/ai/product-card/propose-bulk', payload, { timeout: 180000 });
    return response.data?.data ?? response.data;
  },
};
