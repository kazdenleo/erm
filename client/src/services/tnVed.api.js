/**
 * TN VED API (справочник + привязки)
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

  getBindings: async (opts = {}) => {
    const params = {};
    if (opts.brandId != null && opts.brandId !== '') params.brandId = opts.brandId;
    if (opts.userCategoryId != null && opts.userCategoryId !== '') params.userCategoryId = opts.userCategoryId;
    const res = await api.get('/tn-ved/bindings', { params: Object.keys(params).length ? params : undefined });
    return res.data;
  },

  createBinding: async (data) => {
    const res = await api.post('/tn-ved/bindings', data);
    return res.data;
  },

  updateBinding: async (id, updates) => {
    const res = await api.put(`/tn-ved/bindings/${id}`, updates);
    return res.data;
  },

  removeBinding: async (id) => {
    const res = await api.delete(`/tn-ved/bindings/${id}`);
    return res.data;
  },
};
