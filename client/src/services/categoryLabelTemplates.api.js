/**
 * API шаблонов этикеток по категориям
 */

import api from './api.js';

export const categoryLabelTemplatesApi = {
  async getAll() {
    const response = await api.get('/category-label-templates');
    return response.data;
  },

  async getByCategoryId(categoryId) {
    const response = await api.get(`/category-label-templates/by-category/${categoryId}`);
    return response.data;
  },

  async save(categoryId, payload) {
    const response = await api.put(`/category-label-templates/by-category/${categoryId}`, payload);
    return response.data;
  },

  async remove(categoryId) {
    const response = await api.delete(`/category-label-templates/by-category/${categoryId}`);
    return response.data;
  },

  /**
   * PNG-предпросмотр по черновику шаблона (без сохранения).
   * @param {string|number} categoryId
   * @param {object} templatePayload
   * @param {{ productId?: string|number, scale?: number }} [opts]
   * @returns {Promise<Blob>}
   */
  async preview(categoryId, templatePayload, opts = {}) {
    const params = { scale: String(opts.scale ?? 4) };
    if (opts.productId != null && opts.productId !== '') {
      params.productId = String(opts.productId);
    }
    const response = await api.post(
      `/category-label-templates/by-category/${categoryId}/preview`,
      templatePayload,
      {
        params,
        responseType: 'blob',
        timeout: 60000,
        headers: { Accept: 'image/png' },
      }
    );
    return response.data;
  },
};
