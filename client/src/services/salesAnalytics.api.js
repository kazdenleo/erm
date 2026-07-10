import api from './api';

export const salesAnalyticsApi = {
  /** @returns {Promise<{ ok?: boolean, data?: { summary, items, period, marketplace } }>} */
  getFbsByProduct: async ({ dateFrom, dateTo, marketplace = 'all' } = {}) => {
    const params = new URLSearchParams();
    if (dateFrom) params.set('dateFrom', dateFrom);
    if (dateTo) params.set('dateTo', dateTo);
    if (marketplace) params.set('marketplace', marketplace);
    const qs = params.toString();
    const r = await api.get(`/sales-analytics/fbs-by-product${qs ? `?${qs}` : ''}`);
    return r.data && typeof r.data === 'object' ? r.data : { data: r.data };
  },
};
