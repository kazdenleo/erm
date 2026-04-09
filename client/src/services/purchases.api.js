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
    const response = await api.post(`/purchases/${id}/draft-items`, payload);
    return response.data?.data ?? response.data;
  },

  /** Удалить строку (если нет принятого количества): снять incoming, заказы при необходимости → «Новый» */
  removeDraftLineItem: async (purchaseId, itemId) => {
    const response = await api.delete(`/purchases/${purchaseId}/items/${itemId}`);
    return response.data?.data ?? response.data;
  },

  getById: async (id) => {
    const response = await api.get(`/purchases/${id}`);
    return response.data?.data ?? response.data;
  },

  create: async (payload) => {
    const response = await api.post('/purchases', payload);
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

  createReceipt: async (purchaseId) => {
    const response = await api.post(`/purchases/${purchaseId}/receipts`, {});
    return response.data?.data ?? response.data;
  },

  getReceipt: async (receiptId) => {
    const response = await api.get(`/purchases/receipts/${receiptId}`);
    return response.data?.data ?? response.data;
  },

  scanReceipt: async (receiptId, payload) => {
    const response = await api.post(`/purchases/receipts/${receiptId}/scan`, payload);
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

