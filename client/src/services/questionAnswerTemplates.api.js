/**
 * Шаблоны быстрых ответов на вопросы маркетплейсов
 */

import api from './api';

export const questionAnswerTemplatesApi = {
  getAll: async () => {
    const response = await api.get('/questions/answer-templates');
    const payload = response.data;
    if (Array.isArray(payload?.data)) return payload.data;
    if (Array.isArray(payload)) return payload;
    return [];
  },

  create: async ({ title, body, sortOrder }) => {
    const response = await api.post('/questions/answer-templates', { title, body, sortOrder });
    return response.data?.data ?? response.data;
  },

  update: async (id, { title, body, sortOrder }) => {
    const response = await api.put(`/questions/answer-templates/${encodeURIComponent(id)}`, {
      title,
      body,
      sortOrder,
    });
    return response.data?.data ?? response.data;
  },

  remove: async (id) => {
    await api.delete(`/questions/answer-templates/${encodeURIComponent(id)}`);
  },
};
