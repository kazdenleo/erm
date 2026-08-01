/**
 * Employee Tasks API
 */

import api from './api.js';

export const employeeTasksApi = {
  async getAll(params = {}) {
    const response = await api.get('/employee-tasks', { params });
    return response.data;
  },

  async getStats() {
    const response = await api.get('/employee-tasks/stats');
    const payload = response.data?.data ?? response.data;
    const n = payload?.openCount;
    return {
      openCount: typeof n === 'number' && Number.isFinite(n) ? n : 0,
    };
  },

  async create(data) {
    const response = await api.post('/employee-tasks', data);
    return response.data;
  },

  async complete(id) {
    const response = await api.post(`/employee-tasks/${id}/complete`);
    return response.data;
  },

  async reassign(id, assigneeId) {
    const response = await api.post(`/employee-tasks/${id}/reassign`, { assigneeId });
    return response.data;
  },
};
