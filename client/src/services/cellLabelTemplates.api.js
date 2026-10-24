/**
 * API шаблона этикетки ячейки
 */

import api from './api.js';

export const cellLabelTemplatesApi = {
  async get() {
    const response = await api.get('/cell-label-templates');
    return response.data;
  },

  async save(payload) {
    const response = await api.put('/cell-label-templates', payload);
    return response.data;
  },

  async remove() {
    const response = await api.delete('/cell-label-templates');
    return response.data;
  },

  async preview(templatePayload, opts = {}) {
    const params = { scale: String(opts.scale ?? 4) };
    const response = await api.post('/cell-label-templates/preview', templatePayload, {
      params,
      responseType: 'blob',
      timeout: 60000,
      headers: { Accept: 'image/png' },
    });
    return response.data;
  },
};
