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
    const meta = payload?.meta ?? payload?.data?.meta ?? null;

    if (Array.isArray(payload)) {
      return { data: payload, meta };
    }

    if (payload?.data) {
      if (Array.isArray(payload.data)) {
        return { data: payload.data, meta };
      }
      if (Array.isArray(payload.data.orders)) {
        return { data: payload.data.orders, meta };
      }
    }

    if (Array.isArray(payload?.orders)) {
      return { data: payload.orders, meta };
    }

    return { data: [], meta };
  },

  /** Счётчики по статусам (для кнопок фильтра). */
  getStatusCounts: async (params = {}) => {
    const response = await api.get('/orders/status-counts', { params });
    return response.data?.data ?? response.data;
  },

  /** Лёгкий счётчик «Новых» (для глобального звука). */
  getNewCount: async () => {
    const response = await api.get('/orders/new-count');
    return response.data?.data ?? response.data;
  },

  /**
   * Синхронизировать FBS‑заказы со всех маркетплейсов.
   * Таймаут увеличен (90 с): Ozon + WB + Yandex + обновление статусов могут занимать больше 30 с.
   * @param {{ force?: boolean, refreshStatuses?: boolean, daysBack?: 7|14|28|90 }} [options]
   *   force — «Импортировать заказы» (полный опрос МП);
   *   refreshStatuses — «Обновить статусы» (догрузка статусов залипших «Новый» и др.);
   *   daysBack — глубина ручного импорта в днях (7, 14, 28, 90)
   */
  syncFbs: async (options = {}) => {
    const payload = {
      force: options.force === true,
      refreshStatuses: options.refreshStatuses === true
    };
    if (options.daysBack != null && [7, 14, 28, 90].includes(Number(options.daysBack))) {
      payload.daysBack = Number(options.daysBack);
    }
    const response = await api.post(
      '/orders/sync-fbs',
      payload,
      { timeout: 30000 }
    );
    return response.data;
  },

  /** Импорт / обновление одного заказа Яндекс.Маркета по orderId. */
  refreshYandex: async (orderId) => {
    const response = await api.post(`/orders/yandex/${encodeURIComponent(orderId)}/refresh`);
    return response.data?.data ?? response.data;
  },

  /** Статус ручной/фоновой синхронизации FBS (inProgress, lastSyncTime, lastSyncResult). */
  getSyncFbsStatus: async () => {
    const response = await api.get('/orders/sync-fbs/status');
    return response.data?.data ?? response.data;
  },

  resetSyncFbs: async () => {
    const response = await api.post('/orders/sync-fbs/reset');
    return response.data?.data ?? response.data;
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
  getOrderDetail: async (marketplace, orderId, options = {}) => {
    const mp = encodeURIComponent(marketplace);
    const id = encodeURIComponent(orderId);
    const params = {};
    if (options.fast === true) params.fast = '1';
    const response = await api.get(`/orders/${mp}/${id}/detail`, { params });
    return response.data?.data ?? response.data;
  },

  /** Состояние резерва по заказу (все строки группы). */
  getOrderReserve: async (marketplace, orderId) => {
    const mp = encodeURIComponent(marketplace);
    const id = encodeURIComponent(orderId);
    const response = await api.get(`/orders/${mp}/${id}/reserve`, {
      params: { fast: '1' }
    });
    return response.data?.data ?? response.data;
  },

  /**
   * Поставить / снять резерв под заказ.
   * @param {{ action?: 'toggle'|'reserve'|'unreserve', productId?: number|string, quantity?: number }} [options]
   */
  setOrderReserve: async (marketplace, orderId, options = {}) => {
    const mp = encodeURIComponent(marketplace);
    const id = encodeURIComponent(orderId);
    const body = { action: options.action ?? 'toggle' };
    if (options.productId != null) body.productId = options.productId;
    if (options.quantity != null) body.quantity = options.quantity;
    const response = await api.post(`/orders/${mp}/${id}/reserve`, body, { timeout: 120000 });
    return response.data?.data ?? response.data;
  },

  /** Отправить заказ в закупку: резерв + закупка дефицита (без API поставщика). */
  sendToProcurement: async (marketplace, orderId) => {
    const mp = encodeURIComponent(marketplace);
    const id = encodeURIComponent(orderId);
    const response = await api.post(`/orders/${mp}/${id}/send-to-procurement`, null, {
      timeout: 300000,
    });
    return response.data?.data ?? response.data;
  },

  /** Отправить открытые закупки заказа в API поставщика. */
  submitToSupplier: async (marketplace, orderId, { force = false } = {}) => {
    const mp = encodeURIComponent(marketplace);
    const id = encodeURIComponent(orderId);
    const response = await api.post(
      `/orders/${mp}/${id}/submit-to-supplier`,
      force ? { force: true } : null,
      { timeout: 300000 }
    );
    return response.data?.data ?? response.data;
  },

  /** Строки покрытия заказа (дефицит / manual_required). */
  getProcurementLines: async (marketplace, orderId) => {
    const mp = encodeURIComponent(marketplace);
    const id = encodeURIComponent(orderId);
    const response = await api.get(`/orders/${mp}/${id}/procurement-lines`);
    return response.data?.data ?? response.data;
  },

  /** Ручная закупка с выбором поставщика. */
  manualProcure: async (marketplace, orderId, body) => {
    const mp = encodeURIComponent(marketplace);
    const id = encodeURIComponent(orderId);
    const response = await api.post(`/orders/${mp}/${id}/manual-procurement`, body);
    return response.data?.data ?? response.data;
  },

  /** @deprecated — алиас submitToSupplier */
  orderAtSupplier: async (marketplace, orderId) => {
    const mp = encodeURIComponent(marketplace);
    const id = encodeURIComponent(orderId);
    const response = await api.post(`/orders/${mp}/${id}/submit-to-supplier`);
    return response.data?.data ?? response.data;
  },

  /**
   * Отправить выбранные заказы на сборку
   * @param {Array<{ marketplace: string, orderId: string }>} items
   */
  sendToAssembly: async (items, opts = {}) => {
    const response = await api.post('/orders/send-to-assembly', {
      orderIds: items,
      preserveAssembled: opts.preserveAssembled === true
    });
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

  /** Редактирование ручного заказа (статус «Новый»). */
  updateManual: async (orderGroupId, data) => {
    const id = encodeURIComponent(String(orderGroupId ?? '').trim());
    const response = await api.patch(`/orders/manual/${id}`, data);
    return response.data?.data ?? response.data;
  },

  /**
   * Перевести заказ в статус «В закупке» (из «Новый»; у WB также из pending/unknown до резолва API).
   */
  setToProcurement: async (marketplace, orderId) => {
    const mp = encodeURIComponent(marketplace);
    const id = encodeURIComponent(orderId);
    const response = await api.put(`/orders/${mp}/${id}/to-procurement`);
    return response.data?.data ?? response.data;
  },

  /** Массово в «В закупке» — один запрос вместо N (резерв пересчитывается на сервере в фоне). */
  bulkSetToProcurement: async (items) => {
    const response = await api.post('/orders/bulk-to-procurement', { items }, { timeout: 120000 });
    return response.data?.data ?? response.data;
  },

  /** Массово в «Новый» — один запрос вместо N (резерв пересчитывается на сервере в фоне). */
  bulkReturnToNew: async (items) => {
    const response = await api.post('/orders/bulk-return-to-new', { items });
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
   * stickerNumber больше не обязателен: этикетка печатается по orderId.
   */
  markCollected: async (marketplace, orderId, stickerNumber = null) => {
    const body = {
      marketplace: String(marketplace),
      orderId: String(orderId),
    };
    const sn = stickerNumber != null ? String(stickerNumber).trim() : '';
    if (sn) body.stickerNumber = sn;
    const response = await api.post('/assembly/mark-collected', body);
    return response.data?.data ?? response.data;
  }
};


