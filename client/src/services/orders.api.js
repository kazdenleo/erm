/**
 * Orders API Service
 * API сервис для работы с заказами
 */

import api from './api';

export const ordersApi = {
  /**
   * Получить все заказы
   * Нормализуем ответ, т.к. старый backend возвращает data.orders,
   * а новый может вернуть массив напрямую.
   */
  getAll: async (params = {}) => {
    const response = await api.get('/orders', { params });
    const payload = response.data;

    if (Array.isArray(payload)) {
      return payload;
    }

    if (payload?.data) {
      if (Array.isArray(payload.data)) {
        return payload.data;
      }
      if (Array.isArray(payload.data.orders)) {
        return payload.data.orders;
      }
    }

    if (Array.isArray(payload?.orders)) {
      return payload.orders;
    }

    return [];
  },

  /**
   * Синхронизировать FBS‑заказы со всех маркетплейсов.
   * Таймаут увеличен (90 с): Ozon + WB + Yandex + обновление статусов могут занимать больше 30 с.
   * @param {{ force?: boolean }} [options] — force: «Импортировать заказы» — всегда полный опрос МП (минутный лимит на бэкенде не применяется)
   */
  syncFbs: async (options = {}) => {
    const response = await api.post('/orders/sync-fbs', { force: options.force === true }, { timeout: 90000 });
    return response.data;
  },

  /** Статус паузы фоновой синхронизации (сервер + не опрашивать список по таймеру на клиенте). */
  getOrdersFbsSyncPause: async () => {
    const response = await api.get('/orders/sync-auto-pause');
    return response.data?.data ?? response.data;
  },

  /** Включить/выключить фоновую синхронизацию заказов с маркетплейсами. */
  setOrdersFbsSyncPause: async (paused) => {
    const response = await api.post('/orders/sync-auto-pause', { paused: Boolean(paused) });
    return response.data?.data ?? response.data;
  },

  /**
   * Принудительно обновить заказ Ozon по orderId (posting_number)
   */
  refreshOzonOrder: async (orderId) => {
    const encodedId = encodeURIComponent(orderId);
    const response = await api.post(`/orders/ozon/${encodedId}/refresh`, {});
    return response.data;
  },

  /**
   * Получить детальную информацию по заказу (Ozon: fbs/get, WB: заказ из списка)
   */
  getOrderDetail: async (marketplace, orderId) => {
    const mp = encodeURIComponent(marketplace);
    const id = encodeURIComponent(orderId);
    const response = await api.get(`/orders/${mp}/${id}/detail`);
    return response.data?.data ?? response.data;
  },

  /**
   * Отправить выбранные заказы на сборку
   * @param {Array<{ marketplace: string, orderId: string }>} items
   */
  sendToAssembly: async (items) => {
    const response = await api.post('/orders/send-to-assembly', { orderIds: items });
    return response.data?.data ?? response.data;
  },

  /** Исправить резервы для заказов «В закупке» (снять и поставить заново по текущим правилам). */
  rebuildProcurementReserves: async () => {
    const response = await api.post('/orders/reserves/rebuild-procurement', {});
    return response.data?.data ?? response.data;
  },

  /**
   * Ручное добавление заказа: один товар или несколько.
   * @param {{ productId?: number, quantity?: number, items?: Array<{ productId: number, quantity: number }> }} data
   */
  createManual: async (data) => {
    const response = await api.post('/orders/manual', data);
    return response.data?.data ?? response.data;
  },

  /**
   * Перевести заказ в статус «В закупке» (только из статуса «Новый»).
   */
  setToProcurement: async (marketplace, orderId) => {
    const mp = encodeURIComponent(marketplace);
    const id = encodeURIComponent(orderId);
    const response = await api.put(`/orders/${mp}/${id}/to-procurement`);
    return response.data?.data ?? response.data;
  },

  /**
   * Вернуть заказ в статус «Новый» (со сборки или «Собран»).
   */
  returnToNew: async (marketplace, orderId) => {
    const mp = encodeURIComponent(marketplace);
    const id = encodeURIComponent(orderId);
    const response = await api.put(`/orders/${mp}/${id}/return-to-new`);
    return response.data?.data ?? response.data;
  },

  /**
   * Отметить заказ как отгруженный (для ручных заказов — тестирование).
   */
  markShipped: async (marketplace, orderId) => {
    const mp = encodeURIComponent(marketplace);
    const id = encodeURIComponent(orderId);
    const response = await api.put(`/orders/${mp}/${id}/mark-shipped`);
    return response.data?.data ?? response.data;
  },

  /**
   * Отменить заказ на стороне МП (если поддерживается API) и локально.
   */
  cancelOrder: async (marketplace, orderId) => {
    const mp = encodeURIComponent(marketplace);
    const id = encodeURIComponent(orderId);
    const response = await api.put(`/orders/${mp}/${id}/cancel-marketplace`);
    return response.data?.data ?? response.data;
  },

  /** @deprecated используйте cancelOrder */
  cancelWildberries: async (marketplace, orderId) => {
    const mp = encodeURIComponent(marketplace);
    const id = encodeURIComponent(orderId);
    const response = await api.put(`/orders/${mp}/${id}/cancel-marketplace`);
    return response.data?.data ?? response.data;
  },

  /**
   * Удалить заказ (только ручные; при группе удаляется вся группа).
   */
  deleteOrder: async (marketplace, orderId) => {
    const mp = encodeURIComponent(marketplace);
    const id = encodeURIComponent(orderId);
    const response = await api.delete(`/orders/${mp}/${id}`);
    return response.data?.data ?? response.data;
  }
};

/**
 * API сборки: поиск заказа по штрихкоду товара
 */
export const assemblyApi = {
  findOrderByBarcode: async (barcode) => {
    const response = await api.get('/assembly/find-by-barcode', {
      params: { barcode: String(barcode).trim() }
    });
    return response.data?.data ?? response.data;
  },

  /**
   * Отметить заказ как собранный (статус «Собран», убрать из списка сборки)
   */
  markCollected: async (marketplace, orderId) => {
    const response = await api.post('/assembly/mark-collected', {
      marketplace: String(marketplace),
      orderId: String(orderId)
    });
    return response.data?.data ?? response.data;
  }
};


