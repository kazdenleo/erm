/**
 * Suppliers API Service
 * API сервис для работы с поставщиками
 */

import api from './api';

export const suppliersApi = {
  /**
   * Получить всех поставщиков
   */
  getAll: async () => {
    const response = await api.get('/suppliers');
    return response.data;
  },

  /**
   * Создать поставщика
   */
  create: async (supplierData) => {
    const response = await api.post('/suppliers', supplierData);
    return response.data;
  },

  /**
   * Обновить поставщика
   */
  update: async (id, updates) => {
    const response = await api.put(`/suppliers/${id}`, updates);
    return response.data;
  },

  /**
   * Удалить поставщика
   */
  delete: async (id) => {
    const response = await api.delete(`/suppliers/${id}`);
    return response.data;
  },

  /**
   * Балансы взаиморасчётов по всем поставщикам
   * @returns {Promise<object[]>}
   */
  getSettlementBalances: async () => {
    const response = await api.get('/suppliers/settlements/balances');
    return Array.isArray(response.data?.data) ? response.data.data : [];
  },

  /**
   * Сводка и журнал операций по поставщику
   * @returns {Promise<{ supplier: object, summary: object, operations: object[] }|null>}
   */
  getSettlements: async (id) => {
    const response = await api.get(`/suppliers/${id}/settlements`);
    return response.data?.data ?? null;
  },

  /**
   * Ручная операция: { kind: 'payment'|'adjustment', amount?, targetBalance?, date?, comment? }
   */
  createSettlementEntry: async (id, data) => {
    const response = await api.post(`/suppliers/${id}/settlements`, data);
    return response.data?.data ?? null;
  },

  deleteSettlementEntry: async (id, entryId) => {
    const response = await api.delete(`/suppliers/${id}/settlements/${entryId}`);
    return response.data;
  },
};


