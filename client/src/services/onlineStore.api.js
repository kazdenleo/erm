import api from './api.js';

export const onlineStoreApi = {
  getMine: async () => {
    const r = await api.get('/online-store/me');
    return r.data?.data ?? r.data;
  },
  saveMine: async (body) => {
    const r = await api.put('/online-store/me', body);
    return r.data?.data ?? r.data;
  },
  templates: async () => {
    const r = await api.get('/online-store/templates');
    return r.data?.data ?? r.data;
  },
  publicStore: async (slug) => {
    const r = await api.get(`/online-store/public/${encodeURIComponent(slug)}`);
    return r.data?.data ?? r.data;
  },
  /** Резолв витрины по Host (свой домен). */
  publicByHost: async (host) => {
    const r = await api.get('/online-store/public-by-host', {
      params: host ? { host } : undefined,
    });
    return r.data?.data ?? r.data;
  },
  publicProducts: async (slug, { q = '', categoryId = '' } = {}) => {
    const params = {};
    if (q) params.q = q;
    if (categoryId) params.categoryId = categoryId;
    const r = await api.get(`/online-store/public/${encodeURIComponent(slug)}/products`, {
      params: Object.keys(params).length ? params : undefined,
    });
    return r.data?.data ?? r.data;
  },
  publicProduct: async (slug, productId) => {
    const r = await api.get(
      `/online-store/public/${encodeURIComponent(slug)}/products/${encodeURIComponent(productId)}`
    );
    return r.data?.data ?? r.data;
  },
  checkout: async (slug, body) => {
    const r = await api.post(`/online-store/public/${encodeURIComponent(slug)}/checkout`, body);
    return r.data?.data ?? r.data;
  },
};
