/**
 * ОКПД2 API — справочник кодов для категории и карточки товара
 */

import api from './api';

export const okpd2Api = {
  searchCodes: async (opts = {}) => {
    const params = {};
    if (opts.q != null && opts.q !== '') params.q = opts.q;
    if (opts.limit != null) params.limit = opts.limit;
    const res = await api.get('/okpd2/codes', { params: Object.keys(params).length ? params : undefined });
    return res.data;
  },

  getCode: async (code) => {
    const res = await api.get(`/okpd2/codes/${encodeURIComponent(code)}`);
    return res.data;
  },
};
