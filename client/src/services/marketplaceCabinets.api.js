/**
 * Marketplace Cabinets API
 * Кабинеты маркетплейсов по организациям
 */

import api from './api.js';

export const marketplaceCabinetsApi = {
  list(organizationId, type = null) {
    const params = type ? { type } : {};
    return api.get(`/organizations/${organizationId}/marketplace-cabinets`, { params }).then((r) => r.data);
  },

  getById(organizationId, id) {
    return api.get(`/organizations/${organizationId}/marketplace-cabinets/${id}`).then((r) => r.data);
  },

  create(organizationId, data) {
    return api.post(`/organizations/${organizationId}/marketplace-cabinets`, data).then((r) => r.data);
  },

  update(organizationId, id, data) {
    return api.put(`/organizations/${organizationId}/marketplace-cabinets/${id}`, data).then((r) => r.data);
  },

  delete(organizationId, id) {
    return api.delete(`/organizations/${organizationId}/marketplace-cabinets/${id}`).then((r) => r.data);
  }
};
