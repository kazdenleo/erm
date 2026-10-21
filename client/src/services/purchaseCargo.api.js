/**
 * Грузоместа закупки: приёмка мест и товара из них (веб / мобильное приложение).
 */

import api from './api';

const unwrap = (response) => response.data?.data ?? response.data;

export const purchaseCargoApi = {
  getPurchase: async (purchaseId) => {
    const response = await api.get(`/purchase-cargo/purchases/${purchaseId}`);
    return unwrap(response);
  },

  setExpected: async (purchaseId, expectedCargoPlaces) => {
    const response = await api.put(`/purchase-cargo/purchases/${purchaseId}/expected`, {
      expectedCargoPlaces,
    });
    return unwrap(response);
  },

  acceptPlace: async (purchaseId, barcode, { force = false, forceExceed = false } = {}) => {
    const response = await api.post(`/purchase-cargo/purchases/${purchaseId}/places`, {
      barcode,
      force: force === true,
      forceExceed: forceExceed === true,
    });
    return unwrap(response);
  },

  getPlace: async (placeId) => {
    const response = await api.get(`/purchase-cargo/places/${placeId}`);
    return unwrap(response);
  },

  removePlace: async (placeId) => {
    const response = await api.post(`/purchase-cargo/places/${placeId}/remove`);
    return unwrap(response);
  },

  openPlace: async (placeId) => {
    const response = await api.post(`/purchase-cargo/places/${placeId}/open`);
    return unwrap(response);
  },

  closePlace: async (placeId) => {
    const response = await api.post(`/purchase-cargo/places/${placeId}/close`);
    return unwrap(response);
  },

  addItem: async (placeId, { code = null, productId = null, quantity = 1 } = {}) => {
    const response = await api.post(`/purchase-cargo/places/${placeId}/items`, {
      code,
      productId,
      quantity,
    });
    return unwrap(response);
  },

  setItemQuantity: async (placeId, productId, quantity) => {
    const response = await api.post(`/purchase-cargo/places/${placeId}/items/set`, {
      productId,
      quantity,
    });
    return unwrap(response);
  },
};

/** Код ошибки из ответа API (PRODUCT_BARCODE, EXPECTED_EXCEEDED, …). */
export function purchaseCargoErrorCode(error) {
  return error?.response?.data?.code || null;
}

export function purchaseCargoErrorData(error) {
  return error?.response?.data?.data ?? null;
}
