import api from './api';

export const procurementForecastApi = {
  getFbsForecast: async (params = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v != null && String(v).trim() !== '') qs.set(k, String(v));
    }
    const q = qs.toString();
    const r = await api.get(`/procurement-forecast/fbs${q ? `?${q}` : ''}`);
    return r.data && typeof r.data === 'object' ? r.data : { data: r.data };
  },
  getLowStock: async (params = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v != null && String(v).trim() !== '') qs.set(k, String(v));
    }
    const q = qs.toString();
    const r = await api.get(`/procurement-forecast/low-stock${q ? `?${q}` : ''}`);
    return r.data?.data ?? r.data;
  },
};
