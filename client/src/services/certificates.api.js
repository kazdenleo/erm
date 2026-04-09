/**
 * Certificates API
 */

import api from './api';

export const certificatesApi = {
  getAll: async (opts = {}) => {
    const params = {};
    if (opts.brandId != null && opts.brandId !== '') params.brandId = opts.brandId;
    if (opts.userCategoryId != null && opts.userCategoryId !== '') params.userCategoryId = opts.userCategoryId;
    const res = await api.get('/certificates', { params: Object.keys(params).length ? params : undefined });
    return res.data;
  },

  create: async (data) => {
    const res = await api.post('/certificates', data);
    return res.data;
  },

  update: async (id, updates) => {
    const res = await api.put(`/certificates/${id}`, updates);
    return res.data;
  },

  remove: async (id) => {
    const res = await api.delete(`/certificates/${id}`);
    return res.data;
  },

  uploadPhoto: async (id, file) => {
    const fd = new FormData();
    fd.append('photo', file);
    const res = await api.post(`/certificates/${id}/photo`, fd, {
      headers: { 'Content-Type': 'multipart/form-data' }
    });
    return res.data;
  },

  deletePhoto: async (id) => {
    const res = await api.delete(`/certificates/${id}/photo`);
    return res.data;
  }
};

