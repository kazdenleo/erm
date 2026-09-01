import api from './api';

export const productHypothesesApi = {
  list: async ({ status, productId } = {}) => {
    const params = new URLSearchParams();
    if (status && status !== 'all') params.set('status', status);
    if (productId != null && productId !== '') params.set('productId', String(productId));
    const qs = params.toString();
    const r = await api.get(`/sales-analytics/hypotheses${qs ? `?${qs}` : ''}`);
    return r.data && typeof r.data === 'object' ? r.data : { data: r.data };
  },

  create: async (body) => {
    const r = await api.post('/sales-analytics/hypotheses', body);
    return r.data && typeof r.data === 'object' ? r.data : { data: r.data };
  },

  update: async (id, body) => {
    const r = await api.patch(`/sales-analytics/hypotheses/${encodeURIComponent(id)}`, body);
    return r.data && typeof r.data === 'object' ? r.data : { data: r.data };
  },

  remove: async (id) => {
    const r = await api.delete(`/sales-analytics/hypotheses/${encodeURIComponent(id)}`);
    return r.data && typeof r.data === 'object' ? r.data : { data: r.data };
  },
};
