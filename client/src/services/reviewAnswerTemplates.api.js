/**
 * Шаблоны ответов на отзывы
 */

import api from './api';

export const reviewAnswerTemplatesApi = {
  getAll: async () => {
    const response = await api.get('/reviews/answer-templates');
    const payload = response.data;
    if (Array.isArray(payload?.data)) return payload.data;
    if (Array.isArray(payload)) return payload;
    return [];
  },

  create: async ({ title, body, sortOrder }) => {
    const response = await api.post('/reviews/answer-templates', { title, body, sortOrder });
    return response.data?.data ?? response.data;
  },

  update: async (id, { title, body, sortOrder }) => {
    const response = await api.put(`/reviews/answer-templates/${encodeURIComponent(id)}`, {
      title,
      body,
      sortOrder,
    });
    return response.data?.data ?? response.data;
  },

  remove: async (id) => {
    await api.delete(`/reviews/answer-templates/${encodeURIComponent(id)}`);
  },
};

export const reviewAutoReplyRulesApi = {
  getAll: async () => {
    const response = await api.get('/reviews/auto-reply-rules');
    const payload = response.data;
    if (Array.isArray(payload?.data)) return payload.data;
    if (Array.isArray(payload)) return payload;
    return [];
  },

  saveAll: async (rules) => {
    const response = await api.put('/reviews/auto-reply-rules', { rules });
    return response.data;
  },

  runNow: async () => {
    const response = await api.post('/reviews/auto-reply-rules/run');
    return response.data?.data ?? response.data;
  },
};
