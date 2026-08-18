/**
 * API шаблонов Rich-контента по категориям
 */

import api from './api.js';

export const categoryRichContentTemplatesApi = {
  async getAll() {
    const response = await api.get('/category-rich-content-templates');
    return response.data;
  },

  async getByCategoryId(categoryId) {
    const response = await api.get(`/category-rich-content-templates/by-category/${categoryId}`);
    return response.data;
  },

  async save(categoryId, modules) {
    const response = await api.put(`/category-rich-content-templates/by-category/${categoryId}`, {
      modules,
    });
    return response.data;
  },

  async getShared() {
    const response = await api.get('/category-rich-content-templates/shared');
    return response.data;
  },

  async saveShared(modules) {
    const response = await api.put('/category-rich-content-templates/shared', { modules });
    return response.data;
  },

  async removeShared() {
    const response = await api.delete('/category-rich-content-templates/shared');
    return response.data;
  },

  async unify(modules) {
    const response = await api.post('/category-rich-content-templates/unify', { modules });
    return response.data;
  },

  async remove(categoryId) {
    const response = await api.delete(`/category-rich-content-templates/by-category/${categoryId}`);
    return response.data;
  },

  async syncFields(categoryId, { modules, marketplace = 'ozon' } = {}) {
    const response = await api.post(
      `/category-rich-content-templates/by-category/${categoryId}/sync-fields`,
      { modules, marketplace },
      { timeout: 60000 }
    );
    return response.data;
  },

  async uploadBackground(file) {
    const form = new FormData();
    form.append('file', file);
    const response = await api.post('/category-rich-content-templates/background', form, {
      timeout: 60000,
    });
    return response.data;
  },
};
