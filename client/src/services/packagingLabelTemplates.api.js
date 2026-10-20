/**
 * API шаблона этикетки ШК упаковки
 */

import api from './api.js';

export const packagingLabelTemplatesApi = {
  async get() {
    const response = await api.get('/packaging-label-templates');
    return response.data;
  },

  async save(payload) {
    const response = await api.put('/packaging-label-templates', payload);
    return response.data;
  },

  async remove() {
    const response = await api.delete('/packaging-label-templates');
    return response.data;
  },

  /**
   * PNG-предпросмотр по черновику шаблона.
   * @param {object} templatePayload
   * @param {{ productId?: string|number, barcode?: string, units?: string|number, scale?: number }} [opts]
   * @returns {Promise<Blob>}
   */
  async preview(templatePayload, opts = {}) {
    const params = { scale: String(opts.scale ?? 4) };
    if (opts.productId != null && opts.productId !== '') {
      params.productId = String(opts.productId);
    }
    if (opts.barcode != null && String(opts.barcode).trim()) {
      params.barcode = String(opts.barcode).trim();
    }
    if (opts.units != null && opts.units !== '') {
      params.units = String(opts.units);
    }
    const response = await api.post('/packaging-label-templates/preview', templatePayload, {
      params,
      responseType: 'blob',
      timeout: 60000,
      headers: { Accept: 'image/png' },
    });
    return response.data;
  },
};
