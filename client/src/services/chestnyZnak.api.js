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
};
