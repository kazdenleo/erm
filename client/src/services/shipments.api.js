/**
 * Shipments API (FBS)
 * Локальные поставки (Ozon, Яндекс) и создание поставки на WB + добавление заказов, QR-стикер при закрытии WB.
 */

import api from './api';

const API_BASE = process.env.REACT_APP_API_URL || '/api';

/** URL изображения QR-стикера поставки (WB, после закрытия) */
export function getQrStickerUrl(shipmentId) {
  return `${API_BASE}/shipments/${encodeURIComponent(shipmentId)}/qr-sticker`;
}

/** URL страницы печати этикетки поставки (открывает диалог печати) */
export function getQrStickerPrintUrl(shipmentId) {
  return `${API_BASE}/shipments/${encodeURIComponent(shipmentId)}/qr-sticker/print`;
}

export const shipmentsApi = {
  getAll: async () => {
    const response = await api.get('/shipments');
    const payload = response.data;
    if (payload?.data) return payload.data;
    return { marketplaces: [], list: { ozon: [], wildberries: [], yandex: [] } };
  },

  getById: async (shipmentId) => {
    const response = await api.get(`/shipments/${encodeURIComponent(shipmentId)}`);
    return response.data?.data ?? response.data;
  },

  removeOrders: async (shipmentId, orderIds) => {
    const response = await api.post(`/shipments/${encodeURIComponent(shipmentId)}/orders/remove`, { orderIds });
    return response.data?.data ?? response.data;
  },

  create: async (marketplace, name) => {
    const response = await api.post('/shipments', { marketplace, name });
    return response.data?.data ?? response.data;
  },

  addOrders: async (shipmentId, orderIds) => {
    const response = await api.post(`/shipments/${encodeURIComponent(shipmentId)}/orders`, { orderIds });
    return response.data?.data ?? response.data;
  },

  close: async (shipmentId) => {
    const response = await api.post(`/shipments/${encodeURIComponent(shipmentId)}/close`);
    return response.data?.data ?? response.data;
  }
};
