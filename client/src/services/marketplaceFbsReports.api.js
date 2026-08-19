import api from './api';

export const marketplaceFbsReportsApi = {
  sync: async ({ dateFrom, dateTo, marketplace = 'all' } = {}) => {
    const r = await api.post(
      '/marketplace-fbs-reports/sync',
      { dateFrom, dateTo, marketplace },
      { timeout: 600000 }
    );
    return r.data && typeof r.data === 'object' ? r.data : { data: r.data };
  },

  getByProduct: async ({ dateFrom, dateTo, marketplace = 'all' } = {}) => {
    const params = new URLSearchParams();
    if (dateFrom) params.set('dateFrom', dateFrom);
    if (dateTo) params.set('dateTo', dateTo);
    if (marketplace) params.set('marketplace', marketplace);
    const qs = params.toString();
    const r = await api.get(`/marketplace-fbs-reports/by-product${qs ? `?${qs}` : ''}`);
    return r.data && typeof r.data === 'object' ? r.data : { data: r.data };
  },

  getByOrder: async ({ dateFrom, dateTo, marketplace = 'all', limit = 500 } = {}) => {
    const params = new URLSearchParams();
    if (dateFrom) params.set('dateFrom', dateFrom);
    if (dateTo) params.set('dateTo', dateTo);
    if (marketplace) params.set('marketplace', marketplace);
    if (limit) params.set('limit', String(limit));
    const qs = params.toString();
    const r = await api.get(`/marketplace-fbs-reports/by-order${qs ? `?${qs}` : ''}`);
    return r.data && typeof r.data === 'object' ? r.data : { data: r.data };
  },

  lookup: async ({ marketplace, orderId } = {}) => {
    const params = new URLSearchParams();
    if (marketplace) params.set('marketplace', marketplace);
    if (orderId) params.set('orderId', orderId);
    const qs = params.toString();
    const r = await api.get(`/marketplace-fbs-reports/lookup${qs ? `?${qs}` : ''}`);
    return r.data && typeof r.data === 'object' ? r.data : { data: r.data };
  },
};
