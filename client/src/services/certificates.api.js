/**
 * Certificates API
 */

import api from './api';

export const certificatesApi = {
  getAll: async (opts = {}) => {
    const params = {};
    if (opts.brandId != null && opts.brandId !== '') params.brandId = opts.brandId;
    if (opts.userCategoryId != null && opts.userCategoryId !== '') params.userCategoryId = opts.userCategoryId;
    if (opts.includeExpired === false) params.includeExpired = false;
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

  remove: async (id, { deleteOzon = false, deleteYm = false } = {}) => {
    const params = {};
    if (deleteOzon) params.deleteOzon = 1;
    if (deleteYm) params.deleteYm = 1;
    const res = await api.delete(`/certificates/${id}`, {
      params: Object.keys(params).length ? params : undefined,
      timeout: 120000,
    });
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
  },

  pushToOzon: async (id, body = {}) => {
    const res = await api.post(`/certificates/${id}/push-ozon`, body, { timeout: 180000 });
    return res.data;
  },

  ozonAccordanceTypes: async () => {
    const res = await api.get('/certificates/ozon/accordance-types');
    return res.data;
  },

  pushToYm: async (id, body = {}) => {
    const res = await api.post(`/certificates/${id}/push-ym`, body, { timeout: 180000 });
    return res.data;
  },

  ymDocumentTypes: async () => {
    const res = await api.get('/certificates/ym/document-types');
    return res.data;
  },

  importFromMarketplaces: async () => {
    const res = await api.post('/certificates/import-from-marketplaces', {}, { timeout: 600000 });
    return res.data;
  },

  syncStatus: async (id) => {
    const res = await api.post(`/certificates/${id}/sync-status`, {}, { timeout: 120000 });
    return res.data;
  },

  syncStatuses: async ({ force = false } = {}) => {
    const res = await api.post('/certificates/sync-statuses', { force }, { timeout: 120000 });
    return res.data;
  },
};

