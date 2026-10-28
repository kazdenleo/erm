import api from './api.js';

export const promoPulseApi = {
  async ports() {
    const response = await api.get('/promo-pulse/ports');
    return response.data;
  },
  async listPolicies() {
    const response = await api.get('/promo-pulse/policies');
    return response.data;
  },
  async updatePolicy(id, payload) {
    const response = await api.put(`/promo-pulse/policies/${id}`, payload);
    return response.data;
  },
  async createPolicy(payload) {
    const response = await api.post('/promo-pulse/policies', payload);
    return response.data;
  },
  async preview(payload) {
    const response = await api.post('/promo-pulse/preview', payload || {});
    return response.data;
  },
  async run(payload) {
    const response = await api.post('/promo-pulse/run', payload || {});
    return response.data;
  },
  async listRuns() {
    const response = await api.get('/promo-pulse/runs');
    return response.data;
  },
  async getRun(id) {
    const response = await api.get(`/promo-pulse/runs/${id}`);
    return response.data;
  },
  async listAssignments() {
    const response = await api.get('/promo-pulse/assignments');
    return response.data;
  },
  async createAssignment(payload) {
    const response = await api.post('/promo-pulse/assignments', payload || {});
    return response.data;
  },
  async deleteAssignment(id) {
    const response = await api.delete(`/promo-pulse/assignments/${id}`);
    return response.data;
  },
  async listStates() {
    const response = await api.get('/promo-pulse/states');
    return response.data;
  },
};
