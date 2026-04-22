/**
 * Вопросы покупателей с маркетплейсов: список из БД + синхронизация из API Ozon / WB / Яндекс.
 */

import {
  getMarketplaceQuestionById,
  getMarketplaceQuestionsStats,
  listMarketplaceQuestions,
  submitMarketplaceQuestionAnswer,
  syncMarketplaceQuestions,
} from '../services/marketplaceQuestions.service.js';
import { tenantListProfileId, TENANT_LIST_EMPTY } from '../utils/tenantListProfileId.js';

class QuestionsController {
  async getOne(req, res, next) {
    try {
      const tid = tenantListProfileId(req);
      if (tid === TENANT_LIST_EMPTY || tid == null) {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(200).json({ ok: true, data: null });
      }
      const item = await getMarketplaceQuestionById(tid, req.params.id);
      if (!item) {
        return res.status(404).json({ ok: false, message: 'Вопрос не найден' });
      }
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ ok: true, data: item });
    } catch (error) {
      next(error);
    }
  }

  async getList(req, res, next) {
    try {
      const tid = tenantListProfileId(req);
      if (tid === TENANT_LIST_EMPTY) {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(200).json({ ok: true, data: [] });
      }
      if (tid == null) {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(200).json({ ok: true, data: [] });
      }
      const items = await listMarketplaceQuestions(tid, req.query || {});
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ ok: true, data: items });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /questions/stats — newCount (новые по всем МП, для бейджа); counts — разбивка с опц. ?marketplace=
   */
  async getStats(req, res, next) {
    try {
      const tid = tenantListProfileId(req);
      if (tid === TENANT_LIST_EMPTY || tid == null) {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(200).json({
          ok: true,
          data: { newCount: 0, counts: { all: 0, new: 0, answered: 0 } },
        });
      }
      const data = await getMarketplaceQuestionsStats(tid, req.query || {});
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ ok: true, data });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /questions/sync?marketplace=ozon — только один МП; без параметра — по очереди все три.
   */
  async sync(req, res, next) {
    try {
      const pid = req.user?.profileId;
      if (pid == null || pid === '') {
        return res.status(403).json({ ok: false, message: 'Нет привязки к аккаунту.' });
      }
      const onlyRaw = req.query?.marketplace;
      const only =
        onlyRaw != null && String(onlyRaw).trim() !== '' ? String(onlyRaw).trim().toLowerCase() : null;
      const data = await syncMarketplaceQuestions(pid, { only });
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ ok: true, data });
    } catch (error) {
      if (error.statusCode === 400 || error.statusCode === 501) {
        return res.status(error.statusCode).json({ ok: false, message: error.message });
      }
      next(error);
    }
  }

  /**
   * POST /questions/:id/answer — тело { text }
   */
  async answer(req, res, next) {
    try {
      const pid = req.user?.profileId;
      if (pid == null || pid === '') {
        return res.status(403).json({ ok: false, message: 'Нет привязки к аккаунту.' });
      }
      const text = req.body?.text;
      const data = await submitMarketplaceQuestionAnswer(pid, req.params.id, text);
      res.setHeader('Cache-Control', 'no-store');
      const isPendingWb =
        data?.marketplace === 'wildberries' && (data?.status === 'pending_wb_confirm' || !!data?.pendingAnswerText);
      return res.status(isPendingWb ? 202 : 200).json({ ok: true, data, pending: isPendingWb });
    } catch (error) {
      if (error.statusCode === 400 || error.statusCode === 404 || error.statusCode === 501) {
        return res.status(error.statusCode).json({ ok: false, message: error.message });
      }
      if (error.code === 'OZON_PREMIUM_PLUS_REQUIRED') {
        return res.status(403).json({ ok: false, message: error.message, code: error.code });
      }
      next(error);
    }
  }
}

export default new QuestionsController();
