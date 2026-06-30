/**
 * Purchases API
 */

import api from './api';

export const purchasesApi = {
  list: async (params = {}) => {
    const response = await api.get('/purchases', { params });
    return response.data?.data ?? response.data;
  },

  /** Добавить позиции в закупку (incoming по дельте количества) */
  appendDraftItems: async (id, payload) => {
    const response = await api.post(`/purchases/${id}/draft-items`, payload, { timeout: 120000 });
    return response.data?.data ?? response.data;
  },

  /**
   * Уменьшить ожидание по строке. reduceBy — на сколько шт. (не больше непринятого); без параметра — снять всё непринятое.
   */
  removeDraftLineItem: async (purchaseId, itemId, options = {}) => {
    const { reduceBy } = options;
    const hasExplicit =
      reduceBy != null && reduceBy !== '' && Number.isFinite(Number(reduceBy));
    const config = {};
    if (hasExplicit) {
      const rb = Math.floor(Number(reduceBy));
      // query — надёжнее DELETE body за nginx; body дублируем для совместимости.
      config.params = { reduceBy: rb };
      config.data = { reduceBy: rb };
    }
    const response = await api.delete(`/purchases/${purchaseId}/items/${itemId}`, config);
    return response.data?.data ?? response.data;
  },

  getById: async (id) => {
    const response = await api.get(`/purchases/${id}`);
    return response.data?.data ?? response.data;
  },

  submitToSupplier: async (id, { force = false } = {}) => {
    const response = await api.post(
      `/purchases/${id}/submit-to-supplier`,
      { force: Boolean(force) },
      { timeout: 300000 }
    );
    return response.data?.data ?? response.data;
  },

  /** Закупка из заказов + статус «В закупке» одним запросом */
  procureFromOrders: async (payload) => {
    const response = await api.post('/purchases/procure-from-orders', payload, { timeout: 300000 });
    return response.data?.data ?? response.data;
  },

  create: async (payload) => {
    const response = await api.post('/purchases', payload, { timeout: 120000 });
    return response.data?.data ?? response.data;
  },

  /**
   * Создать закупку из Excel (колонки: артикул, количество).
   * @param {FormData} formData — file, supplierId, organizationId, warehouseId
   */
  importFromExcel: async (formData) => {
    const response = await api.post('/purchases/import/excel', formData);
    return response.data?.data ?? response.data;
  },

  /** Разбор Excel в таблицу новой закупки (без создания документа). */
  previewExcelImport: async (formData) => {
    const response = await api.post('/purchases/import/excel/preview', formData);
    return response.data?.data ?? response.data;
  },

  /** Догон incoming/даты для старых данных и повторная выкладка резервов по строкам закупки */
  markOrdered: async (id) => {
    const response = await api.post(`/purchases/${id}/mark-ordered`, {});
    return response.data?.data ?? response.data;
  },

  updatePurchase: async (id, payload) => {
    const response = await api.put(`/purchases/${id}`, payload);
    return response.data?.data ?? response.data;
  },

  updatePurchaseItem: async (purchaseId, itemId, payload) => {
    const response = await api.put(`/purchases/${purchaseId}/items/${itemId}`, payload);
    return response.data?.data ?? response.data;
  },

  createExpectedReceipt: async (purchaseId) => {
    const response = await api.post(`/purchases/${purchaseId}/receipts/expected`, {});
    return response.data?.data ?? response.data;
  },

  saveExpectedReceiptItems: async (receiptId, items) => {
    const response = await api.put(`/purchases/receipts/${receiptId}/expected-items`, { items });
    return response.data?.data ?? response.data;
  },

  applyExpectedReceipt: async (purchaseId) => {
    const response = await api.post(`/purchases/${purchaseId}/apply-expected`, {});
    return response.data?.data ?? response.data;
  },

  createReceipt: async (purchaseId, options = {}) => {
    const response = await api.post(`/purchases/${purchaseId}/receipts`, options);
    return response.data?.data ?? response.data;
  },

  getReceipt: async (receiptId) => {
    const response = await api.get(`/purchases/receipts/${receiptId}`);
    return response.data?.data ?? response.data;
  },

  updateReceipt: async (receiptId, payload) => {
    const response = await api.put(`/purchases/receipts/${receiptId}`, payload);
    return response.data?.data ?? response.data;
  },

  scanReceipt: async (receiptId, payload) => {
    const response = await api.post(`/purchases/receipts/${receiptId}/scan`, payload);
    return response.data?.data ?? response.data;
  },

  /** Ручной ввод: добавить сразу N штук в приёмку (без N сканов). */
  addReceiptQuantity: async (receiptId, payload) => {
    const response = await api.post(`/purchases/receipts/${receiptId}/add-quantity`, payload);
    return response.data?.data ?? response.data;
  },

  /** Ручная установка принятого количества по строке приёмки. */
  setReceiptItemQuantity: async (receiptId, payload) => {
    const response = await api.post(`/purchases/receipts/${receiptId}/set-quantity`, payload);
    return response.data?.data ?? response.data;
  },

  inviteToReceipt: async (receiptId, payload) => {
    const response = await api.post(`/purchases/receipts/${receiptId}/invite`, payload);
    return response.data?.data ?? response.data;
  },

  completeReceipt: async (receiptId, payload = {}) => {
    const response = await api.post(`/purchases/receipts/${receiptId}/complete`, payload);
    return response.data?.data ?? response.data;
  },

  resolveExtras: async (receiptId, payload) => {
    const response = await api.post(`/purchases/receipts/${receiptId}/resolve-extras`, payload);
    return response.data?.data ?? response.data;
  },

  deleteReceipt: async (receiptId) => {
    const response = await api.delete(`/purchases/receipts/${receiptId}`);
    return response.data?.data ?? response.data;
  },

  deletePurchase: async (purchaseId) => {
    const response = await api.delete(`/purchases/${purchaseId}`);
    return response.data?.data ?? response.data;
  },
};

