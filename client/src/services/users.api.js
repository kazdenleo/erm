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

  async getAll(profileId) {
    const params = profileId != null ? { profile_id: profileId } : {};
    const response = await api.get('/users', { params });
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
  }
};
