/**
 * FBO Supplies API
 */

import api from './api';

export const fboSuppliesApi = {
  list: async (params = {}) => {
    const response = await api.get('/fbo-supplies', { params });
    return response.data?.data ?? response.data;
  },

  getById: async (id) => {
    const response = await api.get(`/fbo-supplies/${id}`);
    return response.data?.data ?? response.data;
  },

  create: async (payload) => {
    const response = await api.post('/fbo-supplies', payload);
    return response.data?.data ?? response.data;
  },

  update: async (id, payload) => {
    const response = await api.put(`/fbo-supplies/${id}`, payload);
    return response.data?.data ?? response.data;
  },

  advanceStatus: async (id) => {
    const response = await api.post(`/fbo-supplies/${id}/advance-status`, {});
    return response.data?.data ?? response.data;
  },

  delete: async (id) => {
    const response = await api.delete(`/fbo-supplies/${id}`);
    return response.data?.data ?? response.data;
  },

  downloadImportTemplate: async () => {
    const response = await api.get('/fbo-supplies/import/template/excel', {
      responseType: 'blob',
    });
    return response.data;
  },

  previewApiImport: async (payload) => {
    const response = await api.post('/fbo-supplies/import/api/preview', payload);
    return response.data?.data ?? response.data;
  },

  previewExcelImport: async (file) => {
    const form = new FormData();
    form.append('file', file);
    const response = await api.post('/fbo-supplies/import/excel/preview', form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return response.data?.data ?? response.data;
  },

  confirmImport: async (supplies, source = 'api') => {
    const response = await api.post('/fbo-supplies/import/confirm', { supplies, source });
    return response.data?.data ?? response.data;
  },
};
