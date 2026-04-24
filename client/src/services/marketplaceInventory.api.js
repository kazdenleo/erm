import api from './api';

export const marketplaceInventoryApi = {
  /** @returns {Promise<{ ok?: boolean, data?: unknown[], comparisonNote?: string, mpApiDiagnostics?: Record<string, unknown> }>} */
  getSummary: async () => {
    const r = await api.get('/marketplace-inventory/summary');
    return r.data && typeof r.data === 'object' ? r.data : { data: r.data };
  },

  /** После обновления в ответе бывает mpApiDiagnostics — срез полей из API МП. */
  runNow: async () => {
    const r = await api.post('/marketplace-inventory/run-now', {});
    return r.data && typeof r.data === 'object' ? r.data : { data: r.data };
  }
};

