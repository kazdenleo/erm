/**
 * FBO Supplies API
 */

import api from './api';

function parseXlsxFilename(response, fallback) {
  const cd = String(
    response.headers?.['content-disposition'] ?? response.headers?.['Content-Disposition'] ?? ''
  );
  let filename = fallback;
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
  return filename;
}

function parseApiErrorPayload(error, fallback = 'Ошибка запроса') {
  const data = error?.response?.data;
  if (data instanceof ArrayBuffer) {
    try {
      const txt = new TextDecoder().decode(data);
      const j = JSON.parse(txt);
      return j.message || j.error || txt || fallback;
    } catch {
      return fallback;
    }
  }
  if (typeof data === 'string' && data.trim()) return data;
  return data?.message || data?.error || error?.message || fallback;
}

export const fboSuppliesApi = {
  purchaseCalculation: async (supplyIds) => {
    const response = await api.post('/fbo-supplies/purchase-calculation', {
      supplyIds,
    });
    return response.data?.data ?? response.data;
  },

  listPurchaseCalcSessions: async () => {
    const response = await api.get('/fbo-supplies/purchase-calculation/sessions');
    return response.data?.data ?? response.data;
  },

  openPurchaseCalcSession: async (supplyIds) => {
    const response = await api.post('/fbo-supplies/purchase-calculation/sessions', {
      supplyIds,
    });
    return response.data?.data ?? response.data;
  },

  getPurchaseCalcSession: async (sessionId, params = {}) => {
    const response = await api.get(`/fbo-supplies/purchase-calculation/sessions/${sessionId}`, {
      params: params.supplierId ? { supplierId: params.supplierId } : undefined,
    });
    return response.data?.data ?? response.data;
  },

  createPurchaseFromCalcSession: async (sessionId, payload) => {
    const response = await api.post(
      `/fbo-supplies/purchase-calculation/sessions/${sessionId}/purchase`,
      payload,
      { timeout: 120000 }
    );
    return response.data?.data ?? response.data;
  },

  downloadPurchaseCalcExcel: async ({ supplyIds, calc }) => {
    const response = await api.post(
      '/fbo-supplies/purchase-calculation/export/excel',
      {
        supplyIds,
        supplies: calc?.supplies,
        rows: calc?.rows,
        totals: calc?.totals,
        fboWarehouse: calc?.fboWarehouse,
      },
      { responseType: 'arraybuffer' }
    );
    const date = new Date().toISOString().slice(0, 10);
    const filename = parseXlsxFilename(response, `fbo_raschet_zakupki_${date}.xlsx`);
    return { buffer: response.data, filename };
  },

  list: async (params = {}) => {
    const response = await api.get('/fbo-supplies', { params });
    return response.data?.data ?? response.data;
  },

  getWbForecast: async (params = {}) => {
    const response = await api.get('/fbo-supplies/forecast/wb', { params });
    return response.data?.data ?? response.data;
  },

  syncWbForecast: async () => {
    const response = await api.post('/fbo-supplies/forecast/wb/sync', {}, { timeout: 120000 });
    return response.data?.data ?? response.data;
  },

  exportWbForecastClusterExcel: async ({ clusterName, rows }) => {
    try {
      const response = await api.post(
        '/fbo-supplies/forecast/wb/export/excel',
        { clusterName, rows },
        { responseType: 'arraybuffer' }
      );
      const date = new Date().toISOString().slice(0, 10);
      const safeCluster = String(clusterName || 'cluster')
        .trim()
        .replace(/[^\w\u0400-\u04FF\-]+/g, '_')
        .slice(0, 40);
      const filename = parseXlsxFilename(response, `wb_postavka_${safeCluster}_${date}.xlsx`);
      return { buffer: response.data, filename };
    } catch (e) {
      throw new Error(parseApiErrorPayload(e, 'Не удалось выгрузить Excel'));
    }
  },

  /** Склады для поля «Склад списания остатков» */
  getDeductionWarehouses: async (params = {}) => {
    const response = await api.get('/fbo-supplies/deduction-warehouses', { params });
    const body = response.data;
    if (Array.isArray(body)) return body;
    if (Array.isArray(body?.data)) return body.data;
    return [];
  },

  getById: async (id, { skipReserve = false } = {}) => {
    const params = skipReserve ? { skipReserve: '1' } : undefined;
    const response = await api.get(`/fbo-supplies/${id}`, { params });
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
    let filename = parseXlsxFilename(response, 'fbo_supplies_import_template.xlsx');
    return { buffer: response.data, filename };
  },

  previewApiImport: async (payload) => {
    const response = await api.post('/fbo-supplies/import/api/preview', payload, {
      timeout: 180000,
    });
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
    const slim = supplies.map((row) => ({
      alreadyImported: row.alreadyImported,
      marketplace: row.marketplace,
      name: row.name,
      readyAt: row.readyAt,
      marketplaceWarehouseName: row.marketplaceWarehouseName,
      marketplaceWarehouseId: row.marketplaceWarehouseId,
      shippingCluster: row.shippingCluster,
      placementCluster: row.placementCluster,
      externalShipmentNumber: row.externalShipmentNumber,
      externalSupplyId: row.externalSupplyId,
      deductionWarehouseId: row.deductionWarehouseId,
      organizationId: row.organizationId,
      deductStock: row.deductStock,
      status: row.status,
      source: row.source,
      items: (row.items || []).map((it) => ({
        productId: it.productId,
        quantity: it.quantity,
        barcode: it.barcode,
        sku: it.sku,
        mpOfferId: it.mpOfferId,
        mpProductId: it.mpProductId,
        name: it.name,
        placementZone: it.placementZone,
        ozonTags: it.ozonTags,
      })),
    }));
    const response = await api.post(
      '/fbo-supplies/import/confirm',
      { supplies: slim, source },
      { timeout: 300000 }
    );
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

  syncMarketplaceStatus: async (id) => {
    const response = await api.post(`/fbo-supplies/${id}/sync-marketplace-status`, {}, { timeout: 120000 });
    return response.data?.data ?? response.data;
  },

  submitPackingToMarketplace: async (id) => {
    const response = await api.post(`/fbo-supplies/${id}/packing/submit`, {}, { timeout: 180000 });
    return response.data?.data ?? response.data;
  },

  createOzonCargoUnits: async (id, { count = 1, cargoKind = 'box' } = {}) => {
    const response = await api.post(
      `/fbo-supplies/${id}/packing/ozon-cargoes/create`,
      { count, cargoKind },
      { timeout: 180000 }
    );
    return response.data?.data ?? response.data;
  },

  syncOzonCargoUnits: async (id) => {
    const response = await api.post(
      `/fbo-supplies/${id}/packing/ozon-cargoes/sync`,
      {},
      { timeout: 120000 }
    );
    return response.data?.data ?? response.data;
  },

  downloadCargoLabels: async (id, cargoIds, { refresh = false } = {}) => {
    const ids = (cargoIds || []).filter(Boolean).join(',');
    try {
      const response = await api.get(`/fbo-supplies/${id}/packing/cargo-labels`, {
        params: { cargoIds: ids, ...(refresh ? { refresh: '1' } : {}) },
        responseType: 'arraybuffer',
        timeout: 180000,
      });
      return response.data;
    } catch (e) {
      throw new Error(parseApiErrorPayload(e, 'Не удалось скачать этикетки грузомест'));
    }
  },

  printCargoLabels: async (id, cargoIds, { refresh = false } = {}) => {
    const ids = (cargoIds || []).filter(Boolean).join(',');
    let buffer;
    try {
      const response = await api.get(`/fbo-supplies/${id}/packing/cargo-labels`, {
        params: { cargoIds: ids, ...(refresh ? { refresh: '1' } : {}) },
        responseType: 'arraybuffer',
        timeout: 180000,
      });
      buffer = response.data;
    } catch (e) {
      throw new Error(parseApiErrorPayload(e, 'Не удалось получить этикетки грузомест'));
    }
    const blob = new Blob([buffer], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const w = window.open(url, '_blank');
    if (w) {
      w.addEventListener('load', () => {
        setTimeout(() => {
          try {
            w.focus();
            w.print();
          } catch {
            /* ignore */
          }
        }, 500);
      });
    }
    setTimeout(() => URL.revokeObjectURL(url), 120000);
    return { ok: true };
  },

  syncMarketplaceContent: async (id) => {
    const response = await api.post(`/fbo-supplies/${id}/sync-marketplace-content`, {}, { timeout: 180000 });
    return response.data?.data ?? response.data;
  },

  pullMarketplaceContent: async (id) => {
    const response = await api.post(
      `/fbo-supplies/${id}/pull-marketplace-content`,
      {},
      { timeout: 300000 }
    );
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
