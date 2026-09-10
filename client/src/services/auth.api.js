/**
 * Auth API Service
 */

import api from './api.js';

export const authApi = {
  /** Публичная регистрация: новый аккаунт, пароль уходит на email */
  async registerAccount(payload) {
    const response = await api.post('/auth/register-account', payload);
    return response.data;
  },

  async login(login, password) {
    const value = String(login || '').trim();
    const response = await api.post('/auth/login', { login: value, email: value, password });
    return response.data;
  },

  async me() {
    const response = await api.get('/auth/me');
    return response.data;
  },

  async changePassword(currentPassword, newPassword) {
    const response = await api.post('/auth/change-password', { currentPassword, newPassword });
    return response.data;
  }
};
