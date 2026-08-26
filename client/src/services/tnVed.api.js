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
};
