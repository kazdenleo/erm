/**
 * TN VED API — справочник кодов для настроек категории
 */

import api from './api';

export const tnVedApi = {
  searchCodes: async (opts = {}) => {
    const params = {};
    if (opts.q != null && opts.q !== '') params.q = opts.q;
    if (opts.limit != null) params.limit = opts.limit;
    const res = await api.get('/tn-ved/codes', { params: Object.keys(params).length ? params : undefined });
    return res.data;
  },

  getCode: async (code) => {
    const res = await api.get(`/tn-ved/codes/${encodeURIComponent(code)}`);
    return res.data;
  },

  checkCompatibility: async (opts = {}) => {
    const params = {};
    for (const key of ['code', 'userCategoryId', 'wbSubjectId', 'ozonDescId', 'ozonTypeId', 'organizationId']) {
      if (opts[key] != null && opts[key] !== '') params[key] = opts[key];
    }
    const res = await api.get('/tn-ved/compatibility', { params });
    return res.data;
  },
};
