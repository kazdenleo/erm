/**
 * Вопросы покупателей с маркетплейсов
 */

import api from './api';

export const questionsApi = {
  /**
   * @param {object} [params] marketplace, limit, offset
   * @returns {Promise<Array>}
   */
  getAll: async (params = {}) => {
    const response = await api.get('/questions', { params });
    const payload = response.data;
    if (Array.isArray(payload?.data)) return payload.data;
    if (Array.isArray(payload)) return payload;
    return [];
  },

  /**
   * Счётчики: newCount — новые вопросы по всем МП (бейдж); counts — всего/новые/отвеченные с учётом marketplace.
   * @param {object} [params] marketplace — при «всех МП» не передавать или all
   * @returns {Promise<{ newCount: number, counts: { all: number, new: number, answered: number } }>}
   */
  getStats: async (params = {}) => {
    const response = await api.get('/questions/stats', { params });
    const payload = response.data?.data ?? response.data;
    const n = payload?.newCount;
    const c = payload?.counts;
    const byMp = payload?.countsByMarketplace ?? {};
    return {
      newCount: typeof n === 'number' && Number.isFinite(n) ? n : 0,
      counts: {
        all: typeof c?.all === 'number' && Number.isFinite(c.all) ? c.all : 0,
        new: typeof c?.new === 'number' && Number.isFinite(c.new) ? c.new : 0,
        answered: typeof c?.answered === 'number' && Number.isFinite(c.answered) ? c.answered : 0,
      },
      countsByMarketplace: {
        ozon: typeof byMp.ozon === 'number' && Number.isFinite(byMp.ozon) ? byMp.ozon : 0,
        wildberries:
          typeof byMp.wildberries === 'number' && Number.isFinite(byMp.wildberries) ? byMp.wildberries : 0,
        yandex: typeof byMp.yandex === 'number' && Number.isFinite(byMp.yandex) ? byMp.yandex : 0,
      },
    };
  },

  /**
   * Синхронизация с API маркетплейса (или всех подряд).
   * @param {object} [params] marketplace — 'ozon' | 'wildberries' | 'yandex' (опционально)
   * @returns {Promise<{ results: Array<{ marketplace, ok, imported, error }> }>}
   */
  sync: async (params = {}) => {
    const response = await api.post('/questions/sync', {}, { params });
    const payload = response.data;
    return payload?.data ?? payload;
  },

  /**
   * Отправить ответ на вопрос (в API маркетплейса).
   * @param {string} id — id строки в нашей БД
   * @param {string} text
   */
  answer: async (id, text) => {
    const response = await api.post(`/questions/${encodeURIComponent(id)}/answer`, { text });
    const payload = response.data;
    return payload?.data ?? payload;
  },
};
