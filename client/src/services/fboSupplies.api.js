/**
 * FBO Supplies API
 */

import api from './api';

export const fboSuppliesApi = {
  purchaseCalculation: async (supplyIds) => {
    const response = await api.post('/fbo-supplies/purchase-calculation', {
      supplyIds,
    });
    return response.data?.data ?? response.data;
  },

  list: async (params = {}) => {
    const response = await api.get('/fbo-supplies', { params });
    return response.data?.data ?? response.data;
  },

  /** Склады для поля «Склад списания остатков» */
  getDeductionWarehouses: async (params = {}) => {
    const response = await api.get('/fbo-supplies/deduction-warehouses', { params });
    const body = response.data;
    if (Array.isArray(body)) return body;
    if (Array.isArray(body?.data)) return body.data;
    return [];
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

  updateSupplyItem: async (supplyId, itemId, quantity) => {
    const response = await api.patch(`/fbo-supplies/${supplyId}/items/${itemId}`, {
      quantity,
    });
    return response.data?.data ?? response.data;
  },

  replaceSupplyItem: async (supplyId, itemId, { productId, quantity }) => {
    const response = await api.patch(`/fbo-supplies/${supplyId}/items/${itemId}`, {
      productId,
      quantity,
    });
    return response.data?.data ?? response.data;
  },

  addSupplyItem: async (supplyId, { productId, quantity }) => {
    const response = await api.post(`/fbo-supplies/${supplyId}/items`, {
      productId,
      quantity,
    });
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
      params: { _: Date.now() },
      responseType: 'arraybuffer',
    });
    const cd = String(
      response.headers?.['content-disposition'] ?? response.headers?.['Content-Disposition'] ?? ''
    );
    let filename = 'fbo_supplies_import_template.xlsx';
    const utf8m = cd.match(/filename\*\s*=\s*UTF-8''([^;\s]+)/i);
    if (utf8m) {
      try {
        filename = decodeURIComponent(utf8m[1].trim());
      } catch {
        filename = utf8m[1].trim();
      }
    } else {
      const quoted = cd.match(/filename\s*=\s*"([^"]+)"/i);
      if (quoted) filename = quoted[1];
    }
    return { buffer: response.data, filename };
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

  downloadPackingExcel: async (id) => {
    const response = await api.get(`/fbo-supplies/${id}/packing/export/excel`, {
      params: { _: Date.now() },
      responseType: 'arraybuffer',
    });
    const cd = String(
      response.headers?.['content-disposition'] ?? response.headers?.['Content-Disposition'] ?? ''
    );
    let filename = `fbo_packing_${id}.xlsx`;
    const utf8m = cd.match(/filename\*\s*=\s*UTF-8''([^;\s]+)/i);
    if (utf8m) {
      try {
        filename = decodeURIComponent(utf8m[1].trim());
      } catch {
        filename = utf8m[1].trim();
      }
    } else {
      const quoted = cd.match(/filename\s*=\s*"([^"]+)"/i);
      if (quoted) filename = quoted[1];
    }
    return { buffer: response.data, filename };
  },

  updatePackingContent: async (supplyId, contentId, payload) => {
    const response = await api.patch(
      `/fbo-supplies/${supplyId}/packing/contents/${contentId}`,
      payload
    );
    return response.data?.data ?? response.data;
  },

  getPacking: async (id) => {
    const response = await api.get(`/fbo-supplies/${id}/packing`);
    return response.data?.data ?? response.data;
  },

  syncOzonPlacementZones: async (id) => {
    const response = await api.post(`/fbo-supplies/${id}/sync-ozon-placement-zones`);
    return response.data?.data ?? response.data;
  },

  submitPackingToMarketplace: async (id) => {
    const response = await api.post(`/fbo-supplies/${id}/packing/submit`);
    return response.data?.data ?? response.data;
  },

  packingScan: async (id, { barcode, activeCargoUnitId, scanMode }) => {
    const response = await api.post(`/fbo-supplies/${id}/packing/scan`, {
      barcode,
      activeCargoUnitId: activeCargoUnitId ?? null,
      ...(scanMode ? { scanMode } : {}),
    });
    return response.data?.data ?? response.data;
  },

  packingScanRemove: async (id, { barcode, activeCargoUnitId }) => {
    const response = await api.post(`/fbo-supplies/${id}/packing/scan-remove`, {
      barcode,
      activeCargoUnitId: activeCargoUnitId ?? null,
    });
    return response.data?.data ?? response.data;
  },

  updateCargoUnit: async (supplyId, cargoUnitId, patch) => {
    const response = await api.patch(
      `/fbo-supplies/${supplyId}/packing/cargo-units/${cargoUnitId}`,
      patch
    );
    return response.data?.data ?? response.data;
  },

  deleteCargoUnit: async (supplyId, cargoUnitId) => {
    const response = await api.delete(
      `/fbo-supplies/${supplyId}/packing/cargo-units/${cargoUnitId}`
    );
    return response.data?.data ?? response.data;
  },
};
