/**
 * Users API Service
 */

import api from './api.js';

export const usersApi = {
  async getMe() {
    const response = await api.get('/users/me');
    return response.data;
  },

  async updateMe(data) {
    const response = await api.put('/users/me', data);
    return response.data;
  },

  async getHomeWidgets() {
    const response = await api.get('/users/me/home-widgets');
    return response.data?.data ?? { items: null };
  },

  async saveHomeWidgets(items) {
    const response = await api.put('/users/me/home-widgets', { items });
    return response.data?.data ?? { items };
  },

  async resetHomeWidgets() {
    const response = await api.put('/users/me/home-widgets', { reset: true });
    return response.data?.data ?? { items: null };
  },

  async getAll(profileId) {
    const params = profileId != null ? { profile_id: profileId } : {};
    const response = await api.get('/users', { params });
    return response.data;
  },

  /** Администраторы продукта (role=admin, без профиля клиента). */
  async getPlatformAdmins() {
    const response = await api.get('/users', { params: { scope: 'platform_admins' } });
    return response.data;
  },

  async getInviteCandidates() {
    const response = await api.get('/users/invite-candidates');
    return response.data;
  },

  async getById(id) {
    const response = await api.get(`/users/${id}`);
    return response.data;
  },

  async create(data) {
    const response = await api.post('/users', data);
    return response.data;
  },

  async update(id, data) {
    const response = await api.put(`/users/${id}`, data);
    return response.data;
  },

  async delete(id) {
    const response = await api.delete(`/users/${id}`);
    return response.data;
  },

  /**
   * Сводка зарплат за период.
   * @param {{ dateFrom?: string, dateTo?: string, yearMonth?: string }|string} period
   */
  async getPayroll(period, profileId) {
    const params = {};
    if (typeof period === 'string') {
      params.yearMonth = period;
    } else if (period && typeof period === 'object') {
      if (period.dateFrom) params.dateFrom = period.dateFrom;
      if (period.dateTo) params.dateTo = period.dateTo;
      if (period.yearMonth) params.yearMonth = period.yearMonth;
    }
    if (profileId != null) params.profile_id = profileId;
    const response = await api.get('/users/payroll', { params });
    return response.data;
  },

  async getUserPayroll(id, period, profileId) {
    const params = {};
    if (typeof period === 'string') {
      params.yearMonth = period;
    } else if (period && typeof period === 'object') {
      if (period.dateFrom) params.dateFrom = period.dateFrom;
      if (period.dateTo) params.dateTo = period.dateTo;
      if (period.yearMonth) params.yearMonth = period.yearMonth;
    }
    if (profileId != null) params.profile_id = profileId;
    const response = await api.get(`/users/${id}/payroll`, { params });
    return response.data;
  },

  async replaceUserAbsences(id, { yearMonth, dates, dateFrom, dateTo }, profileId) {
    const body = { yearMonth, dates };
    if (dateFrom) body.dateFrom = dateFrom;
    if (dateTo) body.dateTo = dateTo;
    if (profileId != null) body.profileId = profileId;
    const response = await api.put(`/users/${id}/absences`, body);
    return response.data;
  },

  async toggleUserAbsence(id, { date, present, dateFrom, dateTo }, profileId) {
    const body = { date };
    if (present !== undefined) body.present = present;
    if (dateFrom) body.dateFrom = dateFrom;
    if (dateTo) body.dateTo = dateTo;
    if (profileId != null) body.profileId = profileId;
    const response = await api.post(`/users/${id}/absences/toggle`, body);
    return response.data;
  },
};
