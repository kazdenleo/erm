import api from './api';

export const unitEconomicsApi = {
  getReport: async ({ dateFrom, dateTo, marketplace = 'all', limit = 5000 } = {}) => {
    const params = new URLSearchParams();
    if (dateFrom) params.set('dateFrom', dateFrom);
    if (dateTo) params.set('dateTo', dateTo);
    if (marketplace) params.set('marketplace', marketplace);
    if (limit) params.set('limit', String(limit));
    const qs = params.toString();
    const r = await api.get(`/sales-analytics/unit-economics${qs ? `?${qs}` : ''}`);
    return r.data && typeof r.data === 'object' ? r.data : { data: r.data };
  },
};
