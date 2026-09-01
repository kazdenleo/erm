/**
 * API Честного знака (True API через наш бэкенд)
 */

import api from './api';

export const chestnyZnakApi = {
  getConfig: async () => {
    const response = await api.get('/integrations/chestny-znak');
    return response.data?.data ?? response.data;
  },

  saveConfig: async (config) => {
    const response = await api.put('/integrations/chestny-znak', config);
    return response.data?.data ?? response.data;
  },

  fetchAuthKey: async () => {
    const response = await api.get('/integrations/chestny-znak/auth/key');
    return response.data?.data ?? response.data;
  },

  signIn: async ({ uuid, signature, inn, unitedToken, cert_thumbprint }) => {
    const response = await api.post('/integrations/chestny-znak/auth/sign-in', {
      uuid,
      signature,
      inn,
      unitedToken,
      cert_thumbprint,
    });
    return response.data?.data ?? response.data;
  },

  test: async () => {
    const response = await api.post('/integrations/chestny-znak/test', {});
    return response.data?.data ?? response.data;
  },

  checkCises: async (codes) => {
    const response = await api.post('/integrations/chestny-znak/cises/info', { codes });
    return response.data?.data ?? response.data;
  },

  listCis: async (params = {}) => {
    const response = await api.get('/integrations/chestny-znak/cis', { params });
    return response.data?.data ?? response.data;
  },

  scanCis: async (body) => {
    const response = await api.post('/integrations/chestny-znak/cis/scan', body);
    return response.data?.data ?? response.data;
  },

  listDocuments: async (params = {}) => {
    const response = await api.get('/integrations/chestny-znak/documents', { params });
    return response.data?.data ?? response.data;
  },

  createDocument: async (body) => {
    const response = await api.post('/integrations/chestny-znak/documents', body);
    return response.data?.data ?? response.data;
  },

  signingPayload: async (id) => {
    const response = await api.get(`/integrations/chestny-znak/documents/${id}/payload`);
    return response.data?.data ?? response.data;
  },

  markEdoDone: async (id) => {
    const response = await api.post(`/integrations/chestny-znak/documents/${id}/edo-done`, {});
    return response.data?.data ?? response.data;
  },

  submitDocument: async (id, signature) => {
    const response = await api.post(`/integrations/chestny-znak/documents/${id}/submit`, { signature });
    return response.data?.data ?? response.data;
  },
};
