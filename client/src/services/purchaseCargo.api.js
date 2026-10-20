/**
 * Грузоместа закупки (приёмка мест в мобильном приложении).
 */

import api from './api';

export const purchaseCargoApi = {
  getPurchase: async (purchaseId) => {
    const response = await api.get(`/purchase-cargo/purchases/${purchaseId}`);
    return response.data?.data ?? response.data;
  },

  setExpected: async (purchaseId, expectedCargoPlaces) => {
    const response = await api.put(`/purchase-cargo/purchases/${purchaseId}/expected`, {
      expectedCargoPlaces,
    });
    return response.data?.data ?? response.data;
  },

  removePlace: async (placeId) => {
    const response = await api.post(`/purchase-cargo/places/${placeId}/remove`);
    return response.data?.data ?? response.data;
  },
};
