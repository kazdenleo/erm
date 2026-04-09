/**
 * Profiles API Service (для администратора)
 */

import api from './api.js';

export const profilesApi = {
  /** Текущий аккаунт (администратор аккаунта) */
  async getMe() {
    const response = await api.get('/profiles/me');
    return response.data;
  },

  async updateMe(data) {
    const response = await api.put('/profiles/me', data);
    return response.data;
  },

  async getAll() {
    const response = await api.get('/profiles');
    return response.data;
  },

  async getById(id) {
    const response = await api.get(`/profiles/${id}`);
    return response.data;
  },

  /** Карточка аккаунта: профиль, счётчики, история обращений */
  async getCabinet(id) {
    const response = await api.get(`/profiles/${id}/cabinet`);
    return response.data;
  },

  async create(data) {
    const response = await api.post('/profiles', data);
    return response.data;
  },

  async update(id, data) {
    const response = await api.put(`/profiles/${id}`, data);
    return response.data;
  },

  async delete(id) {
    const response = await api.delete(`/profiles/${id}`);
    return response.data;
  }
};
