import api from './api';

export const salesAnalyticsApi = {
  /** Динамика продаж для главной: FBS по МП, частные заказы и FBO. */
  getHomeDynamics: async ({ dateFrom, dateTo, granularity = 'day' } = {}) => {
    const params = new URLSearchParams();
    if (dateFrom) params.set('dateFrom', dateFrom);
    if (dateTo) params.set('dateTo', dateTo);
    if (granularity) params.set('granularity', granularity);
    const r = await api.get(`/sales-analytics/home-dynamics?${params.toString()}`);
    return r.data && typeof r.data === 'object' ? r.data : { data: r.data };
  },

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

  /** @returns {Promise<{ ok?: boolean, data?: { summary, categories, period, marketplace, scheme } }>} */
  getByCategory: async ({ dateFrom, dateTo, marketplace = 'all', scheme = 'all' } = {}) => {
    const params = new URLSearchParams();
    if (dateFrom) params.set('dateFrom', dateFrom);
    if (dateTo) params.set('dateTo', dateTo);
    if (marketplace) params.set('marketplace', marketplace);
    if (scheme) params.set('scheme', scheme);
    const qs = params.toString();
    const r = await api.get(`/sales-analytics/by-category${qs ? `?${qs}` : ''}`);
    return r.data && typeof r.data === 'object' ? r.data : { data: r.data };
  },

  /** @returns {Promise<{ ok?: boolean, data?: { summary, products, period, marketplace, scheme, thresholds } }>} */
  getAbc: async ({ dateFrom, dateTo, marketplace = 'all', scheme = 'all' } = {}) => {
    const params = new URLSearchParams();
    if (dateFrom) params.set('dateFrom', dateFrom);
    if (dateTo) params.set('dateTo', dateTo);
    if (marketplace) params.set('marketplace', marketplace);
    if (scheme) params.set('scheme', scheme);
    const qs = params.toString();
    const r = await api.get(`/sales-analytics/abc${qs ? `?${qs}` : ''}`);
    return r.data && typeof r.data === 'object' ? r.data : { data: r.data };
  },

  /** @returns {Promise<{ ok?: boolean, data?: object }>} */
  getProductDynamics: async ({
    dateFrom,
    dateTo,
    comparePeriods = null,
    granularity = 'day',
    marketplace = 'all',
    scheme = 'all',
    productId = null,
  } = {}) => {
    const params = new URLSearchParams();
    if (dateFrom) params.set('dateFrom', dateFrom);
    if (dateTo) params.set('dateTo', dateTo);
    if (granularity) params.set('granularity', granularity);
    if (marketplace) params.set('marketplace', marketplace);
    if (scheme) params.set('scheme', scheme);
    if (productId != null && productId !== '') params.set('productId', String(productId));
    if (comparePeriods) {
      params.set(
        'comparePeriods',
        typeof comparePeriods === 'string' ? comparePeriods : JSON.stringify(comparePeriods)
      );
    }
    const qs = params.toString();
    const r = await api.get(`/sales-analytics/product-dynamics${qs ? `?${qs}` : ''}`);
    return r.data && typeof r.data === 'object' ? r.data : { data: r.data };
  },

  getTurnover: async ({ dateFrom, dateTo, marketplace = 'all', scheme = 'all' } = {}) => {
    const params = new URLSearchParams();
    if (dateFrom) params.set('dateFrom', dateFrom);
    if (dateTo) params.set('dateTo', dateTo);
    if (marketplace) params.set('marketplace', marketplace);
    if (scheme) params.set('scheme', scheme);
    const qs = params.toString();
    const r = await api.get(`/sales-analytics/turnover${qs ? `?${qs}` : ''}`);
    return r.data && typeof r.data === 'object' ? r.data : { data: r.data };
  },

  getCardWork: async ({
    dateFrom,
    dateTo,
    marketplace = 'all',
    scheme = 'all',
    reason = 'all',
  } = {}) => {
    const params = new URLSearchParams();
    if (dateFrom) params.set('dateFrom', dateFrom);
    if (dateTo) params.set('dateTo', dateTo);
    if (marketplace) params.set('marketplace', marketplace);
    if (scheme) params.set('scheme', scheme);
    if (reason) params.set('reason', reason);
    const qs = params.toString();
    const r = await api.get(`/sales-analytics/card-work${qs ? `?${qs}` : ''}`);
    return r.data && typeof r.data === 'object' ? r.data : { data: r.data };
  },

  getCardWorkDuplicates: async () => {
    const r = await api.get('/sales-analytics/card-work/duplicates');
    return r.data && typeof r.data === 'object' ? r.data : { data: r.data };
  },

  getCardWorkMissingCost: async () => {
    const r = await api.get('/sales-analytics/card-work/missing-cost');
    return r.data && typeof r.data === 'object' ? r.data : { data: r.data };
  },

  getLostRevenue: (params = {}) => getWithParams('/sales-analytics/lost-revenue', params),
  getReturns: (params = {}) => getWithParams('/sales-analytics/returns', params),
  getDeadStock: (params = {}) => getWithParams('/sales-analytics/dead-stock', params),
  getPenalties: (params = {}) => getWithParams('/sales-analytics/penalties', params),
  getEmployees: (params = {}) => getWithParams('/sales-analytics/employees', params),
  getPnl: (params = {}) => getWithParams('/sales-analytics/pnl', params),

  listExpenses: () => getWithParams('/sales-analytics/expenses'),
  createExpense: async (body) => unwrap(await api.post('/sales-analytics/expenses', body)),
  updateExpense: async (id, body) => unwrap(await api.put(`/sales-analytics/expenses/${id}`, body)),
  deleteExpense: async (id) => unwrap(await api.delete(`/sales-analytics/expenses/${id}`)),
};

function unwrap(r) {
  return r.data && typeof r.data === 'object' ? r.data : { data: r.data };
}

async function getWithParams(url, params = {}) {
  const search = new URLSearchParams();
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v != null && v !== '') search.set(k, String(v));
  });
  const qs = search.toString();
  return unwrap(await api.get(`${url}${qs ? `?${qs}` : ''}`));
}
